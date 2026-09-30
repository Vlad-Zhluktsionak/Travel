import Link from "next/link";
import { config } from "@/lib/config";
import { mailboxProviders } from "@/lib/email/mailbox";
import { formatDate, formatLocal, formatMoney } from "@/lib/format";
import { nightsBetween } from "@/lib/pricing/serpapi-hotels";
import * as repo from "@/lib/repo";
import { currentUser } from "@/lib/session";
import type { Booking, PriceCheck, User } from "@/lib/types";
import { disconnectMailbox, syncMailbox, updateThreshold } from "./actions";
import { LoginForm, PasteForm } from "./forms";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  "link-expired": "That sign-in link is invalid or has expired. Request a new one.",
  "connect-failed": "We couldn't connect your mailbox. Please try again.",
  "gmail-not-configured": "Gmail connection isn't configured on this server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).",
  "outlook-not-configured": "Outlook connection isn't configured on this server (MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET).",
};

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  const user = await currentUser();
  const error = params.error ? ERRORS[params.error] : undefined;
  return user ? <Dashboard user={user} error={error} connected={params.connected} /> : <Landing error={error} />;
}

function Landing({ error }: { error?: string }) {
  return (
    <>
      <section className="hero">
        <h1>Booked a flight or hotel? Get money back when the price drops.</h1>
        <p className="muted">
          Your confirmation emails are read by AI, the price of your exact flights or room is re-checked on the
          official site, and you get an email the moment you can rebook for less.
        </p>
        {error && <p className="notice warn login">{error}</p>}
        <LoginForm />
      </section>
      <div className="grid">
        <div className="card"><h2>📨 Automatic import</h2><p className="muted">New confirmations in your Gmail are picked up automatically — or paste one in.</p></div>
        <div className="card"><h2>🤖 AI parsing</h2><p className="muted">Claude reads flight numbers, hotel dates, room and rate type, cancellation terms and the price you paid.</p></div>
        <div className="card"><h2>📉 Price-drop alerts</h2><p className="muted">When the same flights or room get cheaper, you get an email with how much you&apos;d save and how to claim it.</p></div>
      </div>
    </>
  );
}

async function Dashboard({ user, error, connected }: { user: User; error?: string; connected?: string }) {
  const bookings = await repo.listBookings(user.id);
  const latest = new Map(await Promise.all(bookings.map(async (b) => [b.id, await repo.latestPriceCheck(b.id)] as const)));
  const upcoming = bookings.filter((b) => b.status !== "departed");
  const past = bookings.filter((b) => b.status === "departed").reverse();
  const connections = await repo.listConnections(user.id);
  const demo = [
    config.flightPriceProvider === "mock" && "flight prices (set DUFFEL_ACCESS_TOKEN)",
    config.hotelPriceProvider === "mock" && "hotel prices (set SERPAPI_API_KEY)",
  ].filter(Boolean);
  const oauthProviders = Object.values(mailboxProviders).filter((p) => p.isConfigured());
  const forwardingConfigured = config.inboundDomain !== "in.example.com";

  return (
    <>
      {error && <p className="notice warn">{error}</p>}
      {connected && <p className="notice good">Mailbox connected — we&apos;re scanning it for confirmations now.</p>}
      {demo.length > 0 && <p className="notice warn small">Demo mode — simulated {demo.join(" and ")}.</p>}

      <section className="card">
        <h2>Your trips</h2>
        {upcoming.length === 0 ? (
          <p className="muted">No trips yet. New confirmations in Gmail are imported automatically once the script is set up — or paste one below.</p>
        ) : (
          <div className="stack">{upcoming.map((b) => <TripRow key={b.id} booking={b} latest={latest.get(b.id) ?? null} />)}</div>
        )}
      </section>

      <section className="card">
        <h2>📋 Paste a confirmation email</h2>
        <PasteForm />
      </section>

      <div className="grid">
        <section className="card">
          <h2>📨 Gmail auto-import</h2>
          <p className="muted small">
            A small Google Apps Script in your Gmail sends new flight and hotel confirmations here every 15 minutes.
            Setup steps are in <code>scripts/gmail-apps-script.gs</code>.
          </p>
          {forwardingConfigured && (
            <>
              <p className="muted small">Or forward confirmations to:</p>
              <div className="code">{repo.forwardingAddress(user)}</div>
            </>
          )}
          {(connections.length > 0 || oauthProviders.length > 0) && (
            <div className="stack" style={{ marginTop: 12 }}>
              {connections.map((c) => (
                <div key={c.id} className="row">
                  <span className="badge good">{mailboxProviders[c.provider].label}</span>
                  <span className="small">{c.accountEmail}</span>
                  <form action={syncMailbox}><input type="hidden" name="connectionId" value={c.id} /><button className="secondary" type="submit">Scan now</button></form>
                  <form action={disconnectMailbox}><input type="hidden" name="connectionId" value={c.id} /><button className="danger" type="submit">Disconnect</button></form>
                </div>
              ))}
              <div className="row">
                {oauthProviders.map((p) => (
                  <a key={p.id} className="button secondary" href={`/api/connect/${p.id}`}>Connect {p.label}</a>
                ))}
              </div>
            </div>
          )}
        </section>

        <section className="card">
          <h2>🔔 Alert settings</h2>
          <form action={updateThreshold} className="row">
            <label htmlFor="threshold">Email me when I can save at least $</label>
            <input id="threshold" type="number" name="threshold" min={0} step={1} defaultValue={user.alertThresholdCents / 100} style={{ width: 100 }} />
            <button className="secondary" type="submit">Save</button>
          </form>
          <p className="muted small">Flight prices are checked about every 6 hours, hotel prices about every 12 hours.</p>
        </section>
      </div>

      {past.length > 0 && (
        <section className="card">
          <h2 className="muted">Past trips</h2>
          <div className="stack">{past.map((b) => <TripRow key={b.id} booking={b} latest={latest.get(b.id) ?? null} />)}</div>
        </section>
      )}
    </>
  );
}

