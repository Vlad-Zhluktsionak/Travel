import crypto from "node:crypto";
import { getDb, transaction } from "./db";
import { config } from "./config";
import type { Alert, Booking, Cabin, ParsedBooking, PriceCheck, Segment, User } from "./types";

type Row = Record<string, unknown>;

// ---------- users ----------

function toUser(row: Row): User {
  return {
    id: Number(row.id),
    email: String(row.email),
    forwardToken: String(row.forward_token),
    alertThresholdCents: Number(row.alert_threshold_cents),
  };
}

export function findUserById(id: number): User | null {
  const row = getDb().prepare("SELECT * FROM users WHERE id = ?").get(id);
  return row ? toUser(row) : null;
}

export function findUserByEmail(email: string): User | null {
  const row = getDb().prepare("SELECT * FROM users WHERE email = ?").get(email.trim().toLowerCase());
  return row ? toUser(row) : null;
}

export function findUserByForwardToken(token: string): User | null {
  const row = getDb().prepare("SELECT * FROM users WHERE forward_token = ?").get(token.toLowerCase());
  return row ? toUser(row) : null;
}

export function findOrCreateUser(email: string): User {
  const normalized = email.trim().toLowerCase();
  const existing = findUserByEmail(normalized);
  if (existing) return existing;
  const token = crypto.randomBytes(5).toString("hex");
  getDb()
    .prepare("INSERT INTO users (email, forward_token, alert_threshold_cents) VALUES (?, ?, ?)")
    .run(normalized, token, config.defaultThresholdCents);
  return findUserByEmail(normalized)!;
}

export function updateThreshold(userId: number, cents: number) {
  getDb().prepare("UPDATE users SET alert_threshold_cents = ? WHERE id = ?").run(cents, userId);
}

export function forwardingAddress(user: User): string {
  return `trips+${user.forwardToken}@${config.inboundDomain}`;
}

// ---------- login tokens ----------

const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

export function createLoginToken(userId: number, ttlMinutes = 20): string {
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
  getDb()
    .prepare("INSERT INTO login_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(hashToken(token), userId, expires);
  return token;
}

/** Single-use: returns the user id and deletes the token, or null if invalid/expired. */
export function consumeLoginToken(token: string): number | null {
  const db = getDb();
  const hash = hashToken(token);
  const row = db.prepare("SELECT user_id, expires_at FROM login_tokens WHERE token_hash = ?").get(hash);
  if (!row) return null;
  db.prepare("DELETE FROM login_tokens WHERE token_hash = ?").run(hash);
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
    lastSyncedAt: (row.last_synced_at as string | null) ?? null,
  };
}

export function saveConnection(userId: number, provider: MailConnection["provider"], accountEmail: string, refreshToken: string) {
  getDb()
    .prepare(
      `INSERT INTO mail_connections (user_id, provider, account_email, refresh_token) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, provider, account_email) DO UPDATE SET refresh_token = excluded.refresh_token`,
    )
    .run(userId, provider, accountEmail, refreshToken);
}

export function listConnections(userId?: number): MailConnection[] {
  const rows =
    userId === undefined
      ? getDb().prepare("SELECT * FROM mail_connections").all()
      : getDb().prepare("SELECT * FROM mail_connections WHERE user_id = ?").all(userId);
  return rows.map(toConnection);
}

export function updateConnectionAfterSync(id: number, refreshToken: string) {
  getDb()
    .prepare("UPDATE mail_connections SET last_synced_at = datetime('now'), refresh_token = ? WHERE id = ?")
    .run(refreshToken, id);
}

export function deleteConnection(userId: number, id: number) {
  getDb().prepare("DELETE FROM mail_connections WHERE id = ? AND user_id = ?").run(id, userId);
}

// ---------- processed messages (dedupe for mailbox sync / inbound) ----------

/** Returns true if the message was newly marked, false if it had already been processed. */
export function markMessageProcessed(userId: number, source: string, messageId: string): boolean {
  const result = getDb()
    .prepare("INSERT OR IGNORE INTO processed_messages (user_id, source, message_id) VALUES (?, ?, ?)")
    .run(userId, source, messageId);
  return Number(result.changes) > 0;
}

