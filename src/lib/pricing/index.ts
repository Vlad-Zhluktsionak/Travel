import { config } from "../config";
import { DuffelPriceProvider } from "./duffel";
import { MockPriceProvider } from "./mock";
import type { FlightPriceProvider, HotelPriceProvider } from "./provider";
import { SerpApiHotelProvider } from "./serpapi-hotels";

export type { FlightPriceProvider, HotelPriceProvider, HotelQuote, PriceQuote } from "./provider";

export interface Providers {
  flight: FlightPriceProvider;
  hotel: HotelPriceProvider;
}

export function getProviders(): Providers {
  const mock = new MockPriceProvider();
  const flight =
    config.flightPriceProvider === "duffel" ? new DuffelPriceProvider(process.env.DUFFEL_ACCESS_TOKEN ?? "") : mock;
  const hotel = config.hotelPriceProvider === "serpapi" ? new SerpApiHotelProvider(process.env.SERPAPI_API_KEY!) : mock;
  return { flight, hotel };
}
