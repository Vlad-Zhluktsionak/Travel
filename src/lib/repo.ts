import crypto from "node:crypto";
import type { Row } from "@libsql/client";
import { all, get, run } from "./db";
import { config } from "./config";
import type { Alert, Booking, ParsedBooking, PriceCheck, User } from "./types";

const str = (v: unknown) => (v === null || v === undefined ? null : String(v));

// ---------- users ----------

function toUser(row: Row): User {
  return {
    id: Number(row.id),
    email: String(row.email),
    forwardToken: String(row.forward_token),
    alertThresholdCents: Number(row.alert_threshold_cents),
  };
}

export async function findUserById(id: number): Promise<User | null> {
  const row = await get("SELECT * FROM users WHERE id = ?", [id]);
  return row ? toUser(row) : null;
}

export async function findUserByEmail(email: string): Promise<User | null> {
  const row = await get("SELECT * FROM users WHERE email = ?", [email.trim().toLowerCase()]);
  return row ? toUser(row) : null;
}

export async function findUserByForwardToken(token: string): Promise<User | null> {
  const row = await get("SELECT * FROM users WHERE forward_token = ?", [token.toLowerCase()]);
  return row ? toUser(row) : null;
}

export async function findOrCreateUser(email: string): Promise<User> {
  const normalized = email.trim().toLowerCase();
  const existing = await findUserByEmail(normalized);
  if (existing) return existing;
  const token = crypto.randomBytes(5).toString("hex");
  await run("INSERT INTO users (email, forward_token, alert_threshold_cents) VALUES (?, ?, ?)", [
    normalized,
    token,
    config.defaultThresholdCents,
  ]);
  return (await findUserByEmail(normalized))!;
}

export async function updateThreshold(userId: number, cents: number) {
  await run("UPDATE users SET alert_threshold_cents = ? WHERE id = ?", [cents, userId]);
}

export function forwardingAddress(user: User): string {
  return `trips+${user.forwardToken}@${config.inboundDomain}`;
}

// ---------- login tokens ----------

const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

export async function createLoginToken(userId: number, ttlMinutes = 20): Promise<string> {
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
  await run("INSERT INTO login_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)", [hashToken(token), userId, expires]);
  return token;
}

/** Single-use: returns the user id and deletes the token, or null if invalid/expired. */
export async function consumeLoginToken(token: string): Promise<number | null> {
  const hash = hashToken(token);
  const row = await get("SELECT user_id, expires_at FROM login_tokens WHERE token_hash = ?", [hash]);
  if (!row) return null;
  await run("DELETE FROM login_tokens WHERE token_hash = ?", [hash]);
  if (new Date(String(row.expires_at)).getTime() < Date.now()) return null;
  return Number(row.user_id);
}

// ---------- mail connections ----------

export interface MailConnection {
  id: number;
  userId: number;
  provider: "gmail" | "outlook";
  accountEmail: string;
  refreshToken: string;
  lastSyncedAt: string | null;
}

function toConnection(row: Row): MailConnection {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    provider: row.provider as MailConnection["provider"],
    accountEmail: String(row.account_email),
    refreshToken: String(row.refresh_token),
    lastSyncedAt: str(row.last_synced_at),
  };
}

export async function saveConnection(userId: number, provider: MailConnection["provider"], accountEmail: string, refreshToken: string) {
  await run(
    `INSERT INTO mail_connections (user_id, provider, account_email, refresh_token) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, provider, account_email) DO UPDATE SET refresh_token = excluded.refresh_token`,
    [userId, provider, accountEmail, refreshToken],
  );
}

export async function listConnections(userId?: number): Promise<MailConnection[]> {
  const rows =
    userId === undefined
      ? await all("SELECT * FROM mail_connections")
      : await all("SELECT * FROM mail_connections WHERE user_id = ?", [userId]);
  return rows.map(toConnection);
}

export async function updateConnectionAfterSync(id: number, refreshToken: string) {
  await run("UPDATE mail_connections SET last_synced_at = datetime('now'), refresh_token = ? WHERE id = ?", [refreshToken, id]);
}

