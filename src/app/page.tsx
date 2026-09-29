import Link from "next/link";
import { config } from "@/lib/config";
import { mailboxProviders } from "@/lib/email/mailbox";
import { formatLocal, formatMoney } from "@/lib/format";
import * as repo from "@/lib/repo";
import { currentUser } from "@/lib/session";
import type { Booking, User } from "@/lib/types";
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
        <h1>Booked a flight? Get money back when the price drops.</h1>
        <p className="muted">
          Forward your confirmation email or connect Gmail/Outlook. Our AI reads your itinerary, we re-check the fare for
          your exact flights several times a day, and email you the moment you can rebook for less.
        </p>
        {error && <p className="notice warn login">{error}</p>}
        <LoginForm />
      </section>
      <div className="grid">
        <div className="card"><h2>📨 Forward or connect</h2><p className="muted">Send confirmations to your personal address, paste them in, or let us find them in your inbox (read-only).</p></div>
        <div className="card"><h2>🤖 AI itinerary parsing</h2><p className="muted">Claude extracts flight numbers, dates, cabin, fare type and the price you paid — from any airline or travel site.</p></div>
        <div className="card"><h2>📉 Price-drop alerts</h2><p className="muted">When the same flights get cheaper, we tell you how much you can save and how to claim the difference.</p></div>
      </div>
    </>
  );
}

function Dashboard({ user, error, connected }: { user: User; error?: string; connected?: string }) {
  const bookings = repo.listBookings(user.id);
  const upcoming = bookings.filter((b) => b.status !== "departed");
  const past = bookings.filter((b) => b.status === "departed");
  const connections = repo.listConnections(user.id);
  const demo = config.priceProvider === "mock";

  return (
    <>
      {error && <p className="notice warn">{error}</p>}
      {connected && <p className="notice good">Mailbox connected — we&apos;re scanning it for flight confirmations now.</p>}
      {demo && (
        <p className="notice warn small">
          Demo mode: prices are simulated. Set <code>DUFFEL_ACCESS_TOKEN</code> to track live fares.
        </p>
      )}

      <section className="card">
        <h2>Your trips</h2>
        {upcoming.length === 0 ? (
          <p className="muted">No trips yet. Add one below — forward a confirmation, connect your inbox, or paste an email.</p>
        ) : (
          <div className="stack">{upcoming.map((b) => <TripRow key={b.id} booking={b} />)}</div>
        )}
      </section>

      <div className="grid">
        <section className="card">
          <h2>📨 Forward confirmations</h2>
          <p className="muted small">Forward any flight confirmation email to your personal address:</p>
          <div className="code">{repo.forwardingAddress(user)}</div>
          <p className="muted small">Or just forward from <b>{user.email}</b> to it — we&apos;ll recognize you.</p>
        </section>

        <section className="card">
          <h2>📬 Connect your inbox</h2>
          <p className="muted small">Read-only access. We only look at booking confirmation emails.</p>
          <div className="stack">
            {connections.map((c) => (
              <div key={c.id} className="row">
                <span className="badge good">{mailboxProviders[c.provider].label}</span>
                <span className="small">{c.accountEmail}</span>
                <form action={syncMailbox}><input type="hidden" name="connectionId" value={c.id} /><button className="secondary" type="submit">Scan now</button></form>
                <form action={disconnectMailbox}><input type="hidden" name="connectionId" value={c.id} /><button className="danger" type="submit">Disconnect</button></form>
              </div>
            ))}
            <div className="row">
              <a className="button secondary" href="/api/connect/gmail">Connect Gmail</a>
              <a className="button secondary" href="/api/connect/outlook">Connect Outlook</a>
            </div>
          </div>
        </section>
      </div>

      <section className="card">
        <h2>📋 Paste a confirmation email</h2>
        <PasteForm />
      </section>

      <section className="card">
        <h2>🔔 Alert settings</h2>
        <form action={updateThreshold} className="row">
          <label htmlFor="threshold">Email me when I can save at least</label>
          <input id="threshold" type="number" name="threshold" min={0} step={1} defaultValue={user.alertThresholdCents / 100} style={{ width: 100 }} />
          <button className="secondary" type="submit">Save</button>
        </form>
      </section>

      {past.length > 0 && (
        <section className="card">
          <h2 className="muted">Past trips</h2>
          <div className="stack">{past.map((b) => <TripRow key={b.id} booking={b} />)}</div>
        </section>
      )}
    </>
  );
}

function TripRow({ booking }: { booking: Booking }) {
  const first = booking.slices[0][0];
  const outbound = booking.slices[0];
  const latest = repo.latestPriceCheck(booking.id);
  const comparable = latest && latest.currency === booking.currency ? latest.priceCents! : null;
  const savings = comparable !== null ? booking.paidCents - comparable : null;

  return (
    <Link href={`/trips/${booking.id}`} className="card trip" style={{ marginBottom: 0 }}>
      <div>
        <div className="route">
          {first.origin} → {outbound[outbound.length - 1].destination}
          {booking.slices.length > 1 && <span className="muted"> ⇄</span>}
        </div>
        <div className="muted small">
          {formatLocal(first.departureLocal)} · {booking.airline ?? first.carrier} · {booking.confirmationCode} · {booking.passengerCount} pax
        </div>
      </div>
      <div className="price">
        <div className="muted small">Paid {formatMoney(booking.paidCents, booking.currency)}</div>
        {comparable !== null ? (
          <div className="now">{formatMoney(comparable, booking.currency)}</div>
        ) : (
          <div className="muted small">Waiting for first price check</div>
        )}
        {booking.status === "paused" && <span className="badge">Paused</span>}
        {booking.status === "departed" && <span className="badge">Departed</span>}
        {savings !== null && booking.status === "active" &&
          (savings > 0 ? (
            <span className="badge good">Save {formatMoney(savings, booking.currency)}</span>
          ) : (
            <span className="badge">No drop yet</span>
          ))}
      </div>
    </Link>
  );
}
