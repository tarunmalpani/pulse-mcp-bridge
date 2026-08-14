import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "data", "relay.db");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS device_state (
    device_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (device_id, kind)
  );

  CREATE TABLE IF NOT EXISTS dispatch_dedupe (
    hash TEXT PRIMARY KEY,
    last_dispatched_at INTEGER NOT NULL
  );
`);

/** Upserts the latest JSON blob for a given device + kind (status/logs/crashes/reports/session). */
export function putDeviceState(deviceId, kind, data) {
  db.prepare(
    `INSERT INTO device_state (device_id, kind, data, updated_at)
     VALUES (@deviceId, @kind, @data, @updatedAt)
     ON CONFLICT(device_id, kind) DO UPDATE SET data = @data, updated_at = @updatedAt`
  ).run({ deviceId, kind, data: JSON.stringify(data), updatedAt: new Date().toISOString() });
}

/** Reads the latest JSON blob for a device + kind, or null if nothing has been pushed yet. */
export function getDeviceState(deviceId, kind) {
  const row = db.prepare(`SELECT data FROM device_state WHERE device_id = ? AND kind = ?`).get(deviceId, kind);
  return row ? JSON.parse(row.data) : null;
}

/**
 * Returns true (and records the dispatch) if this hash hasn't fired within the
 * cooldown window; returns false if a dispatch for the same hash already fired
 * recently, so the caller should skip firing another one.
 */
export function shouldDispatch(hash, cooldownMs) {
  const now = Date.now();
  const row = db.prepare(`SELECT last_dispatched_at FROM dispatch_dedupe WHERE hash = ?`).get(hash);
  if (row && now - row.last_dispatched_at < cooldownMs) {
    return false;
  }
  db.prepare(
    `INSERT INTO dispatch_dedupe (hash, last_dispatched_at) VALUES (?, ?)
     ON CONFLICT(hash) DO UPDATE SET last_dispatched_at = ?`
  ).run(hash, now, now);
  return true;
}
