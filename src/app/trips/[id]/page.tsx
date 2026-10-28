import Link from "next/link";
import { notFound } from "next/navigation";
import { hotelAdvice, rebookAdvice } from "@/lib/advice";
import { formatDate, formatLocal, formatMoney, formatTimestamp } from "@/lib/format";
import { CABIN_LABELS, describeCabins, isMixedCabin, lowestCabin, sliceCabins, upgradeCabinsFor } from "@/lib/cabins";
import { describeTrip, UPGRADE_LABELS } from "@/lib/monitor";
import { nightsBetween } from "@/lib/pricing/serpapi-hotels";
import * as repo from "@/lib/repo";
import type { UpgradeSummary } from "@/lib/repo";
import { requireUser } from "@/lib/session";
import type { FlightBooking, HotelBooking, PriceCheck } from "@/lib/types";
import { checkNow, removeBooking, setTracking, updateUpgradeWatch } from "../../actions";
import { PriceChart, type ChartPoint } from "./price-chart";

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

      {booking.kind === "flight" && <UpgradeCard booking={booking} upgrades={upgrades} />}

      {booking.kind === "hotel" ? <HotelDetailsCard booking={booking} /> : <FlightDetailsCard booking={booking} />}

      {alerts.length > 0 && (
        <section className="card">
          <h2>Alerts sent</h2>
          <ul>
            {alerts.map((a) => (
              <li key={a.id}>
                {formatTimestamp(a.createdAt)}:{" "}
                {a.cabin
                  ? `⬆️ ${UPGRADE_LABELS[a.cabin]} for ${formatMoney(a.foundCents, a.currency)} (${a.foundCents <= a.paidCents ? "no extra cost" : `+${formatMoney(a.foundCents - a.paidCents, a.currency)}`})`
                  : `${formatMoney(a.foundCents, a.currency)} (save ${formatMoney(a.paidCents - a.foundCents, a.currency)})`}
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
    describeCabins(f) + (!isMixedCabin(f) && f.fareBrand ? ` (${f.fareBrand})` : ""),
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

function UpgradeCard({ booking, upgrades }: { booking: FlightBooking; upgrades: UpgradeSummary[] }) {
  const cabins = upgradeCabinsFor(booking.details);
  const watch = booking.details.upgradeWatch;
  const enabled = Boolean(watch?.enabled);
  const maxExtra = (watch?.maxExtraCents ?? 20_000) / 100;
  if (cabins.length === 0) {
    return (
      <section className="card">
        <h2>⬆️ Upgrades</h2>
        <p className="muted small">Every leg is already {CABIN_LABELS[lowestCabin(booking.details)].toLowerCase()} or better, the top cabins we track, so there&apos;s nothing to upgrade to.</p>
      </section>
    );
  }
  return (
    <section className="card">
      <h2>⬆️ Upgrades</h2>
      <p className="muted small">
        Also price these same flights in {cabins.map((c) => UPGRADE_LABELS[c].toLowerCase()).join(" and ")}, and email me when an upgrade costs at most my limit more than what I paid ({formatMoney(booking.paidCents, booking.currency)} for {booking.details.passengerCount} passenger(s)).
      </p>
      <form action={updateUpgradeWatch} className="row">
        <input type="hidden" name="bookingId" value={booking.id} />
        <input type="hidden" name="enabled" value={enabled ? "1" : "0"} />
        <label htmlFor="maxExtra">Email me when an upgrade costs at most $</label>
        <input id="maxExtra" type="number" name="maxExtra" min={0} step={1} defaultValue={maxExtra} style={{ width: 100 }} />
        <span className="muted small">more in total</span>
        <button className="secondary" type="submit">Save limit</button>
      </form>
      <form action={updateUpgradeWatch} style={{ marginTop: 10 }}>
        <input type="hidden" name="bookingId" value={booking.id} />
        <input type="hidden" name="maxExtra" value={maxExtra} />
        <input type="hidden" name="enabled" value={enabled ? "0" : "1"} />
        <button type="submit" className={enabled ? "secondary" : undefined}>{enabled ? "Stop watching upgrades" : "Watch upgrades"}</button>
        {enabled && <span className="badge good" style={{ marginLeft: 8 }}>Watching</span>}
      </form>
      {cabins.some((c) => upgrades.find((u) => u.cabin === c)) && (
        <table className="segments" style={{ marginTop: 12 }}>
          <thead><tr><th>Cabin</th><th>Price now</th><th>vs. what you paid</th><th>Lowest seen</th><th>Checked</th></tr></thead>
          <tbody>
            {cabins.map((cabin) => {
              const u = upgrades.find((x) => x.cabin === cabin);
              if (!u) return <tr key={cabin}><td>{UPGRADE_LABELS[cabin]}</td><td colSpan={4} className="muted">Not checked yet</td></tr>;
              const price = u.latest.currency === booking.currency ? u.latest.priceCents : null;
              const extra = price === null ? null : price - booking.paidCents;
              const within = extra !== null && watch && extra <= watch.maxExtraCents;
              return (
                <tr key={cabin}>
                  <td>{UPGRADE_LABELS[cabin]}{u.latest.note && price !== null ? <div className="muted small">{u.latest.note}</div> : null}</td>
                  <td>{price === null ? <span className="muted">{u.latest.note ?? "Not offered"}</span> : <b>{formatMoney(price, booking.currency)}</b>}</td>
                  <td>{extra === null ? "—" : <span className={within ? "badge good" : undefined}>{extra <= 0 ? `${formatMoney(-extra, booking.currency)} less` : `+${formatMoney(extra, booking.currency)}`}</span>}</td>
                  <td>{u.lowestCents === null ? "—" : formatMoney(u.lowestCents, booking.currency)}</td>
                  <td className="muted small">{formatTimestamp(u.latest.checkedAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {enabled && <p className="muted small">Each check uses up to {cabins.length + 1} extra Duffel searches (business falls back to first when an airline sells its top cabin as first).</p>}
    </section>
  );
}

function FlightDetailsCard({ booking }: { booking: FlightBooking }) {
  const f = booking.details;
  const cabins = sliceCabins(f);
  const brands = f.sliceFareBrands ?? f.slices.map(() => f.fareBrand);
  return (
    <section className="card">
      <h2>Flights</h2>
      {isMixedCabin(f) && (
        <p className="muted small">
          Different cabins each way: the price is checked as separate one-way fares in each cabin, added together. That&apos;s close to what
          the airline charges but an estimate, so confirm on the airline&apos;s site before rebooking.
        </p>
      )}
      <table className="segments">
        <thead><tr><th>Flight</th><th>From</th><th>To</th><th>Departs (local)</th><th>Arrives (local)</th><th>Cabin / fare</th></tr></thead>
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
                  {CABIN_LABELS[cabins[i]]}
                  {brands[i] && <span className="muted small"> · {brands[i]}</span>}
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
