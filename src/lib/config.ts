export const config = {
  get appUrl() {
    let url = (process.env.APP_URL ?? "http://localhost:3000").trim().replace(/\/+$/, "");
    // Tolerate "my-app.vercel.app" without a scheme: redirects and email links need an absolute URL.
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    return url;
  },
  get sessionSecret() {
    const secret = process.env.SESSION_SECRET;
    if (!secret) {
      if (process.env.NODE_ENV === "production") {
        throw new Error("SESSION_SECRET must be set in production");
      }
      return "dev-only-insecure-secret";
    }
    return secret;
  },
  /** `libsql://…turso.io` for Turso, or `file:path.db` for a local SQLite file. */
  get databaseUrl() {
    return process.env.DATABASE_URL ?? "file:./data/farewatch.db";
  },
  /** Comma-separated emails allowed to sign in. Empty = anyone (fine locally, not when deployed). */
  get allowedEmails(): string[] {
    return (process.env.ALLOWED_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
  },
  get flightPriceProvider(): "duffel" | "mock" {
    const explicit = process.env.PRICE_PROVIDER;
    if (explicit === "duffel" || explicit === "mock") return explicit;
    return process.env.DUFFEL_ACCESS_TOKEN ? "duffel" : "mock";
  },
  get hotelPriceProvider(): "serpapi" | "mock" {
    return process.env.SERPAPI_API_KEY ? "serpapi" : "mock";
  },
  /**
   * Scheduled runs skip trips checked more recently than this many hours. The scheduler fires every
   * 6 hours, so the defaults sit an hour under 6 and 12 to tolerate schedule jitter: flights are
   * re-priced every run, hotels every other run (to stay inside SerpApi's free search quota).
   */
  checkIntervalHours(kind: "flight" | "hotel"): number {
    const raw = kind === "flight" ? process.env.FLIGHT_CHECK_INTERVAL_HOURS : process.env.HOTEL_CHECK_INTERVAL_HOURS;
    const fallback = kind === "flight" ? 5 : 11;
    const hours = Number(raw ?? fallback);
    return Number.isFinite(hours) && hours >= 0 ? hours : fallback;
  },
  get inboundDomain() {
    return process.env.INBOUND_DOMAIN || "in.example.com";
  },
  get inboundSecret() {
    return process.env.INBOUND_SECRET;
  },
  get cronSecret() {
    return process.env.CRON_SECRET;
  },
  get emailFrom() {
    return process.env.EMAIL_FROM ?? "FareWatch <onboarding@resend.dev>";
  },
  /** Default minimum savings (in cents) before we alert. */
  defaultThresholdCents: 2000,
  isProduction: process.env.NODE_ENV === "production",
};
