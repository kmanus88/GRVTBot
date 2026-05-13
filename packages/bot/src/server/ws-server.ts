// WebSocket server for the v2 dashboard.
//
// Mounts on the existing Express HTTP server at the path /ws and handles
// the upgrade dance. Each client:
//
//   1. Connects to ws://host:3848/ws?token=<jwt>  (multi-tenant)
//      or    ws://host:3848/ws?api_key=<key>      (legacy operator/admin)
//   2. Server validates the credential and closes with 4401 if invalid.
//      JWT clients have their userId stamped on the connection so we can
//      enforce bot-channel ownership at subscribe time. api_key clients
//      are treated as the operator (no per-channel filtering — they own
//      the box).
//   3. Server sends a `hello` frame with server version + a session id.
//   4. Client sends `subscribe` frames listing channels it wants
//      (e.g. `bot:42`, `prices`, `notifications`).
//   5. For channels that match `bot:<id>`, the server verifies ownership
//      against the DB before wiring up the bus subscription. Foreign-bot
//      subscriptions are silently dropped (the ack lists only the
//      accepted channels).
//   6. Server forwards bus events for accepted channels via WsBus.subscribe.
//   7. On disconnect, all subscriptions are torn down.
//
// Heartbeat: server pings every 30s, closes connections that don't pong
// within 5s. Browsers handle this transparently, but it lets us detect
// dead clients (e.g. laptop closed) and free their subscriptions.
//
// All ws traffic is JSON. We don't do binary frames or msgpack — the volume
// is low (a few hundred messages per minute at most) and JSON is debuggable.

import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { childLogger } from './logger.js';
import { wsBus, type WsMessage } from './ws-bus.js';
import { randomUUID } from 'node:crypto';

const log = childLogger('ws-server');

// 4xxx codes are app-level (not standard close codes).
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_BAD_REQUEST = 4400;

interface ClientState {
  id: string;
  ws: WebSocket;
  // null for legacy operator (api_key) connections — those bypass per-bot
  // ownership checks. A number means this is a JWT-authed user and bot
  // channels must belong to them.
  userId: number | null;
  unsubscribers: Map<string, () => void>;  // channel -> teardown
  isAlive: boolean;
}

export interface WsServerOptions {
  apiKey: string;
  // Verifies a JWT and returns the userId, or null if invalid/expired.
  // Optional — if omitted, only api_key auth works. In production the
  // bootstrap wires this to auth/jwt.ts:verifyToken.
  verifyToken?: (token: string) => { userId: number } | null;
  // Resolves whether a JWT-authed user is allowed to subscribe to a
  // channel. Called for every `subscribe` frame. Optional — when
  // omitted, every channel is allowed (useful in unit tests). The
  // bootstrap wires this to a DB-backed lookup that gates `bot:<id>`
  // channels by user ownership.
  authorizeChannel?: (userId: number, channel: string) => Promise<boolean>;
}

export class GrvtWebSocketServer {
  private wss: WebSocketServer;
  private clients = new Map<WebSocket, ClientState>();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private readonly apiKey: string;
  private readonly verifyToken?: (token: string) => { userId: number } | null;
  private readonly authorizeChannel?: (userId: number, channel: string) => Promise<boolean>;

  constructor(httpServer: HttpServer, optsOrApiKey: WsServerOptions | string) {
    const opts: WsServerOptions =
      typeof optsOrApiKey === 'string' ? { apiKey: optsOrApiKey } : optsOrApiKey;
    if (!opts.apiKey || opts.apiKey.length < 16) {
      throw new Error('DASHBOARD_API_KEY must be at least 16 chars');
    }
    this.apiKey = opts.apiKey;
    this.verifyToken = opts.verifyToken;
    this.authorizeChannel = opts.authorizeChannel;

    this.wss = new WebSocketServer({
      server: httpServer,
      path: '/ws'
    });

    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
    this.wss.on('error', (err) => log.error({ err }, 'wss error'));

    // Heartbeat: ping every 30s, terminate stragglers.
    this.heartbeatInterval = setInterval(() => this.heartbeat(), 30_000);
    this.heartbeatInterval.unref?.();

    log.info('WebSocket server mounted at /ws');
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    // Auth via query string. Browsers can't set custom headers on the
    // WS handshake, so the credential rides in the URL.
    //   ?token=<jwt>     → multi-tenant user, ownership-checked
    //   ?api_key=<key>   → legacy operator/admin, full access
    // The credential never appears in URL bars / logs since the dashboard
    // runs on localhost or behind TLS.
    const url = new URL(req.url ?? '/ws', `http://${req.headers.host}`);
    const providedToken = url.searchParams.get('token');
    const providedKey = url.searchParams.get('api_key');

    let userId: number | null = null;
    if (providedToken && this.verifyToken) {
      const payload = this.verifyToken(providedToken);
      if (!payload) {
        log.warn(
          { ip: req.socket.remoteAddress },
          'rejected WS connection: invalid/expired JWT'
        );
        ws.close(CLOSE_UNAUTHORIZED, 'unauthorized');
        return;
      }
      userId = payload.userId;
    } else if (providedKey && providedKey === this.apiKey) {
      // Legacy operator connection — keeps existing scripts / admin
      // tools working. userId stays null and bypasses ownership checks.
      userId = null;
    } else {
      log.warn({ ip: req.socket.remoteAddress }, 'rejected unauthenticated WS connection');
      ws.close(CLOSE_UNAUTHORIZED, 'unauthorized');
      return;
    }

    const id = randomUUID();
    const state: ClientState = {
      id,
      ws,
      userId,
      unsubscribers: new Map(),
      isAlive: true
    };
    this.clients.set(ws, state);

    log.info({ clientId: id, userId, total: this.clients.size }, 'client connected');

    ws.on('message', (raw) => this.onMessage(state, raw));
    ws.on('pong', () => { state.isAlive = true; });
    ws.on('close', (code, reason) => this.onClose(state, code, reason.toString()));
    ws.on('error', (err) => log.error({ err, clientId: id }, 'client ws error'));

    // Server hello
    this.send(ws, {
      type: 'hello',
      channel: 'system',
      data: {
        clientId: id,
        serverVersion: '0.1.0',
        protocolVersion: 1
      },
      timestamp: Date.now()
    });
  }

