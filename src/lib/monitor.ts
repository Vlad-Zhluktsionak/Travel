import { config } from "./config";
import { hotelAdvice, rebookAdvice } from "./advice";
import { formatDate, formatLocal, formatMoney } from "./format";
import { escapeHtml, sendEmail, type Mailer } from "./notify";
import { getProviders, type Providers } from "./pricing";
import { nightsBetween } from "./pricing/serpapi-hotels";
import type { FlightPriceProvider, PriceQuote } from "./pricing/provider";
import * as repo from "./repo";
import type { Booking, Cabin, FlightBooking, UpgradeCabin } from "./types";

/** After an alert, only alert again if the price drops at least this much further. */
const REALERT_STEP_CENTS = 500;

export interface UpgradeOutcome {
  cabin: UpgradeCabin;
  priceCents: number | null;
  alerted: boolean;
  error?: string;
}

export type CheckOutcome =
  | { status: "departed" }
  | { status: "skipped" }
  | { status: "error"; error: string; upgrades?: UpgradeOutcome[] }
  | { status: "unavailable"; note?: string; upgrades?: UpgradeOutcome[] }
  | { status: "checked"; priceCents: number; currency: string; alerted: boolean; upgrades?: UpgradeOutcome[] };

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
  const outcome: CheckOutcome = await checkBookedCabin(booking, providers, mailer);

  // Upgrade watching is an add-on: it never changes or blocks the main price check's result.
  if (booking.kind === "flight" && booking.details.upgradeWatch?.enabled && outcome.status !== "departed" && outcome.status !== "skipped") {
    outcome.upgrades = await checkUpgrades(booking, providers.flight, mailer);
  }
  return outcome;
}

