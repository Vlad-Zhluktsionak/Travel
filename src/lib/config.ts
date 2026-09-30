export const config = {
  get appUrl() {
    return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
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
  /** Scheduled runs skip trips checked more recently than this, to stay inside free API quotas. */
  get checkIntervalHours() {
    const hours = Number(process.env.PRICE_CHECK_INTERVAL_HOURS ?? 12);
    return Number.isFinite(hours) && hours >= 0 ? hours : 12;
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