/** Undo `markMessageProcessed` after a transient failure so the next sync retries the message. */
export function unmarkMessageProcessed(userId: number, source: string, messageId: string) {
  getDb()
    .prepare("DELETE FROM processed_messages WHERE user_id = ? AND source = ? AND message_id = ?")
    .run(userId, source, messageId);
}

// ---------- bookings ----------

function toSegment(row: Row): Segment {
  return {
    carrier: String(row.carrier),
    flightNumber: String(row.flight_number),
    origin: String(row.origin),
    destination: String(row.destination),
    departureLocal: String(row.departure_local),
    arrivalLocal: (row.arrival_local as string | null) ?? null,
  };
}

function loadSlices(bookingId: number): Segment[][] {
  const rows = getDb()
    .prepare("SELECT * FROM segments WHERE booking_id = ? ORDER BY slice_index, position")
    .all(bookingId);
  const slices: Segment[][] = [];
  for (const row of rows) {
    const idx = Number(row.slice_index);
    (slices[idx] ??= []).push(toSegment(row));
  }
  return slices.filter(Boolean);
}

function toBooking(row: Row): Booking {
  const id = Number(row.id);
  return {
    id,
    userId: Number(row.user_id),
    confirmationCode: String(row.confirmation_code),
    airline: (row.airline as string | null) ?? null,
    bookingSite: (row.booking_site as string | null) ?? null,
    passengerCount: Number(row.passenger_count),
    passengerNames: JSON.parse(String(row.passenger_names)) as string[],
    cabin: row.cabin as Cabin,
    fareBrand: (row.fare_brand as string | null) ?? null,
    paidCents: Number(row.paid_cents),
    currency: String(row.currency),
    source: String(row.source),
    status: row.status as Booking["status"],
    createdAt: String(row.created_at),
    slices: loadSlices(id),
  };
}

export function getBooking(id: number, userId?: number): Booking | null {
  const row =
    userId === undefined
      ? getDb().prepare("SELECT * FROM bookings WHERE id = ?").get(id)
      : getDb().prepare("SELECT * FROM bookings WHERE id = ? AND user_id = ?").get(id, userId);
  return row ? toBooking(row) : null;
}

export function listBookings(userId: number): Booking[] {
  return getDb()
    .prepare("SELECT * FROM bookings WHERE user_id = ? ORDER BY created_at DESC")
    .all(userId)
    .map(toBooking);
}

export function listActiveBookings(): Booking[] {
  return getDb().prepare("SELECT * FROM bookings WHERE status = 'active'").all().map(toBooking);
}

/**
 * Insert a booking, or update it in place when the same confirmation code arrives again
 * (schedule change, rebooking at a lower fare). Price history is preserved.
 */
