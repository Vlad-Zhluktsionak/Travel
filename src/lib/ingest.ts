import { extractBooking } from "./extract";
import { formatMoney } from "./format";
import { checkBooking } from "./monitor";
import * as repo from "./repo";
import type { Booking } from "./types";

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
  const extract = deps.extract ?? extractBooking;
  const { booking: parsed, reason } = await extract(email);
  if (!parsed) return { ok: false, reason: reason ?? "No flight booking found." };

  const { booking, created } = repo.upsertBooking(userId, parsed, source);
  if (deps.firstCheck !== false) {
    // A failed first check shouldn't fail ingestion; it's recorded and retried by the scheduler.
    await checkBooking(booking).catch((err) => console.error("First price check failed", err));
  }
  return { ok: true, booking, created };
}

export function describeBooking(b: Booking): string {
  const first = b.slices[0][0];
  const lastOfFirst = b.slices[0][b.slices[0].length - 1];
  return `${first.origin} → ${lastOfFirst.destination} (${b.confirmationCode}, paid ${formatMoney(b.paidCents, b.currency)})`;
}
