import { config } from "./config";
import { rebookAdvice } from "./airlines";
import { formatLocal, formatMoney } from "./format";
import { escapeHtml, sendEmail, type Mailer } from "./notify";
import { getPriceProvider, type PriceProvider } from "./pricing";
import * as repo from "./repo";
import type { Booking } from "./types";

/** After an alert, only alert again if the fare drops at least this much further. */
const REALERT_STEP_CENTS = 500;

export type CheckOutcome =
  | { status: "departed" }
  | { status: "error"; error: string }
  | { status: "unavailable"; note?: string }
  | { status: "checked"; priceCents: number; currency: string; alerted: boolean };

export function firstDeparture(booking: Booking): string | null {
  return booking.slices[0]?.[0]?.departureLocal ?? null;
}

export async function checkBooking(
  booking: Booking,
  deps: { provider?: PriceProvider; mailer?: Mailer; now?: Date } = {},
): Promise<CheckOutcome> {
  const provider = deps.provider ?? getPriceProvider();
  const mailer = deps.mailer ?? sendEmail;
  const now = deps.now ?? new Date();

  const departure = firstDeparture(booking);
  if (!departure || departure.slice(0, 10) <= now.toISOString().slice(0, 10)) {
    repo.setBookingStatus(booking.id, "departed");
    return { status: "departed" };
  }

  let quote;
  try {
    quote = await provider.quote(booking, {
      bookingKey: `${booking.id}:${booking.confirmationCode}`,
      paidCents: booking.paidCents,
      currency: booking.currency,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    repo.recordPriceCheck(booking.id, provider.name, null, null, `Error: ${error.slice(0, 200)}`);
    return { status: "error", error };
  }

  repo.recordPriceCheck(booking.id, provider.name, quote.priceCents, quote.currency, quote.note ?? null);
  if (quote.priceCents === null || !quote.currency) return { status: "unavailable", note: quote.note };

  const outcome: CheckOutcome = { status: "checked", priceCents: quote.priceCents, currency: quote.currency, alerted: false };
  // We never convert currencies: a quote in a different currency is recorded but can't trigger an alert.
  if (quote.currency !== booking.currency) return outcome;

  const user = repo.findUserById(booking.userId);
  if (!user) return outcome;

  const savings = booking.paidCents - quote.priceCents;
  if (savings < user.alertThresholdCents) return outcome;

  const alreadyAlerted = repo.lowestAlertedCents(booking.id, booking.paidCents);
  if (alreadyAlerted !== null && quote.priceCents > alreadyAlerted - REALERT_STEP_CENTS) return outcome;

  repo.createAlert(booking.id, booking.paidCents, quote.priceCents, quote.currency);
  await mailer(buildAlertEmail(user.email, booking, quote.priceCents, provider.name === "mock"));
  return { ...outcome, alerted: true };
}

export function buildAlertEmail(to: string, booking: Booking, foundCents: number, simulated: boolean) {
  const savings = formatMoney(booking.paidCents - foundCents, booking.currency);
  const first = booking.slices[0][0];
  const lastOfFirst = booking.slices[0][booking.slices[0].length - 1];
  const route = `${first.origin} → ${lastOfFirst.destination}${booking.slices.length > 1 ? " (round trip)" : ""}`;
  const advice = rebookAdvice(first.carrier, booking.fareBrand);
  const link = `${config.appUrl}/trips/${booking.id}`;
  const demo = simulated ? "\n\n(Demo mode: this price is simulated, not a real fare.)" : "";

  const text = `Good news — the price of your ${route} trip dropped by ${savings}.

Confirmation: ${booking.confirmationCode}
Departs: ${formatLocal(first.departureLocal)}
You paid: ${formatMoney(booking.paidCents, booking.currency)}
Price now: ${formatMoney(foundCents, booking.currency)} for the same flights, cabin and ${booking.passengerCount} passenger(s)

How to claim it: ${advice}

Trip details and price history: ${link}${demo}`;

  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px">
<h2 style="margin:0 0 8px">Your fare dropped by ${escapeHtml(savings)} ✈️</h2>
<p style="margin:0 0 16px;color:#555">${escapeHtml(route)} · ${escapeHtml(booking.confirmationCode)} · departs ${escapeHtml(formatLocal(first.departureLocal))}</p>
<table style="border-collapse:collapse;margin-bottom:16px">
<tr><td style="padding:4px 16px 4px 0">You paid</td><td><b>${escapeHtml(formatMoney(booking.paidCents, booking.currency))}</b></td></tr>
<tr><td style="padding:4px 16px 4px 0">Price now</td><td><b style="color:#0a7f3f">${escapeHtml(formatMoney(foundCents, booking.currency))}</b></td></tr>
</table>
<p><b>How to claim it:</b> ${escapeHtml(advice)}</p>
<p><a href="${escapeHtml(link)}">View trip &amp; price history</a></p>
${simulated ? '<p style="color:#a15c00">Demo mode: this price is simulated, not a real fare.</p>' : ""}
</div>`;

  return { to, subject: `💸 Price drop: save ${savings} on ${route}`, text, html };
}

/** Check every active booking. Called by the cron endpoint and `npm run monitor`. */
export async function runMonitor(deps: { provider?: PriceProvider; mailer?: Mailer; now?: Date } = {}) {
  const summary = { checked: 0, alerts: 0, departed: 0, unavailable: 0, errors: 0 };
  for (const booking of repo.listActiveBookings()) {
    const result = await checkBooking(booking, deps);
    if (result.status === "checked") {
      summary.checked++;
      if (result.alerted) summary.alerts++;
    } else if (result.status === "departed") summary.departed++;
    else if (result.status === "unavailable") summary.unavailable++;
    else summary.errors++;
  }
  return summary;
}
