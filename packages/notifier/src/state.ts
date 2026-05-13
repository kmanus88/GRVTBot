// Cursor state persisted to disk so the notifier can survive restarts
// without re-sending the entire history. Tiny JSON file — no SQLite needed
// for ~5 fields. State directory must be writable by the notifier user.

import fs from 'node:fs';
import path from 'node:path';
import { childLogger } from './logger.js';

const log = childLogger('state');

export interface NotifierState {
  // Last paired_roundtrips.id we've notified about per user. Stored as
  // a map so each owner advances independently and a user with few
  // fills doesn't block batches for a user with many.
  lastRoundtripIdByUser: Record<string, number>;
  // Last bot status we observed per bot id, to detect transitions.
  lastBotStatus: Record<string, string>;
  // High water mark for equity per user (drawdown is computed per
  // owner — global aggregation would alert the operator about another
  // user's drawdown).
  equityHwmByUser: Record<string, number>;
  // Last day we sent a summary (YYYY-MM-DD UTC), to avoid double-sends.
  lastSummaryDate: string | null;
  // Last error we surfaced, to avoid spamming on the same one. Keyed
  // per user so cross-tenant alerts don't suppress each other.
  lastErrorHashByUser: Record<string, string | null>;
  // Legacy fields kept for one-shot migration from single-tenant state
  // files. Loaders fold these into the per-user maps under user "1"
  // and then ignore them on subsequent runs.
  lastRoundtripId?: number;
  equityHwm?: number;
  lastErrorHash?: string | null;
}

// F.6: alert history entry. Append-only log stored in alert-history.json
// alongside cursor.json. The bot API reads this file to show alert
// history in the dashboard — and FILTERS by userId so user A never
// sees user B's drawdown/fill/status alerts.
export interface AlertHistoryEntry {
  ts: number;
  type: string;
  // Owner of the alert. Required for multi-tenant filtering on the bot
  // API. Legacy rows written before the multi-tenant security fix may
  // be missing this — the bot API treats them as user 1 (the operator).
  userId?: number;
  botId?: number;
  pair?: string;
  message: string;
  data?: Record<string, unknown>;
}


export class StateStore {
  private readonly filePath: string;
  private readonly alertHistoryPath: string;
  private state: NotifierState;

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, 'cursor.json');
    this.alertHistoryPath = path.join(stateDir, 'alert-history.json');
    this.state = this.load();
  }

  private load(): NotifierState {
    try {
      if (!fs.existsSync(this.filePath)) {
        // Ensure the dir exists; the systemd unit also handles this via
        // StateDirectory= but be defensive when running locally.
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        return this.freshState();
      }
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<NotifierState>;
      return this.migrate(parsed);
    } catch (err) {
      log.error({ err: (err as Error).message }, 'failed to load state, starting fresh');
      return this.freshState();
    }
  }

  private freshState(): NotifierState {
    return {
      lastRoundtripIdByUser: {},
      lastBotStatus: {},
      equityHwmByUser: {},
      lastSummaryDate: null,
      lastErrorHashByUser: {},
    };
  }

  /**
   * One-shot migration from the legacy single-tenant fields
   * (lastRoundtripId, equityHwm, lastErrorHash) into the per-user maps.
   * Anything that lacks a per-user partition lands under user "1" — the
   * operator — matching the bot router's COALESCE(user_id, 1) policy.
   */
  private migrate(parsed: Partial<NotifierState>): NotifierState {
    const state = this.freshState();
    if (parsed.lastBotStatus) state.lastBotStatus = parsed.lastBotStatus;
    if (parsed.lastSummaryDate) state.lastSummaryDate = parsed.lastSummaryDate;
    if (parsed.lastRoundtripIdByUser) {
      state.lastRoundtripIdByUser = parsed.lastRoundtripIdByUser;
    } else if (typeof parsed.lastRoundtripId === 'number') {
      state.lastRoundtripIdByUser['1'] = parsed.lastRoundtripId;
    }
    if (parsed.equityHwmByUser) {
      state.equityHwmByUser = parsed.equityHwmByUser;
    } else if (typeof parsed.equityHwm === 'number') {
      state.equityHwmByUser['1'] = parsed.equityHwm;
    }
    if (parsed.lastErrorHashByUser) {
      state.lastErrorHashByUser = parsed.lastErrorHashByUser;
    } else if (typeof parsed.lastErrorHash === 'string') {
      state.lastErrorHashByUser['1'] = parsed.lastErrorHash;
    }
    return state;
  }

  get(): Readonly<NotifierState> {
    return this.state;
  }

  /**
   * Update fields and persist atomically (write tmp + rename).
   */
  update(patch: Partial<NotifierState>): void {
    this.state = { ...this.state, ...patch };
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  /**
   * F.6: Append an alert to the history log. The file is a JSON array
   * capped at 500 entries (oldest pruned on write). The bot API reads
   * this file to show alert history in the dashboard.
   */
  appendAlert(entry: AlertHistoryEntry): void {
    try {
      let history: AlertHistoryEntry[] = [];
      if (fs.existsSync(this.alertHistoryPath)) {
        const raw = fs.readFileSync(this.alertHistoryPath, 'utf8');
        history = JSON.parse(raw);
      }
      history.push(entry);
      // Cap at 500 entries
      if (history.length > 500) {
        history = history.slice(history.length - 500);
      }
      const tmp = `${this.alertHistoryPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(history));
      fs.renameSync(tmp, this.alertHistoryPath);
    } catch (err) {
      log.error({ err: (err as Error).message }, 'failed to append alert history');
    }
  }

  /**
   * F.6: Read alert history (used by the bot API endpoint).
   */
  getAlertHistory(): AlertHistoryEntry[] {
    try {
      if (!fs.existsSync(this.alertHistoryPath)) return [];
      const raw = fs.readFileSync(this.alertHistoryPath, 'utf8');
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }
}
