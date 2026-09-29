import Link from "next/link";
import { notFound } from "next/navigation";
import { rebookAdvice } from "@/lib/airlines";
import { formatLocal, formatMoney } from "@/lib/format";
import * as repo from "@/lib/repo";
import { requireUser } from "@/lib/session";
import type { PriceCheck } from "@/lib/types";
import { checkNow, removeBooking, setTracking } from "../../actions";

export const dynamic = "force-dynamic";

export default async function TripPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const booking = repo.getBooking(Number((await params).id), user.id);
  if (!booking) notFound();

  const checks = repo.listPriceChecks(booking.id);
  const alerts = repo.listAlerts(booking.id);
  const latest = repo.latestPriceCheck(booking.id);
  const comparable = latest && latest.currency === booking.currency ? latest.priceCents! : null;
  const savings = comparable !== null ? booking.paidCents - comparable : null;
  const first = booking.slices[0][0];
  const lastCheck = checks[checks.length - 1];

  return (
    <>
      <p><Link href="/">← All trips</Link></p>

      <section className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <h2 style={{ fontSize: 22, marginBottom: 4 }}>
              {booking.slices.map((s) => `${s[0].origin} → ${s[s.length - 1].destination}`).join("  ·  ")}
            </h2>
            <div className="muted small">
              {booking.airline ?? first.carrier} · Confirmation <b>{booking.confirmationCode}</b>
              {booking.bookingSite && <> · via {booking.bookingSite}</>} · {booking.cabin.replace("_", " ")}
              {booking.fareBrand && <> ({booking.fareBrand})</>} · {booking.passengerCount} passenger(s)
            </div>
          </div>
          <div className="price">
            <div className="muted small">You paid</div>
            <div className="now">{formatMoney(booking.paidCents, booking.currency)}</div>
          </div>
        </div>

        {savings !== null && savings > 0 && booking.status === "active" && (
          <div className="notice good" style={{ marginTop: 16 }}>
            <b>The same flights now cost {formatMoney(comparable!, booking.currency)} — {formatMoney(savings, booking.currency)} less.</b>
            <div className="small" style={{ marginTop: 4 }}>{rebookAdvice(first.carrier, booking.fareBrand)}</div>
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
              ? `Last checked ${new Date(lastCheck.checkedAt + "Z").toLocaleString()} via ${lastCheck.provider}${lastCheck.note ? ` — ${lastCheck.note}` : ""}`
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

      <section className="card">
        <h2>Flights</h2>
        <table className="segments">
          <thead><tr><th>Flight</th><th>From</th><th>To</th><th>Departs (local)</th><th>Arrives (local)</th></tr></thead>
          <tbody>
            {booking.slices.flatMap((slice, i) =>
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
        {booking.passengerNames.length > 0 && <p className="muted small">Passengers: {booking.passengerNames.join(", ")}</p>}
      </section>

      {alerts.length > 0 && (
        <section className="card">
          <h2>Alerts sent</h2>
          <ul>
            {alerts.map((a) => (
              <li key={a.id}>
                {new Date(a.createdAt + "Z").toLocaleString()}: {formatMoney(a.foundCents, a.currency)} (save{" "}
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
          <title>{`${new Date(p.checkedAt + "Z").toLocaleString()}: ${formatMoney(p.priceCents!, currency)}`}</title>
        </circle>
      ))}
      <text x={PAD_L} y={H - 6}>{new Date(points[0].checkedAt + "Z").toLocaleDateString()}</text>
      <text x={W - PAD_R} y={H - 6} textAnchor="end">{new Date(points[points.length - 1].checkedAt + "Z").toLocaleDateString()}</text>
    </svg>
  );
}
