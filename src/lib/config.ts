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
  get databasePath() {
    return process.env.DATABASE_PATH ?? "./data/farewatch.db";
  },
  get priceProvider(): "duffel" | "mock" {
    const explicit = process.env.PRICE_PROVIDER;
    if (explicit === "duffel" || explicit === "mock") return explicit;
    return process.env.DUFFEL_ACCESS_TOKEN ? "duffel" : "mock";
  },
  get inboundDomain() {
    return process.env.INBOUND_DOMAIN ?? "in.example.com";
  },
  get inboundSecret() {
    return process.env.INBOUND_SECRET;
  },
  get cronSecret() {
    return process.env.CRON_SECRET;
  },
  get emailFrom() {
    return process.env.EMAIL_FROM ?? "FareWatch <alerts@example.com>";
  },
  /** Default minimum savings (in cents) before we alert. */
  defaultThresholdCents: 2000,
  isProduction: process.env.NODE_ENV === "production",
};
