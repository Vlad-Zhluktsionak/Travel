# ✈️🏨 FareWatch

Get money back when your flight or hotel gets cheaper. FareWatch:

1. **Picks up your confirmation emails** automatically from Gmail (via a small Apps Script), or you paste one in.
2. **Reads them with AI.** Claude extracts flight numbers, dates, cabin and fare type, or the hotel, dates, room, rate, cancellation terms, plus the price you paid.
3. **Re-checks the price** of the exact same flights, or of the same hotel stay **on the hotel's official website** (Marriott, Hilton, Hyatt, IHG, ...). Hotel stays booked through Expedia, Booking.com or other aggregators are not tracked.
4. **Emails you when the price drops** by more than your threshold, with how to claim the difference. Non-refundable hotel rates are still reported, but flagged "can't rebook".

## How it works

```
 Gmail (Apps Script) ─┐                                             ┌─> price history chart
 Pasted email ────────┼─> Claude extraction ─> bookings ─> monitor ─┤
 Forwarding / OAuth ──┘   (flight | hotel)       (Turso)    │       └─> alert email (Resend)
                                                            ├ flights: Duffel
                                                            └ hotels:  SerpApi Google Hotels (official site only)
        GitHub Actions (every 6 h) ──> /api/cron/check-prices
```

| Piece | Where |
| --- | --- |
| AI extraction (Claude structured outputs + validation) | `src/lib/extract.ts` |
| Gmail auto-import script | `scripts/gmail-apps-script.gs` |
| Inbound webhook (Apps Script, Postmark, SendGrid, Mailgun) | `src/app/api/inbound-email/route.ts` |
| Hotel prices, official site only | `src/lib/pricing/serpapi-hotels.ts` |
| Flight prices | `src/lib/pricing/duffel.ts` |
| Monitor, alert rules and emails | `src/lib/monitor.ts`, `src/lib/advice.ts` |
| Scheduler | `.github/workflows/check-prices.yml` |
| Database (Turso / local SQLite via libSQL) | `src/lib/db.ts`, `src/lib/repo.ts` |
| Web UI (Next.js) | `src/app/` |

**Alert rules:** you get an alert when `paid − current ≥ your threshold` (default $20). After an alert, you only get another one if the price falls at least $5 further. Prices in a different currency are recorded but never compared. Tracking stops on the departure or check-in date. Scheduled checks re-price flights about every 6 hours and hotels about every 12 hours (minimum gaps set by `FLIGHT_CHECK_INTERVAL_HOURS`, default 5, and `HOTEL_CHECK_INTERVAL_HOURS`, default 11, just under the 6-hour schedule to absorb its jitter). The "Check price now" button ignores that limit.

## Run it locally

Requires Node.js 22+.

```bash
npm install
cp .env.example .env.local   # set ANTHROPIC_API_KEY; the rest is optional locally
npm run dev                  # http://localhost:3000
```

With no other keys set, prices are simulated, the sign-in link appears on the page, and emails are printed to the terminal.

```bash
npm test          # unit tests (no network or API keys needed)
npm run lint      # type-check
npm run monitor   # run the scheduled job once
```

## Free personal setup (≈30 minutes)

Everything below has a free tier. The only paid piece is the Claude API, where reading each confirmation email costs a few cents.

1. **Claude API key.** Create one at [console.anthropic.com](https://console.anthropic.com) and add a few dollars of credit → `ANTHROPIC_API_KEY`.
2. **Database: [Turso](https://turso.tech).** Create a database, then copy its URL (`libsql://…`) → `DATABASE_URL` and an auth token → `DATABASE_AUTH_TOKEN`.
3. **Hotel prices: [SerpApi](https://serpapi.com).** Copy your API key → `SERPAPI_API_KEY`. The free plan has a small monthly search quota (check their pricing page). Each hotel check uses 1 search, plus 1 extra the first time to find the hotel. At the default 12-hour interval, one tracked hotel uses about 60 searches a month; raise `HOTEL_CHECK_INTERVAL_HOURS` if you track several.
4. **Flight prices: [Duffel](https://duffel.com)** (optional, can be added later — leave `DUFFEL_ACCESS_TOKEN` unset rather than setting a placeholder). Copy an access token → `DUFFEL_ACCESS_TOKEN`. Test-mode tokens only return fake airlines, so real prices need a live-mode token. Without one, flight prices stay simulated.
5. **Email: [Resend](https://resend.com).** Copy your API key → `RESEND_API_KEY`. Without your own domain, Resend only delivers to the email you signed up with, which is fine for personal use. Keep `EMAIL_FROM="FareWatch <onboarding@resend.dev>"`.
6. **Hosting: [Vercel](https://vercel.com) (Hobby plan).** Import this GitHub repo and set the environment variables:
   `APP_URL` (your `https://….vercel.app` URL), `SESSION_SECRET`, `ALLOWED_EMAILS` (your Gmail address), `INBOUND_SECRET`, `CRON_SECRET`, plus the keys above.
7. **Scheduler: GitHub Actions.** In the repo, open Settings → Secrets and variables → Actions and add `APP_URL` and `CRON_SECRET`. The workflow runs every 6 hours. You can also start it by hand from the Actions tab.
8. **Gmail auto-import.** Open `scripts/gmail-apps-script.gs` and follow the steps at the top: paste it into [script.google.com](https://script.google.com), fill in `APP_URL` and `INBOUND_SECRET`, and run `setup`.
9. **iPhone.** Open your app URL in Safari, tap Share → **Add to Home Screen**, and sign in with your Gmail address.

## Notes

- Hotel prices come from Google Hotels search results, not directly from the chains, so occasionally the official site may show a slightly different price. Always confirm the price on the official site before rebooking.
- Direct Gmail/Outlook OAuth connections are also supported (`GOOGLE_*` / `MICROSOFT_*`), but for personal use the Apps Script is simpler. Unverified Google OAuth apps must be reconnected every 7 days. Refresh tokens are stored unencrypted.
