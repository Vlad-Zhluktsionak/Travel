import Link from "next/link";
import { notFound } from "next/navigation";
import { hotelAdvice, rebookAdvice } from "@/lib/advice";
import { formatDate, formatLocal, formatMoney, formatTimestamp } from "@/lib/format";
import { allOptions, detectedPaidKey, fareWatchSettings, LEVEL_LABELS, optionLabel, searchPlan, type FareLevel } from "@/lib/fares";
import { describeTrip, extraText } from "@/lib/monitor";
import { nightsBetween } from "@/lib/pricing/serpapi-hotels";
import * as repo from "@/lib/repo";
import type { UpgradeSummary } from "@/lib/repo";
import { requireUser } from "@/lib/session";
import type { FlightBooking, HotelBooking, PriceCheck } from "@/lib/types";
import { checkNow, removeBooking, setTracking, updateFareWatch } from "../../actions";
import { PriceChart, type ChartPoint } from "./price-chart";
import { SubmitButton } from "../../submit-button";

export const dynamic = "force-dynamic";


export default async function TripPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const booking = await repo.getBooking(Number((await params).id), user.id);
  if (!booking) notFound();

  const [checks, alerts, latest, upgrades] = await Promise.all([
    repo.listPriceChecks(booking.id),
    repo.listAlerts(booking.id),
    repo.latestPriceCheck(booking.id),
    repo.upgradeSummaries(booking.id),
  ]);
  const comparable = latest && latest.currency === booking.currency ? latest.priceCents! : null;
  const savings = comparable !== null ? booking.paidCents - comparable : null;
  const lastCheck = checks[checks.length - 1];
  const advice =
    booking.kind === "hotel"
      ? hotelAdvice(booking.details)
      : rebookAdvice(booking.details.slices[0][0].carrier, booking.details.fareBrand);

  return (
    <>
      <p><Link href="/">← All trips</Link></p>

      <section className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <h2 style={{ fontSize: 22, marginBottom: 4 }}>
              {booking.kind === "hotel" ? "🏨 " + booking.details.hotelName : "✈️ " + booking.details.slices.map((s) => `${s[0].origin} → ${s[s.length - 1].destination}`).join("  ·  ")}
            </h2>
            <div className="muted small">
              Confirmation <b>{booking.confirmationCode}</b> · {booking.kind === "hotel" ? hotelSummary(booking) : flightSummary(booking)}
            </div>
          </div>
          <div className="price">
            <div className="muted small">You paid</div>
            <div className="now">{formatMoney(booking.paidCents, booking.currency)}</div>
          </div>
        </div>

        {savings !== null && savings > 0 && booking.status === "active" && (
          <div className="notice good" style={{ marginTop: 16 }}>
            <b>
              {describeTrip(booking)} now costs {formatMoney(comparable!, booking.currency)} — {formatMoney(savings, booking.currency)} less.
            </b>
            <div className="small" style={{ marginTop: 4 }}>{advice}</div>
          </div>
        )}
        {latest && latest.currency !== booking.currency && (
          <div className="notice warn small" style={{ marginTop: 16 }}>
            The latest quote is in {latest.currency}, but you paid in {booking.currency}; we don&apos;t compare across currencies.
          </div>
        )}
      </section>

      <section className="card">
        <h2>Price history</h2>
        {lastCheck && lastCheck.priceCents === null && (
          <div className="notice warn small" style={{ marginBottom: 12 }}>
            <b>The last check ({formatTimestamp(lastCheck.checkedAt)}) couldn&apos;t get a price for what you paid.</b>
            <div style={{ marginTop: 4 }}>{lastCheck.note ?? "No details."}</div>
          </div>
        )}
        <PriceHistory checks={checks} paidCents={booking.paidCents} currency={booking.currency} />
        <div className="row" style={{ marginTop: 12, justifyContent: "space-between" }}>
          <span className="muted small">
            {lastCheck
              ? `Last checked ${formatTimestamp(lastCheck.checkedAt)} via ${lastCheck.provider}${lastCheck.note ? ` — ${lastCheck.note}` : ""}`
              : "Not checked yet"}
          </span>
          <div className="row">
            {booking.status === "active" && (
              <form action={checkNow}><input type="hidden" name="bookingId" value={booking.id} /><SubmitButton className="secondary" pending="Checking price… (up to 30s)" done="✓ Checked">Check price now</SubmitButton></form>
            )}
            {booking.status !== "departed" && (
              <form action={setTracking}>
                <input type="hidden" name="bookingId" value={booking.id} />
                <input type="hidden" name="active" value={booking.status === "active" ? "0" : "1"} />
                <SubmitButton className="secondary" pending={booking.status === "active" ? "Pausing…" : "Resuming…"} done="✓ Done">{booking.status === "active" ? "Pause tracking" : "Resume tracking"}</SubmitButton>
              </form>
            )}
          </div>
        </div>
      </section>

      {booking.kind === "flight" && <FareWatchCard booking={booking} options={upgrades} lastPaidCheck={lastCheck ?? null} />}

      {booking.kind === "hotel" ? <HotelDetailsCard booking={booking} /> : <FlightDetailsCard booking={booking} />}

      {alerts.length > 0 && (
        <section className="card">
          <h2>Alerts sent</h2>
          <ul>
            {alerts.map((a) => (
              <li key={a.id}>
                {formatTimestamp(a.createdAt)}:{" "}
                {a.cabin
                  ? `⬆️ ${optionLabel(a.cabin)} for ${formatMoney(a.foundCents, a.currency)} (${extraText(a.foundCents - a.paidCents, a.currency)})`
                  : `${formatMoney(a.foundCents, a.currency)} (save ${formatMoney(a.paidCents - a.foundCents, a.currency)})`}
              </li>
            ))}
          </ul>
        </section>
      )}

      <form action={removeBooking}>
        <input type="hidden" name="bookingId" value={booking.id} />
        <SubmitButton className="danger" pending="Deleting…" confirm="Stop tracking and delete this trip and its price history?">Stop tracking &amp; delete trip</SubmitButton>
      </form>
    </>
  );
}