export async function deleteConnection(userId: number, id: number) {
  await run("DELETE FROM mail_connections WHERE id = ? AND user_id = ?", [id, userId]);
}

// ---------- processed messages (dedupe for mailbox sync / inbound) ----------

/** Returns true if the message was newly marked, false if it had already been processed. */
export async function markMessageProcessed(userId: number, source: string, messageId: string): Promise<boolean> {
  const result = await run("INSERT OR IGNORE INTO processed_messages (user_id, source, message_id) VALUES (?, ?, ?)", [
    userId,
    source,
    messageId,
  ]);
  return result.changes > 0;
}

/** Undo `markMessageProcessed` after a transient failure so the next attempt retries the message. */
export async function unmarkMessageProcessed(userId: number, source: string, messageId: string) {
  await run("DELETE FROM processed_messages WHERE user_id = ? AND source = ? AND message_id = ?", [userId, source, messageId]);
}

// ---------- bookings ----------

function toBooking(row: Row): Booking {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    kind: row.kind,
    confirmationCode: String(row.confirmation_code),
    paidCents: Number(row.paid_cents),
    currency: String(row.currency),
    details: JSON.parse(String(row.details)),
    source: String(row.source),
    status: row.status as Booking["status"],
    createdAt: String(row.created_at),
    lastCheckedAt: str(row.last_checked_at),
  } as Booking;
}

/** The date that ends tracking: first departure for flights, check-in for hotels. */
export function startsOn(b: ParsedBooking): string {
  return b.kind === "flight" ? b.details.slices[0][0].departureLocal.slice(0, 10) : b.details.checkIn;
}

export async function getBooking(id: number, userId?: number): Promise<Booking | null> {
  const row =
    userId === undefined
      ? await get("SELECT * FROM bookings WHERE id = ?", [id])
      : await get("SELECT * FROM bookings WHERE id = ? AND user_id = ?", [id, userId]);
  return row ? toBooking(row) : null;
}

export async function listBookings(userId: number): Promise<Booking[]> {
  return (await all("SELECT * FROM bookings WHERE user_id = ? ORDER BY starts_on", [userId])).map(toBooking);
}

export async function listActiveBookings(): Promise<Booking[]> {
  return (await all("SELECT * FROM bookings WHERE status = 'active' ORDER BY starts_on")).map(toBooking);
}

/**
 * Insert a booking, or update it in place when the same confirmation arrives again
 * (schedule change, rebooking at a lower price). Price history is preserved.
 */
