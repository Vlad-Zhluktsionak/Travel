import Link from "next/link";
import { notFound } from "next/navigation";
import { hotelAdvice, rebookAdvice } from "@/lib/advice";
import { formatDate, formatLocal, formatMoney } from "@/lib/format";
import { describeTrip } from "@/lib/monitor";
import { nightsBetween } from "@/lib/pricing/serpapi-hotels";
import * as repo from "@/lib/repo";
import { requireUser } from "@/lib/session";
import type { FlightBooking, HotelBooking, PriceCheck } from "@/lib/types";
import { checkNow, removeBooking, setTracking } from "../../actions";

export const dynamic = "force-dynamic";

const utc = (sqlTime: string) => new Date(`${sqlTime.replace(" ", "T")}Z`);

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
        <PriceChart checks={checks} paidCents={booking.paidCents} currency={booking.currency} />
        <div className="row" style={{ marginTop: 12, justifyContent: "space-between" }}>
          <span className="muted small">
            {lastCheck
              ? `Last checked ${utc(lastCheck.checkedAt).toLocaleString()} via ${lastCheck.provider}${lastCheck.note ? ` — ${lastCheck.note}` : ""}`
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
                {utc(a.createdAt).toLocaleString()}: {formatMoney(a.foundCents, a.currency)} (save{" "}
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

function PriceChart({ checks, paidCents, currency }: { checks: PriceCheck[]; paidCents: number; currency: string }) {
  const points = checks.filter((c) => c.priceCents !== null && c.currency === currency);
  if (points.length === 0) return <p className="muted">No prices recorded yet.</p>;

  const W = 640, H = 200, PAD_L = 64, PAD_R = 12, PAD_T = 12, PAD_B = 24;
  const values = [paidCents, ...points.map((p) => p.priceCents!)];
  const min = Math.min(...values) * 0.97;
  const max = Math.max(...values) * 1.03;
  const x = (i: number) => PAD_L + (points.length === 1 ? (W - PAD_L - PAD_R) / 2 : (i / (points.length - 1)) * (W - PAD_L - PAD_R));
  const y = (v: number) => PAD_T + (1 - (v - min) / (max - min || 1)) * (H - PAD_T - PAD_B);
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.priceCents!).toFixed(1)}`).join(" ");
  const lowest = Math.min(...points.map((p) => p.priceCents!));

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Price history chart">
      <line className="paid" x1={PAD_L} x2={W - PAD_R} y1={y(paidCents)} y2={y(paidCents)} />
      <text x={4} y={y(paidCents) + 4}>Paid {formatMoney(paidCents, currency).replace(/\.00$/, "")}</text>
      <text x={4} y={y(lowest) + 4}>Low {formatMoney(lowest, currency).replace(/\.00$/, "")}</text>
      <path className="line" d={path} />
      {points.map((p, i) => (
        <circle key={p.id} className="dot" cx={x(i)} cy={y(p.priceCents!)} r={3}>
          <title>{`${utc(p.checkedAt).toLocaleString()}: ${formatMoney(p.priceCents!, currency)}`}</title>
        </circle>
      ))}
      <text x={PAD_L} y={H - 6}>{utc(points[0].checkedAt).toLocaleDateString()}</text>
      <text x={W - PAD_R} y={H - 6} textAnchor="end">{utc(points[points.length - 1].checkedAt).toLocaleDateString()}</text>
    </svg>
  );
}