function TripRow({ booking, latest }: { booking: Booking; latest: PriceCheck | null }) {
  const comparable = latest && latest.currency === booking.currency ? latest.priceCents! : null;
  const savings = comparable !== null ? booking.paidCents - comparable : null;
  const nonRefundable = booking.kind === "hotel" && booking.details.refundable === false;

  let title: React.ReactNode;
  let subtitle: string;
  if (booking.kind === "hotel") {
    const h = booking.details;
    title = <>🏨 {h.hotelName}</>;
    subtitle = [`${formatDate(h.checkIn)} · ${nightsBetween(h.checkIn, h.checkOut)} nights`, h.city, booking.confirmationCode].filter(Boolean).join(" · ");
  } else {
    const f = booking.details;
    const out = f.slices[0];
    title = <>✈️ {out[0].origin} → {out[out.length - 1].destination}{f.slices.length > 1 && <span className="muted"> ⇄</span>}</>;
    subtitle = `${formatLocal(out[0].departureLocal)} · ${f.airline ?? out[0].carrier} · ${booking.confirmationCode} · ${f.passengerCount} pax`;
  }

  return (
    <Link href={`/trips/${booking.id}`} className="card trip" style={{ marginBottom: 0 }}>
      <div>
        <div className="route">{title}</div>
        <div className="muted small">{subtitle}</div>
      </div>
      <div className="price">
        <div className="muted small">Paid {formatMoney(booking.paidCents, booking.currency)}</div>
        {comparable !== null ? (
          <div className="now">{formatMoney(comparable, booking.currency)}</div>
        ) : (
          <div className="muted small">Waiting for first price check</div>
        )}
        {booking.status === "paused" && <span className="badge">Paused</span>}
        {booking.status === "departed" && <span className="badge">Past</span>}
        {savings !== null && booking.status === "active" &&
          (savings > 0 ? (
            <span className={`badge ${nonRefundable ? "warn" : "good"}`}>
              {nonRefundable
                ? `${formatMoney(savings, booking.currency)} lower · can't rebook`
                : `Save ${formatMoney(savings, booking.currency)}`}
            </span>
          ) : (
            <span className="badge">No drop yet</span>
          ))}
      </div>
    </Link>
  );
}
