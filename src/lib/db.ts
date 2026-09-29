import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  forward_token TEXT NOT NULL UNIQUE,
  alert_threshold_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS login_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mail_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('gmail', 'outlook')),
  account_email TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  last_synced_at TEXT,
  UNIQUE (user_id, provider, account_email)
);

CREATE TABLE IF NOT EXISTS processed_messages (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  message_id TEXT NOT NULL,
  PRIMARY KEY (user_id, source, message_id)
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  confirmation_code TEXT NOT NULL,
  airline TEXT,
  booking_site TEXT,
  passenger_count INTEGER NOT NULL,
  passenger_names TEXT NOT NULL,
  cabin TEXT NOT NULL,
  fare_brand TEXT,
  paid_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'departed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, confirmation_code)
);

CREATE TABLE IF NOT EXISTS segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  slice_index INTEGER NOT NULL,
  position INTEGER NOT NULL,
  carrier TEXT NOT NULL,
  flight_number TEXT NOT NULL,
  origin TEXT NOT NULL,
  destination TEXT NOT NULL,
  departure_local TEXT NOT NULL,
  arrival_local TEXT
);

CREATE TABLE IF NOT EXISTS price_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  provider TEXT NOT NULL,
  price_cents INTEGER,
  currency TEXT,
  note TEXT
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_cents INTEGER NOT NULL,
  found_cents INTEGER NOT NULL,
  currency TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_segments_booking ON segments(booking_id);
CREATE INDEX IF NOT EXISTS idx_checks_booking ON price_checks(booking_id, checked_at);
CREATE INDEX IF NOT EXISTS idx_alerts_booking ON alerts(booking_id);
`;

let db: DatabaseSync | undefined;

export function getDb(): DatabaseSync {
  if (db) return db;
  const file = config.databasePath;
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

/** Run `fn` inside a transaction, rolling back if it throws. */
export function transaction<T>(fn: () => T): T {
  const conn = getDb();
  conn.exec("BEGIN");
  try {
    const result = fn();
    conn.exec("COMMIT");
    return result;
  } catch (err) {
    conn.exec("ROLLBACK");
    throw err;
  }
}

/** Tests only: drop the in-memory database so each test starts clean. */
export function resetDbForTests() {
  db?.close();
  db = undefined;
}
