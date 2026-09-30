import { extractBooking } from "./extract";
import { formatMoney } from "./format";
import { checkBooking, describeTrip } from "./monitor";
import * as repo from "./repo";
import type { Booking } from "./types";

/**
 * Cheap keyword gate run before the (paid) AI extraction. Mailbox scans match every "confirmation"
 * email — shop orders, appointments, class sign-ups — and only travel bookings are worth reading.
 */
const TRAVEL_WORDS =
  /\b(flights?|airlines?|airways|itinerary|boarding|e-?tickets?|record locator|departs?|departure|hotels?|resorts?|check-?in|check-?out|marriott|bonvoy|hilton|hyatt|ihg|holiday inn|westin|sheraton|hampton)\b/i;

export function looksLikeTravel(email: { subject: string; text: string }): boolean {
  return TRAVEL_WORDS.test(email.subject) || TRAVEL_WORDS.test(email.text);
}

export type IngestResult =
  | { ok: true; booking: Booking; created: boolean }
  | { ok: false; reason: string };

/**
 * Turn one email into a tracked booking: AI extraction → upsert → an immediate first price check
 * so the dashboard has a baseline right away.
 */
export async function ingestEmail(
  userId: number,
  email: { subject: string; from?: string | null; text: string },
  source: string,
  deps: { extract?: typeof extractBooking; firstCheck?: boolean } = {},
): Promise<IngestResult> {
  if (!looksLikeTravel(email)) return { ok: false, reason: "This doesn't look like a flight or hotel booking." };
  const extract = deps.extract ?? extractBooking;
  const { booking: parsed, reason } = await extract(email);
  if (!parsed) return { ok: false, reason: reason ?? "No flight or hotel booking found." };

  const { booking, created } = await repo.upsertBooking(userId, parsed, source);
  if (deps.firstCheck !== false) {
    // A failed first check shouldn't fail ingestion; it's recorded and retried by the scheduler.
    await checkBooking(booking, { force: true }).catch((err) => console.error("First price check failed", err));
  }
  return { ok: true, booking, created };
}

export function describeBooking(b: Booking): string {
  return `${describeTrip(b)} (${b.confirmationCode}, paid ${formatMoney(b.paidCents, b.currency)})`;
}
