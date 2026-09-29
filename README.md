# ✈️ FareWatch

Get money back when your flight gets cheaper. Forward a flight confirmation email (or connect Gmail/Outlook), and FareWatch:

1. **Reads the itinerary with AI.** Claude extracts the confirmation code, exact flight numbers, dates, cabin, fare brand, passenger count and the price you paid — from any airline or travel-site email.
2. **Re-prices the exact same flights** several times a day (same flights, same cabin, same party size; basic-economy fares are excluded unless you booked one).
3. **Emails you when the price drops** below what you paid by more than your threshold, with airline-specific advice on how to claim the difference (for example, rebook for a travel credit).

## How it works

```
 Forwarded email ─┐                                          ┌─> price_checks (history chart)
 Gmail / Outlook ─┼─> normalize ─> Claude extraction ─> bookings ─> monitor (cron) ─┤
 Pasted email ────┘   (HTML→text)   (structured output)          │ PriceProvider   └─> alerts ─> email
                                                                 └ Duffel | mock
```

| Piece | Where |
| --- | --- |
| AI itinerary extraction (Claude, structured outputs + validation) | `src/lib/extract.ts` |
| Inbound-email webhook (Postmark, SendGrid, Mailgun) | `src/app/api/inbound-email/route.ts` |
| Gmail / Outlook OAuth + mailbox scan | `src/lib/email/mailbox.ts`, `src/lib/email/sync.ts`, `src/app/api/connect/…` |
| Price providers (Duffel live fares, simulated demo) | `src/lib/pricing/` |
| Price monitor + alert rules | `src/lib/monitor.ts` |
| Rebooking advice per airline | `src/lib/airlines.ts` |
| Scheduled job (Vercel Cron or `npm run monitor`) | `src/app/api/cron/check-prices/route.ts`, `vercel.json` |
| Database (SQLite via Node's built-in `node:sqlite`) | `src/lib/db.ts`, `src/lib/repo.ts` |
| Web UI (Next.js App Router) | `src/app/` |

**Alert rules:** alert when `paid − current ≥ your threshold` (default $20). After an alert, only alert again if the price falls at least another $5. Quotes in a different currency are recorded but never compared. Trips stop being checked after the first flight's departure date.

## Run it locally

Requires Node.js 22.13+.

```bash
npm install
cp .env.example .env.local   # then set ANTHROPIC_API_KEY
npm run dev                  # http://localhost:3000
```

Without other keys the app runs in **demo mode**: sign-in links are shown on the page instead of emailed, emails are logged to the console, and prices are simulated. Paste a confirmation email into the dashboard to try it end to end, then use **Check price now** on the trip page.

```bash
npm test       # unit tests (no network or API key needed)
npm run lint   # type-check
npm run monitor   # run the mailbox sync + price check job once
```

## Going to production

| Feature | What to set up |
| --- | --- |
| AI parsing | `ANTHROPIC_API_KEY` |
| Live fares | A [Duffel](https://duffel.com) account → `DUFFEL_ACCESS_TOKEN` |
| Outgoing email | A [Resend](https://resend.com) account with a verified domain → `RESEND_API_KEY`, `EMAIL_FROM` |
| Forwarding address | An inbound-email service (Postmark Inbound, SendGrid Inbound Parse, or Mailgun Routes) for `INBOUND_DOMAIN`, posting to `https://<app>/api/inbound-email?secret=<INBOUND_SECRET>` |
| Gmail | A Google Cloud OAuth client with the `gmail.readonly` scope and redirect URI `https://<app>/api/connect/gmail/callback`. Restricted scope: Google requires app verification (and a security assessment) before public launch. |
| Outlook | A Microsoft Entra app registration with `Mail.Read`, `User.Read`, `offline_access`, and redirect URI `https://<app>/api/connect/outlook/callback` |
| Scheduling | `CRON_SECRET` + `vercel.json` (every 6 hours), or call `npm run monitor` from any scheduler |
| Sessions | A long random `SESSION_SECRET`, and `APP_URL` set to your public https URL |

**Database note:** SQLite is fine on a single server or VM with a persistent disk. For serverless hosting (e.g. Vercel), move `src/lib/db.ts` / `src/lib/repo.ts` to a hosted Postgres; all SQL lives in `repo.ts`.

**Security note:** mailbox refresh tokens are stored in the database as plain text. Encrypt them at rest (e.g. with a KMS key) before storing real users' tokens.

## Ideas for next steps

- Mobile app / push notifications
- One-tap rebooking links and tracking of credits earned
- Hotel and rental-car price tracking with the same pipeline
- Multi-currency conversion for bookings made in a foreign currency
