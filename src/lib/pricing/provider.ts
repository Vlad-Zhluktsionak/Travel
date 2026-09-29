import type { Itinerary } from "../types";

export interface PriceQuote {
  /** Total for all passengers in minor units, or null when the exact flights couldn't be found. */
  priceCents: number | null;
  currency: string | null;
  note?: string;
}

export interface PriceProvider {
  readonly name: string;
  /** Price the exact same flights (all slices, same cabin, same party size). */
  quote(itinerary: Itinerary, context: { bookingKey: string; paidCents: number; currency: string }): Promise<PriceQuote>;
}
