import { config } from "./config";
import { hotelAdvice, rebookAdvice } from "./advice";
import { formatDate, formatLocal, formatMoney } from "./format";
import { escapeHtml, sendEmail, type Mailer } from "./notify";
import { getProviders, type Providers } from "./pricing";
import { nightsBetween } from "./pricing/serpapi-hotels";
import type { PriceQuote } from "./pricing/provider";
import * as repo from "./repo";
import type { Booking } from "./types";

/** After an alert, only alert again if the price drops at least this much further. */
const REALERT_STEP_CENTS = 500;

export type CheckOutcome =
  | { status: "departed" }
  | { status: "skipped" }
  | { status: "error"; error: string }
  | { status: "unavailable"; note?: string }
  | { status: "checked"; priceCents: number; currency: string; alerted: boolean };

export interface MonitorDeps {
  providers?: Partial<Providers>;
  mailer?: Mailer;
  now?: Date;
  /** Ignore the minimum interval between checks (used by "Check price now"). */
  force?: boolean;
}

export async function checkBooking(booking: Booking, deps: MonitorDeps = {}): Promise<CheckOutcome> {
  const now = deps.now ?? new Date();
  const mailer = deps.mailer ?? sendEmail;

  if (repo.startsOn(booking) <= now.toISOString().slice(0, 10)) {
    await repo.setBookingStatus(booking.id, "departed");
    return { status: "departed" };
  }

  if (!deps.force && booking.lastCheckedAt) {
    const hoursSince = (now.getTime() - Date.parse(`${booking.lastCheckedAt.replace(" ", "T")}Z`)) / 3600_000;
    if (hoursSince < config.checkIntervalHours(booking.kind)) return { status: "skipped" };
  }

  const providers: Providers = { ...getProviders(), ...deps.providers };
  const ctx = { bookingKey: `${booking.id}:${booking.confirmationCode}`, paidCents: booking.paidCents, currency: booking.currency };
  const providerName = booking.kind === "flight" ? providers.flight.name : providers.hotel.name;

  let quote: PriceQuote;
  try {
    if (booking.kind === "flight") {
      quote = await providers.flight.quote(booking.details, ctx);
    } else {
      const hotelQuote = await providers.hotel.quote(booking.details, ctx);
      if (hotelQuote.propertyToken && hotelQuote.propertyToken !== booking.details.propertyToken) {
        await repo.updateBookingDetails(booking.id, { ...booking.details, propertyToken: hotelQuote.propertyToken });
      }
      quote = hotelQuote;
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await repo.recordPriceCheck(booking.id, providerName, null, null, `Error: ${error.slice(0, 200)}`);
    return { status: "error", error };
  }

  await repo.recordPriceCheck(booking.id, providerName, quote.priceCents, quote.currency, quote.note ?? null);
  if (quote.priceCents === null || !quote.currency) return { status: "unavailable", note: quote.note };

  const outcome: CheckOutcome = { status: "checked", priceCents: quote.priceCents, currency: quote.currency, alerted: false };
  // We never convert currencies: a quote in a different currency is recorded but can't trigger an alert.
  if (quote.currency !== booking.currency) return outcome;

  const user = await repo.findUserById(booking.userId);
  if (!user) return outcome;

  const savings = booking.paidCents - quote.priceCents;
  if (savings < user.alertThresholdCents) return outcome;

  const alreadyAlerted = await repo.lowestAlertedCents(booking.id, booking.paidCents);
  if (alreadyAlerted !== null && quote.priceCents > alreadyAlerted - REALERT_STEP_CENTS) return outcome;

  await repo.createAlert(booking.id, booking.paidCents, quote.priceCents, quote.currency);
  await mailer(buildAlertEmail(user.email, booking, quote.priceCents, providerName === "mock"));
  return { ...outcome, alerted: true };
}

/** Short human description, e.g. "SFO → BOS (round trip)" or "Hyatt Regency Chicago, Mar 3–6". */
export function describeTrip(booking: Booking): string {
  if (booking.kind === "hotel") {
    const h = booking.details;
    return `${h.hotelName}, ${formatDate(h.checkIn)}–${formatDate(h.checkOut)}`;
  }
  const out = booking.details.slices[0];
  return `${out[0].origin} → ${out[out.length - 1].destination}${booking.details.slices.length > 1 ? " (round trip)" : ""}`;
}

export function buildAlertEmail(to: string, booking: Booking, foundCents: number, simulated: boolean) {
  const savings = formatMoney(booking.paidCents - foundCents, booking.currency);
  const trip = describeTrip(booking);
  const link = `${config.appUrl}/trips/${booking.id}`;

  let facts: [string, string][];
  let advice: string;
  let canRebook = true;
  if (booking.kind === "hotel") {
    const h = booking.details;
    facts = [
      ["Stay", `${formatDate(h.checkIn)} → ${formatDate(h.checkOut)} (${nightsBetween(h.checkIn, h.checkOut)} nights, ${h.rooms} room(s))`],
      ["Rate", [h.roomType, h.rateName].filter(Boolean).join(" · ") || "—"],
    ];
    advice = hotelAdvice(h);
    canRebook = h.refundable !== false;
  } else {
    const first = booking.details.slices[0][0];
    facts = [
      ["Departs", formatLocal(first.departureLocal)],
      ["Passengers", String(booking.details.passengerCount)],
    ];
    advice = rebookAdvice(first.carrier, booking.details.fareBrand);
  }
  facts = [
    ["Confirmation", booking.confirmationCode],
    ...facts,
    ["You paid", formatMoney(booking.paidCents, booking.currency)],
    ["Price now", formatMoney(foundCents, booking.currency)],
  ];

  const what = booking.kind === "hotel" ? "your stay at" : "your trip";
  const demo = simulated ? "\n\n(Demo mode: this price is simulated, not a real price.)" : "";
  const text = `The price of ${what} ${trip} dropped by ${savings}${canRebook ? "" : " (non-refundable rate — can't rebook)"}.

${facts.map(([k, v]) => `${k}: ${v}`).join("\n")}

How to claim it: ${advice}

Details and price history: ${link}${demo}`;

  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px">
<h2 style="margin:0 0 8px">${booking.kind === "hotel" ? "🏨" : "✈️"} Price dropped by ${escapeHtml(savings)}</h2>
<p style="margin:0 0 16px;color:#555">${escapeHtml(trip)}${canRebook ? "" : " · <b>non-refundable rate — can't rebook</b>"}</p>
<table style="border-collapse:collapse;margin-bottom:16px">
${facts.map(([k, v]) => `<tr><td style="padding:4px 16px 4px 0;color:#555">${escapeHtml(k)}</td><td><b>${escapeHtml(v)}</b></td></tr>`).join("\n")}
</table>
<p><b>How to claim it:</b> ${escapeHtml(advice)}</p>
<p><a href="${escapeHtml(link)}">View details &amp; price history</a></p>
${simulated ? '<p style="color:#a15c00">Demo mode: this price is simulated, not a real price.</p>' : ""}
</div>`;

  const prefix = canRebook ? "💸 Price drop" : "📉 Price drop (non-refundable)";
  return { to, subject: `${prefix}: save ${savings} on ${trip}`, text, html };
}

/** Check every active booking. Called by the cron endpoint and `npm run monitor`. */
export async function runMonitor(deps: MonitorDeps = {}) {
  const summary = { checked: 0, alerts: 0, departed: 0, skipped: 0, unavailable: 0, errors: 0 };
  for (const booking of await repo.listActiveBookings()) {
    const result = await checkBooking(booking, deps);
    if (result.status === "checked") {
      summary.checked++;
      if (result.alerted) summary.alerts++;
    } else if (result.status === "departed") summary.departed++;
    else if (result.status === "skipped") summary.skipped++;
    else if (result.status === "unavailable") summary.unavailable++;
    else summary.errors++;
  }
  return summary;
}
