import crypto from "node:crypto";
import type { PriceProvider } from "./provider";

/**
 * Simulated fares for demos and local development: a deterministic random walk around the price
 * paid that changes every 6 hours. Never use for real alerts.
 */
export class MockPriceProvider implements PriceProvider {
  readonly name = "mock";

  constructor(private readonly now: () => Date = () => new Date()) {}

  async quote(_itinerary: unknown, ctx: { bookingKey: string; paidCents: number; currency: string }) {
    const bucket = Math.floor(this.now().getTime() / (6 * 3600_000));
    const hash = crypto.createHash("sha256").update(`${ctx.bookingKey}:${bucket}`).digest();
    const noise = hash.readUInt32BE(0) / 0xffffffff; // 0..1
    const factor = 0.78 + noise * 0.34; // 78%..112% of the price paid
    return {
      priceCents: Math.round((ctx.paidCents * factor) / 100) * 100,
      currency: ctx.currency,
      note: "Simulated price (demo mode)",
    };
  }
}
