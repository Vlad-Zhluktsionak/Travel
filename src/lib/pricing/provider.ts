import type { HotelDetails, Itinerary } from "../types";

export interface PriceQuote {
  /** Total in minor units, or null when the same product couldn't be found. */
  priceCents: number | null;
  currency: string | null;
  note?: string;
}

export interface QuoteContext {
  bookingKey: string;
  paidCents: number;
  currency: string;
}

export interface FlightPriceProvider {
  readonly name: string;
  /** Price the exact same flights (all slices, same cabin, same party size). */
  quote(itinerary: Itinerary, context: QuoteContext): Promise<PriceQuote>;
}

export interface HotelQuote extends PriceQuote {
  /** Set when the provider resolved the hotel's id, so it can be cached on the booking. */
  propertyToken?: string | null;
}

export interface HotelPriceProvider {
  readonly name: string;
  /** Price the same hotel, dates and party on the hotel's official site. */
  quote(hotel: HotelDetails, context: QuoteContext): Promise<HotelQuote>;
}