function flightSummary(b: FlightBooking) {
  const f = b.details;
  return [
    f.airline ?? f.slices[0][0].carrier,
    f.bookingSite && `via ${f.bookingSite}`,
    // What was paid as set on the page (the email's reading, or the user's correction).
    optionLabel(fareWatchSettings(f).paid),
    `${f.passengerCount} passenger(s)`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function hotelSummary(b: HotelBooking) {
  const h = b.details;
  return [h.city, `${formatDate(h.checkIn)} → ${formatDate(h.checkOut)}`, `${nightsBetween(h.checkIn, h.checkOut)} nights`].filter(Boolean).join(" · ");
}

function HotelDetailsCard({ booking }: { booking: HotelBooking }) {
  const h = booking.details;
  const refundability =
    h.refundable === true ? `Refundable${h.cancelBy ? ` — free cancellation until ${formatDate(h.cancelBy)}` : ""}` : h.refundable === false ? "Non-refundable (can't cancel and rebook)" : "Not stated in the confirmation";
  const rows: [string, string][] = [
    ["Check-in", formatDate(h.checkIn)],
    ["Check-out", formatDate(h.checkOut)],
    ["Guests", `${h.adults} adult(s) · ${h.rooms} room(s)`],
    ["Room", h.roomType ?? "—"],
    ["Rate", h.rateName ?? "—"],
    ["Cancellation", refundability],
    ["Address", h.address ?? "—"],
  ];
  return (
    <section className="card">
      <h2>Stay</h2>
      <table className="segments"><tbody>{rows.map(([k, v]) => <tr key={k}><th>{k}</th><td>{v}</td></tr>)}</tbody></table>
      <p className="muted small">Prices are compared only against the hotel&apos;s official website, for the same dates and number of guests.</p>
    </section>
  );
}

function FareWatchCard({ booking, options, lastPaidCheck }: { booking: FlightBooking; options: UpgradeSummary[]; lastPaidCheck: PriceCheck | null }) {
  const d = booking.details;
  const settings = fareWatchSettings(d);
  const choices = allOptions(d.slices.length);
  const detected = detectedPaidKey(d);
  const plan = searchPlan(d, settings);
  const roundTrip = d.slices.length === 2;
  const uniform = choices.slice(0, 3);
  const mixed = choices.slice(3);

  const priceOf = (key: string) => {
    if (key === settings.paid) {
      if (!lastPaidCheck) return null;
      return { check: lastPaidCheck, cents: lastPaidCheck.currency === booking.currency ? lastPaidCheck.priceCents : null };
    }
    const s = options.find((o) => o.cabin === key);
    return s ? { check: s.latest, cents: s.latest.currency === booking.currency ? s.latest.priceCents : null, lowest: s.lowestCents } : null;
  };

  const box = (key: string) => {
    const isPaid = key === settings.paid;
    return (
      <label key={key} className="fare-option">
        <input type="checkbox" name="options" value={key} defaultChecked={isPaid || settings.options.includes(key)} disabled={isPaid} />
        <span>{optionLabel(key)}</span>
        {isPaid && <span className="badge good">what I paid</span>}
      </label>
    );
  };

  return (
    <section className="card">
      <h2>🎫 Fares to watch</h2>
      <p className="muted small">
        Tick the fares to price for these exact flights. Only ticked fares are searched. Price drops are measured against what you paid;
        for the other fares you get an email when one costs at most your limit more.
      </p>
      <form action={updateFareWatch} className="stack">
        <input type="hidden" name="bookingId" value={booking.id} />
        <div className="row">
          <label htmlFor="paid"><b>What I paid</b></label>
          <select id="paid" name="paid" defaultValue={settings.paid}>
            {choices.map((k) => (
              <option key={k} value={k}>{optionLabel(k)}{k === detected ? " (from your email)" : ""}</option>
            ))}
          </select>
          <span className="muted small">Fix this if it&apos;s wrong; changing it restarts the price history.</span>
        </div>
        <div>
          <div className="muted small">{roundTrip ? "Round trip" : d.slices.length === 1 ? "One way" : "All legs"}</div>
          <div className="fare-options">{uniform.map(box)}</div>
        </div>
        {mixed.length > 0 && (
          <div>
            <div className="muted small">Mixed cabins (priced as two one-way fares added together)</div>
            <div className="fare-options">{mixed.map(box)}</div>
          </div>
        )}
        <div className="row">
          <label htmlFor="maxExtra">Email me when a ticked fare costs at most $</label>
          <input id="maxExtra" type="number" name="maxExtra" min={0} step={1} defaultValue={settings.maxExtraCents / 100} style={{ width: 100 }} />
          <span className="muted small">more than I paid (all passengers)</span>
        </div>
        <div className="row">
          <SubmitButton pending="Saving & checking prices…" done="✓ Saved">Save</SubmitButton>
          <span className="muted small">
            {plan.min === plan.max ? plan.min : `${plan.min}–${plan.max}`} search{plan.max === 1 ? "" : "es"} per check
            {plan.max > plan.min ? " (the higher number only when a backup search is needed; Google Flights lookups are reused for 24 hours)" : ""}
          </span>
        </div>
      </form>

      <table className="segments" style={{ marginTop: 12 }}>
        <thead><tr><th>Fare</th><th>Price now</th><th>vs. what you paid</th><th>Lowest seen</th><th>Checked</th></tr></thead>
        <tbody>
          {settings.options.map((key) => {
            const p = priceOf(key);
            const isPaid = key === settings.paid;
            if (!p) return <tr key={key}><td>{optionLabel(key)}</td><td colSpan={4} className="muted">Not checked yet</td></tr>;
            const diff = p.cents === null ? null : p.cents - booking.paidCents;
            const within = !isPaid && diff !== null && diff <= settings.maxExtraCents;
            return (
              <tr key={key}>
                <td>{optionLabel(key)}{isPaid && <span className="badge good" style={{ marginLeft: 6 }}>paid</span>}{p.check.note && p.cents !== null ? <div className="muted small">{p.check.note}</div> : null}</td>
                <td>{p.cents === null ? <span className="muted">{p.check.note ?? "Not offered"}</span> : <b>{formatMoney(p.cents, booking.currency)}</b>}</td>
                <td>{diff === null ? "—" : <span className={within ? "badge good" : undefined}>{extraText(diff, booking.currency)}</span>}</td>
                <td>{"lowest" in p && p.lowest !== null && p.lowest !== undefined ? formatMoney(p.lowest, booking.currency) : "—"}</td>
                <td className="muted small">{formatTimestamp(p.check.checkedAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function FlightDetailsCard({ booking }: { booking: FlightBooking }) {
  const f = booking.details;
  const settings = fareWatchSettings(f);
  const paidLevels = settings.paid.split("+") as FareLevel[];
  const emailLevels = detectedPaidKey(f).split("+");
  const brands = f.sliceFareBrands ?? f.slices.map(() => f.fareBrand);
  const mixed = new Set(paidLevels).size > 1;
  return (
    <section className="card">
      <h2>Flights</h2>
      {mixed && (
        <p className="muted small">
          Different cabins each way: the price is checked as separate one-way fares in each cabin, added together. That&apos;s close to what
          the airline charges but an estimate, so confirm on the airline&apos;s site before rebooking.
        </p>
      )}
      <table className="segments">
        <thead><tr><th>Flight</th><th>From</th><th>To</th><th>Departs (local)</th><th>Arrives (local)</th><th>What I paid</th></tr></thead>
        <tbody>
          {f.slices.flatMap((slice, i) =>
            slice.map((s, j) => (
              <tr key={`${i}-${j}`}>
                <td>{s.carrier} {s.flightNumber}</td>
                <td>{s.origin}</td>
                <td>{s.destination}</td>
                <td>{formatLocal(s.departureLocal)}</td>
                <td>{s.arrivalLocal ? formatLocal(s.arrivalLocal) : "—"}</td>
                <td>
                  {LEVEL_LABELS[paidLevels[i]]}
                  {/* The email's fare name, only when it describes the same level (not after a correction). */}
                  {brands[i] && paidLevels[i] === emailLevels[i] && <span className="muted small"> · {brands[i]}</span>}
                </td>
              </tr>
            )),
          )}
        </tbody>
      </table>
      {f.passengerNames.length > 0 && <p className="muted small">Passengers: {f.passengerNames.join(", ")}</p>}
    </section>
  );
}

function PriceHistory({ checks, paidCents, currency }: { checks: PriceCheck[]; paidCents: number; currency: string }) {
  const priced = checks.filter((c) => c.priceCents !== null && c.currency === currency);
  // Once real prices exist, drop simulated demo-mode points so they don't distort the history.
  const points = priced.some((c) => c.provider !== "mock") ? priced.filter((c) => c.provider !== "mock") : priced;
  if (points.length === 0) return <p className="muted">No prices recorded yet.</p>;

  const short = (cents: number) => formatMoney(cents, currency).replace(/\.00$/, "");
  const chartPoints: ChartPoint[] = points.map((c) => {
    const diff = c.priceCents! - paidCents;
    return {
      id: c.id,
      cents: c.priceCents!,
      price: formatMoney(c.priceCents!, currency),
      when: formatTimestamp(c.checkedAt),
      vsPaid: diff === 0 ? "Same as you paid" : `${formatMoney(Math.abs(diff), currency)} ${diff < 0 ? "below" : "above"} what you paid`,
      below: diff < 0,
    };
  });
  return (
    <PriceChart
      points={chartPoints}
      paidCents={paidCents}
      paidLabel={short(paidCents)}
      lowLabel={short(Math.min(...chartPoints.map((p) => p.cents)))}
      firstDate={formatTimestamp(points[0].checkedAt, true)}
      lastDate={formatTimestamp(points[points.length - 1].checkedAt, true)}
    />
  );
}