async function checkBookedCabin(booking: Booking, providers: Providers, mailer: Mailer): Promise<CheckOutcome> {
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

/** The cabins above the one that was booked. */
export function upgradeCabinsFor(booked: Cabin): UpgradeCabin[] {
  if (booked === "economy") return ["premium_economy", "business_first"];
  if (booked === "premium_economy") return ["business_first"];
  return [];
}

/** Price one upgrade cabin; "business_first" tries business and falls back to first. */
async function quoteUpgrade(booking: FlightBooking, cabin: UpgradeCabin, provider: FlightPriceProvider): Promise<PriceQuote> {
  const attempts: Cabin[] = cabin === "premium_economy" ? ["premium_economy"] : ["business", "first"];
  let quote: PriceQuote = { priceCents: null, currency: null };
  for (const c of attempts) {
    // A higher cabin is never basic economy, so drop the booked fare brand from the comparison.
    quote = await provider.quote(
      { ...booking.details, cabin: c, fareBrand: null },
      { bookingKey: `${booking.id}:${booking.confirmationCode}:${c}`, paidCents: booking.paidCents, currency: booking.currency },
    );
    if (quote.priceCents !== null) return { ...quote, note: quote.note ?? CABIN_LABELS[c] };
  }
  return { ...quote, note: quote.note ?? "Not offered on these flights" };
}

async function checkUpgrades(booking: FlightBooking, provider: FlightPriceProvider, mailer: Mailer): Promise<UpgradeOutcome[]> {
  const watch = booking.details.upgradeWatch!;
  const results: UpgradeOutcome[] = [];
  for (const cabin of upgradeCabinsFor(booking.details.cabin)) {
    let quote: PriceQuote;
    try {
      quote = await quoteUpgrade(booking, cabin, provider);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await repo.recordPriceCheck(booking.id, provider.name, null, null, `Error: ${error.slice(0, 200)}`, cabin);
      results.push({ cabin, priceCents: null, alerted: false, error });
      continue;
    }
    await repo.recordPriceCheck(booking.id, provider.name, quote.priceCents, quote.currency, quote.note ?? null, cabin);
    const result: UpgradeOutcome = { cabin, priceCents: quote.priceCents, alerted: false };
    results.push(result);
    if (quote.priceCents === null || quote.currency !== booking.currency) continue;

    const extra = quote.priceCents - booking.paidCents;
    if (extra > watch.maxExtraCents) continue;
    const alreadyAlerted = await repo.lowestAlertedCents(booking.id, booking.paidCents, cabin);
    if (alreadyAlerted !== null && quote.priceCents > alreadyAlerted - REALERT_STEP_CENTS) continue;

    const user = await repo.findUserById(booking.userId);
    if (!user) continue;
    await repo.createAlert(booking.id, booking.paidCents, quote.priceCents, quote.currency, cabin);
    await mailer(buildUpgradeEmail(user.email, booking, cabin, quote, provider.name === "mock"));
    result.alerted = true;
  }
  return results;
}

export const CABIN_LABELS: Record<Cabin, string> = {
  economy: "Economy",
  premium_economy: "Premium economy",
  business: "Business",
  first: "First",
};

export const UPGRADE_LABELS: Record<UpgradeCabin, string> = {
  premium_economy: "Premium economy",
  business_first: "Business / First",
};

export function buildUpgradeEmail(to: string, booking: FlightBooking, cabin: UpgradeCabin, quote: PriceQuote, simulated: boolean) {
  const trip = describeTrip(booking);
  const found = quote.priceCents!;
  const extra = found - booking.paidCents;
  const extraText = extra <= 0 ? `no more than you paid (${formatMoney(-extra, booking.currency)} less)` : `only ${formatMoney(extra, booking.currency)} more than you paid`;
  const cabinName = quote.note && !/not offered/i.test(quote.note) ? quote.note : UPGRADE_LABELS[cabin];
  const airline = booking.details.airline ?? booking.details.slices[0][0].carrier;
  const link = `${config.appUrl}/trips/${booking.id}`;
  const advice = `Look up your reservation (${booking.confirmationCode}) on ${airline}'s website or app and change it to the same flights in the higher cabin; you'd pay the fare difference. The airline calculates the exact amount, so check it before you pay.`;
  const facts: [string, string][] = [
    ["Confirmation", booking.confirmationCode],
    ["Departs", formatLocal(booking.details.slices[0][0].departureLocal)],
    ["Passengers", String(booking.details.passengerCount)],
    ["You paid", `${formatMoney(booking.paidCents, booking.currency)} (${CABIN_LABELS[booking.details.cabin]})`],
    [`${UPGRADE_LABELS[cabin]} now`, formatMoney(found, booking.currency)],
    ["Your upgrade limit", `${formatMoney(booking.details.upgradeWatch?.maxExtraCents ?? 0, booking.currency)} extra`],
  ];
  const demo = simulated ? "\n\n(Demo mode: this price is simulated, not a real fare.)" : "";
  const text = `${UPGRADE_LABELS[cabin]} on your ${trip} flights is now ${extraText}.

${facts.map(([k, v]) => `${k}: ${v}`).join("\n")}

How to upgrade: ${advice}

Details: ${link}${demo}`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px">
<h2 style="margin:0 0 8px">⬆️ ${escapeHtml(UPGRADE_LABELS[cabin])} for ${escapeHtml(extra <= 0 ? "no extra cost" : `+${formatMoney(extra, booking.currency)}`)}</h2>
<p style="margin:0 0 16px;color:#555">${escapeHtml(trip)} · ${escapeHtml(cabinName)}</p>
<table style="border-collapse:collapse;margin-bottom:16px">
${facts.map(([k, v]) => `<tr><td style="padding:4px 16px 4px 0;color:#555">${escapeHtml(k)}</td><td><b>${escapeHtml(v)}</b></td></tr>`).join("\n")}
</table>
<p><b>How to upgrade:</b> ${escapeHtml(advice)}</p>
<p><a href="${escapeHtml(link)}">View details</a></p>
${simulated ? '<p style="color:#a15c00">Demo mode: this price is simulated, not a real fare.</p>' : ""}
</div>`;
  const subjectExtra = extra <= 0 ? "no extra cost" : `+${formatMoney(extra, booking.currency)}`;
  return { to, subject: `⬆️ Upgrade: ${UPGRADE_LABELS[cabin]} for ${subjectExtra} on ${trip}`, text, html };
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
