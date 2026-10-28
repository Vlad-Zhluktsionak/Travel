import { config } from "../config";
import * as repo from "../repo";
import type { Segment } from "../types";
import { DuffelPriceProvider, type PremiumLegPricer } from "./duffel";
import { MockPriceProvider } from "./mock";
import type { FlightPriceProvider, HotelPriceProvider } from "./provider";
import { GOOGLE_TRAVEL_CLASS, GoogleFlightsLegPricer, type LegPrice } from "./serpapi-flights";
import { SerpApiHotelProvider } from "./serpapi-hotels";

export type { FlightPriceProvider, HotelPriceProvider, HotelQuote, PriceQuote } from "./provider";

export interface Providers {
  flight: FlightPriceProvider;
  hotel: HotelPriceProvider;
}

/**
 * Google Flights Premium lookups, each saved for `maxAgeHours` so the free SerpApi quota (shared with
 * hotels) isn't spent on every check. Failed lookups are saved too, so they aren't retried every run.
 */
export function cachedGooglePremium(pricer: GoogleFlightsLegPricer, maxAgeHours: number): PremiumLegPricer {
  return async (slice: Segment[], passengers: number, currency: string): Promise<LegPrice> => {
    const key = `google-premium|${slice.map((s) => `${s.carrier}${s.flightNumber}@${s.departureLocal.slice(0, 10)}`).join(">")}|${passengers}|${currency}`;
    const saved = await repo.getExternalQuote(key, maxAgeHours);
    if (saved) {
      return saved.priceCents !== null && saved.currency
        ? { cents: saved.priceCents, currency: saved.currency, note: saved.note ?? "Google Flights" }
        : { problem: `${saved.note ?? "No price"} (saved lookup; tried again after ${maxAgeHours}h)` };
    }
    let result: LegPrice;
    try {
      result = await pricer.price(slice, passengers, currency, GOOGLE_TRAVEL_CLASS.premium_economy);
    } catch (err) {
      // Network trouble: report it, but don't save it, so the next check tries again.
      return { problem: `Google Flights lookup failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if ("problem" in result) await repo.saveExternalQuote(key, null, null, result.problem);
    else await repo.saveExternalQuote(key, result.cents, result.currency, result.note);
    return result;
  };
}

export function getProviders(): Providers {
  const mock = new MockPriceProvider();
  const serpKey = process.env.SERPAPI_API_KEY;
  const premiumFallback = serpKey ? cachedGooglePremium(new GoogleFlightsLegPricer(serpKey), config.googleFlightsCacheHours) : undefined;
  const flight =
    config.flightPriceProvider === "duffel"
      ? new DuffelPriceProvider(process.env.DUFFEL_ACCESS_TOKEN ?? "", fetch, premiumFallback)
      : mock;
  const hotel = config.hotelPriceProvider === "serpapi" ? new SerpApiHotelProvider(serpKey!) : mock;
  return { flight, hotel };
}
