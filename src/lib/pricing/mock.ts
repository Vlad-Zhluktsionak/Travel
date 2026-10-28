import crypto from "node:crypto";
import type { FlightPriceProvider, HotelPriceProvider, QuoteContext } from "./provider";

/**
 * Simulated prices for demos and local development: a deterministic random walk around the price
 * paid that changes every 6 hours. Never use for real alerts.
 */
export class MockPriceProvider implements FlightPriceProvider, HotelPriceProvider {
  readonly name = "mock";

  constructor(private readonly now: () => Date = () => new Date()) {}

  async quote(item: unknown, ctx: QuoteContext) {
    const bucket = Math.floor(this.now().getTime() / (6 * 3600_000));
    const hash = crypto.createHash("sha256").update(`${ctx.bookingKey}:${bucket}`).digest();
    const noise = hash.readUInt32BE(0) / 0xffffffff; // 0..1
    // Upgrade cabins are priced relative to an economy booking (the common case for the demo).
    const it = item as { cabin?: string; sliceCabins?: string[] } | null;
    const cabins = it?.sliceCabins?.length ? it.sliceCabins : it?.cabin ? [it.cabin] : [];
    const markup = (c: string) => (c === "premium_economy" ? 1.45 : c === "business" ? 2.4 : c === "first" ? 3.2 : 1);
    const cabinFactor = cabins.length ? cabins.reduce((sum, c) => sum + markup(c), 0) / cabins.length : 1;
    const factor = cabinFactor * (0.78 + noise * 0.34); // 78%..112% of the price paid (times the cabin markup)
    return {
      priceCents: Math.round((ctx.paidCents * factor) / 100) * 100,
      currency: ctx.currency,
      note: "Simulated price (demo mode)",
    };
  }
}
