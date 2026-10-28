import { config } from "./config";
import { describeCabins } from "./cabins";
import { fareWatchSettings, optionLabel, targetsFor, type FareWatchSettings, type OptionKey } from "./fares";
import { hotelAdvice, rebookAdvice } from "./advice";
import { formatDate, formatLocal, formatMoney } from "./format";
import { escapeHtml, sendEmail, type Mailer } from "./notify";
import { getProviders, type Providers } from "./pricing";
import { nightsBetween } from "./pricing/serpapi-hotels";
import type { FlightPriceProvider, PriceQuote, QuoteContext } from "./pricing/provider";
import * as repo from "./repo";
import type { Booking, FlightBooking } from "./types";

/** After an alert, only alert again if the price drops at least this much further. */
const REALERT_STEP_CENTS = 500;

/** Result for one ticked fare option other than what was paid. */
export interface OptionOutcome {
  key: OptionKey;
  priceCents: number | null;
  alerted: boolean;
  error?: string;
}

export type CheckOutcome =
  | { status: "departed" }
  | { status: "skipped" }
  | { status: "error"; error: string; options?: OptionOutcome[] }
  | { status: "unavailable"; note?: string; options?: OptionOutcome[] }
  | { status: "checked"; priceCents: number; currency: string; alerted: boolean; options?: OptionOutcome[] };

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
  // One cache per check: ticked fare options that need the same search share a single API call.
  const ctx: QuoteContext = {
    bookingKey: `${booking.id}:${booking.confirmationCode}`,
    paidCents: booking.paidCents,
    currency: booking.currency,
    searchCache: new Map(),
  };
  const settings = booking.kind === "flight" ? fareWatchSettings(booking.details) : null;
  if (settings) ctx.paidLevels = settings.paid.split("+");
  const outcome: CheckOutcome = await checkWhatWasPaid(booking, providers, mailer, ctx, settings);

  // Other ticked fare options are add-ons: they never change or block the main price check's result.
  if (booking.kind === "flight" && settings && settings.options.length > 1 && outcome.status !== "departed" && outcome.status !== "skipped") {
    outcome.options = await checkFareOptions(booking, settings, providers.flight, mailer, ctx);
  }
  return outcome;
}

async function checkWhatWasPaid(
  booking: Booking,
  providers: Providers,
  mailer: Mailer,
  ctx: QuoteContext,
  settings: FareWatchSettings | null,
): Promise<CheckOutcome> {
  const providerName = booking.kind === "flight" ? providers.flight.name : providers.hotel.name;

  let quote: PriceQuote;
  try {
    if (booking.kind === "flight") {
      const targets = targetsFor(booking.details, settings!.paid, { isPaid: true, overridden: settings!.paidOverridden });
      quote = await providers.flight.quote({ ...booking.details, targets }, ctx);
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

  const outcome = { status: "checked" as const, priceCents: quote.priceCents, currency: quote.currency, alerted: false };
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

async function checkFareOptions(
  booking: FlightBooking,
  settings: FareWatchSettings,
  provider: FlightPriceProvider,
  mailer: Mailer,
  ctx: QuoteContext,
): Promise<OptionOutcome[]> {
  const results: OptionOutcome[] = [];
  for (const key of settings.options.slice(1)) {
    let quote: PriceQuote;
    try {
      const targets = targetsFor(booking.details, key, { isPaid: false, overridden: false });
      quote = await provider.quote({ ...booking.details, targets }, { ...ctx, bookingKey: `${ctx.bookingKey}:${key}` });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await repo.recordPriceCheck(booking.id, provider.name, null, null, `Error: ${error.slice(0, 200)}`, key);
      results.push({ key, priceCents: null, alerted: false, error });
      continue;
    }
    await repo.recordPriceCheck(booking.id, provider.name, quote.priceCents, quote.currency, quote.note ?? null, key);
    const result: OptionOutcome = { key, priceCents: quote.priceCents, alerted: false };
    results.push(result);
    if (quote.priceCents === null || quote.currency !== booking.currency) continue;

    // Alert when this option costs at most the trip's limit more than what was paid.
    if (quote.priceCents - booking.paidCents > settings.maxExtraCents) continue;
    const alreadyAlerted = await repo.lowestAlertedCents(booking.id, booking.paidCents, key);
    if (alreadyAlerted !== null && quote.priceCents > alreadyAlerted - REALERT_STEP_CENTS) continue;

    const user = await repo.findUserById(booking.userId);
    if (!user) continue;
    await repo.createAlert(booking.id, booking.paidCents, quote.priceCents, quote.currency, key);
    await mailer(buildOptionEmail(user.email, booking, key, quote, settings, provider.name === "mock"));
    result.alerted = true;
  }
  return results;
}

/** "+$120.00", "no extra cost" or "$45.00 less". */
export function extraText(diffCents: number, currency: string): string {
  if (diffCents === 0) return "no extra cost";
  return diffCents > 0 ? `+${formatMoney(diffCents, currency)}` : `${formatMoney(-diffCents, currency)} less`;
}

export function buildOptionEmail(
  to: string,
  booking: FlightBooking,
  key: OptionKey,
  quote: PriceQuote,
  settings: FareWatchSettings,
  simulated: boolean,
) {
  const trip = describeTrip(booking);
  const found = quote.priceCents!;
  const diff = found - booking.paidCents;
  const label = optionLabel(key);
  const airline = booking.details.airline ?? booking.details.slices[0][0].carrier;
  const link = `${config.appUrl}/trips/${booking.id}`;
  const advice = `Look up your reservation (${booking.confirmationCode}) on ${airline}'s website or app and change it to the same flights with this fare; you'd pay (or get back) the fare difference. The airline calculates the exact amount, so check it before you confirm.`;
  const facts: [string, string][] = [
    ["Confirmation", booking.confirmationCode],
    ["Departs", formatLocal(booking.details.slices[0][0].departureLocal)],
    ["Passengers", String(booking.details.passengerCount)],
    ["You paid", `${formatMoney(booking.paidCents, booking.currency)} (${optionLabel(settings.paid)})`],
    [`${label} now`, `${formatMoney(found, booking.currency)}${quote.note ? ` (${quote.note})` : ""}`],
    ["Your limit", `${formatMoney(settings.maxExtraCents, booking.currency)} extra`],
  ];
  const headline = `${label} for ${extraText(diff, booking.currency)}`;
  const demo = simulated ? "\n\n(Demo mode: this price is simulated, not a real fare.)" : "";
  const text = `${label} on your ${trip} flights now costs ${extraText(diff, booking.currency)} compared with what you paid.

${facts.map(([k, v]) => `${k}: ${v}`).join("\n")}

How to switch: ${advice}

Details: ${link}${demo}`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px">
<h2 style="margin:0 0 8px">⬆️ ${escapeHtml(headline)}</h2>
<p style="margin:0 0 16px;color:#555">${escapeHtml(trip)}</p>
<table style="border-collapse:collapse;margin-bottom:16px">
${facts.map(([k, v]) => `<tr><td style="padding:4px 16px 4px 0;color:#555">${escapeHtml(k)}</td><td><b>${escapeHtml(v)}</b></td></tr>`).join("\n")}
</table>
<p><b>How to switch:</b> ${escapeHtml(advice)}</p>
<p><a href="${escapeHtml(link)}">View details</a></p>
${simulated ? '<p style="color:#a15c00">Demo mode: this price is simulated, not a real fare.</p>' : ""}
</div>`;
  return { to, subject: `⬆️ ${headline}: ${trip}`, text, html };
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
