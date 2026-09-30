import { createClient, type Client, type InValue, type Row } from "@libsql/client";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    forward_token TEXT NOT NULL UNIQUE,
    alert_threshold_cents INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS login_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS mail_connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('gmail', 'outlook')),
    account_email TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    last_synced_at TEXT,
    UNIQUE (user_id, provider, account_email)
  )`,
  `CREATE TABLE IF NOT EXISTS processed_messages (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    message_id TEXT NOT NULL,
    PRIMARY KEY (user_id, source, message_id)
  )`,
  // Flight and hotel specifics live in the JSON `details` column (see FlightDetails / HotelDetails).
  `CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('flight', 'hotel')),
    confirmation_code TEXT NOT NULL,
    paid_cents INTEGER NOT NULL,
    currency TEXT NOT NULL,
    starts_on TEXT NOT NULL,
    details TEXT NOT NULL,
    source TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'departed')),
    last_checked_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, kind, confirmation_code)
  )`,
  `CREATE TABLE IF NOT EXISTS price_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    checked_at TEXT NOT NULL DEFAULT (datetime('now')),
    provider TEXT NOT NULL,
    price_cents INTEGER,
    currency TEXT,
    note TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    paid_cents INTEGER NOT NULL,
    found_cents INTEGER NOT NULL,
    currency TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_checks_booking ON price_checks(booking_id, checked_at)`,
  `CREATE INDEX IF NOT EXISTS idx_alerts_booking ON alerts(booking_id)`,
];

let client: Client | undefined;
let ready: Promise<void> | undefined;

/**
 * Turso (hosted libSQL) when DATABASE_URL is a libsql:// URL, otherwise a local SQLite file.
 */
function open(): Client {
  const url = config.databaseUrl;
  if (url.startsWith("file:")) {
    const file = url.slice("file:".length);
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }
  return createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN });
}

async function getClient(): Promise<Client> {
  client ??= open();
  ready ??= (async () => {
    await client!.execute("PRAGMA foreign_keys = ON");
    await client!.batch(SCHEMA, "write");
  })();
  await ready;
  return client;
}

export async function all(sql: string, args: InValue[] = []): Promise<Row[]> {
  return (await (await getClient()).execute({ sql, args })).rows;
}

export async function get(sql: string, args: InValue[] = []): Promise<Row | undefined> {
  return (await all(sql, args))[0];
}

export async function run(sql: string, args: InValue[] = []) {
  const result = await (await getClient()).execute({ sql, args });
  return { changes: result.rowsAffected, lastInsertRowid: Number(result.lastInsertRowid ?? 0) };
}

/** Tests only: forget the connection so the next call opens a fresh in-memory database. */
export function resetDbForTests() {
  client?.close();
  client = undefined;
  ready = undefined;
}