export async function upsertBooking(userId: number, parsed: ParsedBooking, source: string): Promise<{ booking: Booking; created: boolean }> {
  const code = parsed.confirmationCode.toUpperCase();
  const existing = await get("SELECT id, details FROM bookings WHERE user_id = ? AND kind = ? AND confirmation_code = ?", [
    userId,
    parsed.kind,
    code,
  ]);
  const details = { ...parsed.details };
  if (existing && parsed.kind === "hotel") {
    // Keep the cached Google Hotels id so we don't spend an API search finding the hotel again.
    const previous = JSON.parse(String(existing.details)) as { propertyToken?: string | null };
    (details as { propertyToken?: string | null }).propertyToken ??= previous.propertyToken ?? null;
  }
  const values = [parsed.paidCents, parsed.currency.toUpperCase(), startsOn(parsed), JSON.stringify(details)];

  let id: number;
  if (existing) {
    id = Number(existing.id);
    await run(
      "UPDATE bookings SET paid_cents = ?, currency = ?, starts_on = ?, details = ?, status = 'active' WHERE id = ?",
      [...values, id],
    );
  } else {
    const result = await run(
      `INSERT INTO bookings (user_id, kind, confirmation_code, paid_cents, currency, starts_on, details, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, parsed.kind, code, ...values, source],
    );
    id = result.lastInsertRowid;
  }
  return { booking: (await getBooking(id))!, created: !existing };
}

export async function updateBookingDetails(id: number, details: Booking["details"]) {
  await run("UPDATE bookings SET details = ? WHERE id = ?", [JSON.stringify(details), id]);
}

export async function setBookingStatus(id: number, status: Booking["status"], userId?: number) {
  if (userId === undefined) await run("UPDATE bookings SET status = ? WHERE id = ?", [status, id]);
  else await run("UPDATE bookings SET status = ? WHERE id = ? AND user_id = ?", [status, id, userId]);
}

export async function deleteBooking(id: number, userId: number) {
  if (!(await getBooking(id, userId))) return;
  // Explicit child deletes: over Turso's HTTP protocol the foreign_keys pragma doesn't persist between requests.
  await run("DELETE FROM price_checks WHERE booking_id = ?", [id]);
  await run("DELETE FROM alerts WHERE booking_id = ?", [id]);
  await run("DELETE FROM bookings WHERE id = ? AND user_id = ?", [id, userId]);
}

// ---------- price checks & alerts ----------

function toCheck(row: Row): PriceCheck {
  return {
    id: Number(row.id),
    bookingId: Number(row.booking_id),
    checkedAt: String(row.checked_at),
    provider: String(row.provider),
    priceCents: row.price_cents === null ? null : Number(row.price_cents),
    currency: str(row.currency),
    note: str(row.note),
  };
}

export async function recordPriceCheck(
  bookingId: number,
  provider: string,
  priceCents: number | null,
  currency: string | null,
  note: string | null,
): Promise<PriceCheck> {
  const result = await run("INSERT INTO price_checks (booking_id, provider, price_cents, currency, note) VALUES (?, ?, ?, ?, ?)", [
    bookingId,
    provider,
    priceCents,
    currency,
    note,
  ]);
  await run("UPDATE bookings SET last_checked_at = datetime('now') WHERE id = ?", [bookingId]);
  return toCheck((await get("SELECT * FROM price_checks WHERE id = ?", [result.lastInsertRowid]))!);
}

export async function listPriceChecks(bookingId: number, limit = 200): Promise<PriceCheck[]> {
  const rows = await all(
    "SELECT * FROM (SELECT * FROM price_checks WHERE booking_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id",
    [bookingId, limit],
  );
  return rows.map(toCheck);
}

export async function latestPriceCheck(bookingId: number): Promise<PriceCheck | null> {
  const row = await get(
    "SELECT * FROM price_checks WHERE booking_id = ? AND price_cents IS NOT NULL ORDER BY id DESC LIMIT 1",
    [bookingId],
  );
  return row ? toCheck(row) : null;
}

function toAlert(row: Row): Alert {
  return {
    id: Number(row.id),
    bookingId: Number(row.booking_id),
    createdAt: String(row.created_at),
    paidCents: Number(row.paid_cents),
    foundCents: Number(row.found_cents),
    currency: String(row.currency),
  };
}

export async function createAlert(bookingId: number, paidCents: number, foundCents: number, currency: string): Promise<Alert> {
  const result = await run("INSERT INTO alerts (booking_id, paid_cents, found_cents, currency) VALUES (?, ?, ?, ?)", [
    bookingId,
    paidCents,
    foundCents,
    currency,
  ]);
  return toAlert((await get("SELECT * FROM alerts WHERE id = ?", [result.lastInsertRowid]))!);
}

export async function listAlerts(bookingId: number): Promise<Alert[]> {
  return (await all("SELECT * FROM alerts WHERE booking_id = ? ORDER BY id DESC", [bookingId])).map(toAlert);
}

/** Lowest price we've already alerted on at the current paid price, so we only re-alert on a further drop. */
export async function lowestAlertedCents(bookingId: number, paidCents: number): Promise<number | null> {
  const row = await get("SELECT MIN(found_cents) AS m FROM alerts WHERE booking_id = ? AND paid_cents = ?", [bookingId, paidCents]);
  return row?.m === null || row?.m === undefined ? null : Number(row.m);
}