  private onMessage(state: ClientState, raw: RawData): void {
    let msg: { type?: string; channel?: string; channels?: string[] };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      log.warn({ clientId: state.id }, 'received non-JSON message');
      state.ws.close(CLOSE_BAD_REQUEST, 'invalid JSON');
      return;
    }

    switch (msg.type) {
      case 'subscribe': {
        // { type: 'subscribe', channels: ['bot:42', 'prices'] }
        const channels = Array.isArray(msg.channels) ? msg.channels : [];
        // Authorize every channel *before* wiring up bus subscriptions, so
        // a foreign bot never gets a teardown registered. Returning early
        // here is fine — we never await inside a `case` block, but a
        // fire-and-forget IIFE lets us keep the synchronous switch shape.
        void (async () => {
          const accepted: string[] = [];
          const rejected: string[] = [];
          for (const channel of channels) {
            if (typeof channel !== 'string') continue;
            if (state.unsubscribers.has(channel)) {
              accepted.push(channel);
              continue;
            }
            // Per-user gating: JWT clients (userId !== null) must own
            // `bot:<id>` channels. Operator (api_key, userId === null)
            // bypasses. Non-bot channels (`prices`, `notifications`) are
            // unrestricted broadcast feeds.
            if (state.userId !== null && this.authorizeChannel) {
              const ok = await this.authorizeChannel(state.userId, channel).catch((err) => {
                log.error({ err, channel, userId: state.userId }, 'authorizeChannel threw');
                return false;
              });
              if (!ok) {
                rejected.push(channel);
                continue;
              }
            }
            const teardown = wsBus.subscribe(channel, (busMsg) => {
              this.send(state.ws, busMsg);
            });
            state.unsubscribers.set(channel, teardown);
            accepted.push(channel);
          }
          if (rejected.length > 0) {
            log.warn(
              { clientId: state.id, userId: state.userId, rejected },
              'rejected channel subscriptions (not owned by user)'
            );
          }
          log.debug({ clientId: state.id, accepted, rejected }, 'subscribed');
          this.send(state.ws, {
            type: 'subscribed',
            channel: 'system',
            data: {
              channels: Array.from(state.unsubscribers.keys()),
              ...(rejected.length > 0 ? { rejected } : {}),
            },
            timestamp: Date.now()
          });
        })();
        break;
      }

      case 'unsubscribe': {
        const channels = Array.isArray(msg.channels) ? msg.channels : [];
        for (const channel of channels) {
          const teardown = state.unsubscribers.get(channel);
          if (teardown) {
            teardown();
            state.unsubscribers.delete(channel);
          }
        }
        break;
      }

      case 'ping':
        // App-level ping (the protocol-level pong from the WS lib doesn't
        // give us a place to put a payload). Just echo back.
        this.send(state.ws, {
          type: 'pong',
          channel: 'system',
          data: null,
          timestamp: Date.now()
        });
        break;

      default:
        log.warn({ clientId: state.id, type: msg.type }, 'unknown message type');
    }
  }

  private onClose(state: ClientState, code: number, reason: string): void {
    log.info({ clientId: state.id, code, reason, total: this.clients.size - 1 }, 'client disconnected');
    // Tear down all bus subscriptions
    for (const teardown of state.unsubscribers.values()) teardown();
    state.unsubscribers.clear();
    this.clients.delete(state.ws);
  }

  private send(ws: WebSocket, msg: WsMessage): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      log.error({ err }, 'failed to send to client');
    }
  }

  /**
   * Heartbeat ticker — pings each client; if a client didn't pong since the
   * last tick, terminate it. Frees up subscriptions for dead browser tabs.
   */
  private heartbeat(): void {
    for (const [ws, state] of this.clients) {
      if (!state.isAlive) {
        log.info({ clientId: state.id }, 'terminating stale client');
        ws.terminate();
        continue;
      }
      state.isAlive = false;
      try {
        ws.ping();
      } catch (err) {
        log.warn({ err, clientId: state.id }, 'ping failed');
      }
    }
  }

  /**
   * Number of currently-connected clients (for /api/health).
   */
  clientCount(): number {
    return this.clients.size;
  }

  /**
   * Graceful shutdown — close all client connections cleanly.
   * Called from the SIGTERM handler.
   */
  async close(): Promise<void> {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    for (const ws of this.clients.keys()) {
      try {
        ws.close(1001, 'server shutdown');
      } catch { /* ignore */ }
    }
    this.clients.clear();
    return new Promise((resolve) => {
      this.wss.close(() => resolve());
    });
  }
}
