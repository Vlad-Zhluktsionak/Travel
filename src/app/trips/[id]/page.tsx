import Link from "next/link";
import { notFound } from "next/navigation";
import { hotelAdvice, rebookAdvice } from "@/lib/advice";
import { formatDate, formatLocal, formatMoney, formatTimestamp } from "@/lib/format";
import { describeTrip } from "@/lib/monitor";
import { nightsBetween } from "@/lib/pricing/serpapi-hotels";
import * as repo from "@/lib/repo";
import { requireUser } from "@/lib/session";
import type { FlightBooking, HotelBooking, PriceCheck } from "@/lib/types";
import { checkNow, removeBooking, setTracking } from "../../actions";
import { PriceChart, type ChartPoint } from "./price-chart";

export const dynamic = "force-dynamic";


export default async function TripPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const booking = await repo.getBooking(Number((await params).id), user.id);
  if (!booking) notFound();

  const [checks, alerts, latest] = await Promise.all([
    repo.listPriceChecks(booking.id),
    repo.listAlerts(booking.id),
    repo.latestPriceCheck(booking.id),
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
        <PriceHistory checks={checks} paidCents={booking.paidCents} currency={booking.currency} />
        <div className="row" style={{ marginTop: 12, justifyContent: "space-between" }}>
          <span className="muted small">
            {lastCheck
              ? `Last checked ${formatTimestamp(lastCheck.checkedAt)} via ${lastCheck.provider}${lastCheck.note ? ` — ${lastCheck.note}` : ""}`
              : "Not checked yet"}
          </span>
          <div className="row">
            {booking.status === "active" && (
              <form action={checkNow}><input type="hidden" name="bookingId" value={booking.id} /><button className="secondary" type="submit">Check price now</button></form>
            )}
            {booking.status !== "departed" && (
              <form action={setTracking}>
                <input type="hidden" name="bookingId" value={booking.id} />
                <input type="hidden" name="active" value={booking.status === "active" ? "0" : "1"} />
                <button className="secondary" type="submit">{booking.status === "active" ? "Pause tracking" : "Resume tracking"}</button>
              </form>
            )}
          </div>
        </div>
      </section>

      {booking.kind === "hotel" ? <HotelDetailsCard booking={booking} /> : <FlightDetailsCard booking={booking} />}

      {alerts.length > 0 && (
        <section className="card">
          <h2>Alerts sent</h2>
          <ul>
            {alerts.map((a) => (
              <li key={a.id}>
                {formatTimestamp(a.createdAt)}: {formatMoney(a.foundCents, a.currency)} (save{" "}
                {formatMoney(a.paidCents - a.foundCents, a.currency)})
              </li>
            ))}
          </ul>
        </section>
      )}

      <form action={removeBooking}>
        <input type="hidden" name="bookingId" value={booking.id} />
        <button className="danger" type="submit">Stop tracking &amp; delete trip</button>
      </form>
    </>
  );
}

function flightSummary(b: FlightBooking) {
  const f = b.details;
  return [
    f.airline ?? f.slices[0][0].carrier,
    f.bookingSite && `via ${f.bookingSite}`,
    f.cabin.replace("_", " ") + (f.fareBrand ? ` (${f.fareBrand})` : ""),
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

function FlightDetailsCard({ booking }: { booking: FlightBooking }) {
  const f = booking.details;
  return (
    <section className="card">
      <h2>Flights</h2>
      <table className="segments">
        <thead><tr><th>Flight</th><th>From</th><th>To</th><th>Departs (local)</th><th>Arrives (local)</th></tr></thead>
        <tbody>
          {f.slices.flatMap((slice, i) =>
            slice.map((s, j) => (
              <tr key={`${i}-${j}`}>
                <td>{s.carrier} {s.flightNumber}</td>
                <td>{s.origin}</td>
                <td>{s.destination}</td>
                <td>{formatLocal(s.departureLocal)}</td>
                <td>{s.arrivalLocal ? formatLocal(s.arrivalLocal) : "—"}</td>
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