export function upsertBooking(userId: number, parsed: ParsedBooking, source: string): { booking: Booking; created: boolean } {
  return transaction(() => {
    const db = getDb();
    const code = parsed.confirmationCode.toUpperCase();
    const existing = db
      .prepare("SELECT id FROM bookings WHERE user_id = ? AND confirmation_code = ?")
      .get(userId, code);

    let bookingId: number;
    const values = [
      parsed.airline,
      parsed.bookingSite,
      parsed.passengerCount,
      JSON.stringify(parsed.passengerNames),
      parsed.cabin,
      parsed.fareBrand,
      parsed.paidCents,
      parsed.currency.toUpperCase(),
    ] as const;

    if (existing) {
      bookingId = Number(existing.id);
      db.prepare(
        `UPDATE bookings SET airline = ?, booking_site = ?, passenger_count = ?, passenger_names = ?, cabin = ?,
           fare_brand = ?, paid_cents = ?, currency = ?, status = 'active' WHERE id = ?`,
      ).run(...values, bookingId);
      db.prepare("DELETE FROM segments WHERE booking_id = ?").run(bookingId);
    } else {
      const result = db
        .prepare(
          `INSERT INTO bookings (user_id, confirmation_code, airline, booking_site, passenger_count, passenger_names,
             cabin, fare_brand, paid_cents, currency, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(userId, code, ...values, source);
      bookingId = Number(result.lastInsertRowid);
    }

    const insertSegment = db.prepare(
      `INSERT INTO segments (booking_id, slice_index, position, carrier, flight_number, origin, destination,
         departure_local, arrival_local) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    parsed.slices.forEach((slice, sliceIndex) =>
      slice.forEach((seg, position) =>
        insertSegment.run(
          bookingId,
          sliceIndex,
          position,
          seg.carrier.toUpperCase(),
          seg.flightNumber,
          seg.origin.toUpperCase(),
          seg.destination.toUpperCase(),
          seg.departureLocal,
          seg.arrivalLocal,
        ),
      ),
    );

    return { booking: getBooking(bookingId)!, created: !existing };
  });
}

export function setBookingStatus(id: number, status: Booking["status"], userId?: number) {
  if (userId === undefined) {
    getDb().prepare("UPDATE bookings SET status = ? WHERE id = ?").run(status, id);
  } else {
    getDb().prepare("UPDATE bookings SET status = ? WHERE id = ? AND user_id = ?").run(status, id, userId);
  }
}

export function deleteBooking(id: number, userId: number) {
  getDb().prepare("DELETE FROM bookings WHERE id = ? AND user_id = ?").run(id, userId);
}

// ---------- price checks & alerts ----------

function toCheck(row: Row): PriceCheck {
  return {
    id: Number(row.id),
    bookingId: Number(row.booking_id),
    checkedAt: String(row.checked_at),
    provider: String(row.provider),
    priceCents: row.price_cents === null ? null : Number(row.price_cents),
    currency: (row.currency as string | null) ?? null,
    note: (row.note as string | null) ?? null,
  };
}

export function recordPriceCheck(
  bookingId: number,
  provider: string,
  priceCents: number | null,
  currency: string | null,
  note: string | null,
): PriceCheck {
  const result = getDb()
    .prepare("INSERT INTO price_checks (booking_id, provider, price_cents, currency, note) VALUES (?, ?, ?, ?, ?)")
    .run(bookingId, provider, priceCents, currency, note);
  return toCheck(getDb().prepare("SELECT * FROM price_checks WHERE id = ?").get(result.lastInsertRowid)!);
}

export function listPriceChecks(bookingId: number, limit = 200): PriceCheck[] {
  return getDb()
    .prepare("SELECT * FROM (SELECT * FROM price_checks WHERE booking_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id")
    .all(bookingId, limit)
    .map(toCheck);
}

export function latestPriceCheck(bookingId: number): PriceCheck | null {
  const row = getDb()
    .prepare("SELECT * FROM price_checks WHERE booking_id = ? AND price_cents IS NOT NULL ORDER BY id DESC LIMIT 1")
    .get(bookingId);
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

export function createAlert(bookingId: number, paidCents: number, foundCents: number, currency: string): Alert {
  const result = getDb()
    .prepare("INSERT INTO alerts (booking_id, paid_cents, found_cents, currency) VALUES (?, ?, ?, ?)")
    .run(bookingId, paidCents, foundCents, currency);
  return toAlert(getDb().prepare("SELECT * FROM alerts WHERE id = ?").get(result.lastInsertRowid)!);
}

export function listAlerts(bookingId: number): Alert[] {
  return getDb().prepare("SELECT * FROM alerts WHERE booking_id = ? ORDER BY id DESC").all(bookingId).map(toAlert);
}

/** Lowest fare we've already alerted on at the current paid price, so we only re-alert on a further drop. */
export function lowestAlertedCents(bookingId: number, paidCents: number): number | null {
  const row = getDb()
    .prepare("SELECT MIN(found_cents) AS m FROM alerts WHERE booking_id = ? AND paid_cents = ?")
    .get(bookingId, paidCents);
  return row?.m === null || row?.m === undefined ? null : Number(row.m);
}
