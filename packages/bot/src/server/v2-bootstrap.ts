// V2 bootstrap — single entry point that wires the new server pieces (WS,
// dispatcher, v2 router) into an existing Express app + HTTP server.
//
// The legacy `src/dashboard/server.ts` calls this once at startup, passing
// in the things it already has (express app, http server, sqlite db,
// grvt client, grid engine). All the new functionality is added without
// touching the legacy code paths.
//
// To opt out (for tests, or if the v2 surface should be disabled): just
// don't call mountV2().

import type { Router } from 'express';
import type { Server as HttpServer } from 'node:http';
import type { EventEmitter } from 'node:events';
import type Database from 'sqlite3';

import { GrvtWebSocketServer } from './ws-server.js';
import { WsDispatcher } from './ws-dispatcher.js';
import { createV2Router } from './v2-router.js';
import { childLogger } from './logger.js';
import type { GridBotDB } from '../database/db.js';
import { verifyToken } from '../auth/jwt.js';

const log = childLogger('v2-bootstrap');

interface GrvtClient {
  getInstruments(): Promise<unknown[]>;
  getBalance(): Promise<unknown>;
  getTicker(instrument: string): Promise<unknown>;
  getPosition(instrument: string): Promise<unknown>;
  getOpenOrders(instrument?: string): Promise<unknown[]>;
  getKlines(instrument: string, interval?: string, limit?: number): Promise<unknown[]>;
  getFillHistory(limit: number, instrument?: string, endTimeNs?: string): Promise<Array<{
    event_time?: string;
    is_buyer?: boolean | number;
    price?: string;
    size?: string;
    fee?: string;
  }>>;
}

// Structural type for the engine ops the router needs (mutations).
// Same shape as the one in v2-router.ts EngineOps.
interface EngineOps {
  createBot(config: {
    pair: string;
    direction: 'long' | 'short';
    leverage: number;
    lowerPrice: number;
    upperPrice: number;
    numGrids: number;
    investmentUSDT: number;
    virtualEnabled?: boolean;
    activeWindowSize?: number;
  }): Promise<number>;
  startBot(botId: number): Promise<void>;
  pauseBot(botId: number): Promise<void>;
  closeBot(botId: number): Promise<void>;
  updateBotRange(botId: number, lowerPrice: number, upperPrice: number): Promise<void>;
  previewBotRangeUpdate(botId: number, lowerPrice: number, upperPrice: number): Promise<unknown>;
}

export interface MountV2Options {
  /**
   * Receives the constructed v2 REST router. The legacy server.ts uses this
   * callback to register the router into a placeholder middleware that's
   * already in the express stack at module-load time, BEFORE the catch-all
   * 404 handler. Returning a router instead of mounting it ourselves keeps
   * us out of the request-order trap.
   */
  setRouter: (router: Router) => void;
  httpServer: HttpServer;
  db: Database.Database;
  // Higher-level wrapper around the same db. Exposes per-user CRUD
  // (createUser, upsertGrvtCredentials, getBotsForUser, etc) that
  // the multi-tenant auth endpoints depend on. Required.
  gridBotDb: GridBotDB;
  grvtClient: GrvtClient;
  // The full engine — used as an EventEmitter for the dispatcher AND as
  // the source of mutation ops (createBot/startBot/pauseBot) for the
  // router. We accept it as `EventEmitter & EngineOps` so callers can
  // pass `gridEngine` directly without casts.
  engine: EventEmitter & EngineOps;
  apiKey: string;
}

export interface V2Handles {
  wsServer: GrvtWebSocketServer;
  dispatcher: WsDispatcher;
  shutdown: () => Promise<void>;
}

export function mountV2(opts: MountV2Options): V2Handles {
  // Build the v2 REST router and hand it to the host app via the callback.
  // We don't call app.use() ourselves because by the time mountV2() runs
  // (in startServer, after initializeServices), the legacy 404 handler is
  // already in the middleware stack. The placeholder pattern in server.ts
  // is what makes this work.
  const router = createV2Router({
    db: opts.db,
    gridBotDb: opts.gridBotDb,
    grvtClient: opts.grvtClient,
    engineOps: opts.engine,
    apiKey: opts.apiKey
  });
  opts.setRouter(router);
  log.info('built v2 REST router and registered via placeholder');

  // Mount the WebSocket server on the same HTTP server.
  // JWT-authed clients get per-bot ownership checks at subscribe time;
  // legacy api_key clients (operator/scripts) bypass the check.
  const db = opts.db;
  const wsServer = new GrvtWebSocketServer(opts.httpServer, {
    apiKey: opts.apiKey,
    verifyToken,
    authorizeChannel: async (userId, channel) => {
      // Only `bot:<id>` channels are user-scoped. Other channels
      // (`prices`, `notifications`, `system`) are broadcast feeds.
      const m = /^bot:(\d+)$/.exec(channel);
      if (!m) return true;
      const botId = parseInt(m[1]!, 10);
      const row = await new Promise<{ user_id: number | null } | undefined>((resolve) => {
        db.get(
          `SELECT user_id FROM grid_bots WHERE id = ?`,
          [botId],
          (err: Error | null, row: { user_id: number | null } | undefined) => {
            if (err) {
              log.warn({ err, botId, userId }, 'ws authorizeChannel: db error');
              resolve(undefined);
              return;
            }
            resolve(row);
          }
        );
      });
      if (!row) return false;
      // Legacy NULL user_id rows are owned by user 1 (mirrors router policy).
      const ownerId = row.user_id ?? 1;
      return ownerId === userId;
    },
  });

  // Wire the engine events + DB polling to the bus
  const dispatcher = new WsDispatcher({
    engine: opts.engine,
    db: opts.db
  });
  dispatcher.start();

  log.info('v2 server fully mounted (REST + WebSocket + dispatcher)');

  return {
    wsServer,
    dispatcher,
    shutdown: async () => {
      log.info('v2 shutdown starting');
      dispatcher.stop();
      await wsServer.close();
      log.info('v2 shutdown complete');
    }
  };
}
