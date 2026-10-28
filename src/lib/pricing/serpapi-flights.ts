import type { Segment } from "../types";

/**
 * One-way fares for specific flights from Google Flights via SerpApi
 * (https://serpapi.com/google-flights-api). Used for fares Duffel doesn't sell, such as Alaska's
 * Premium Class, which Google lists in its premium economy class.
 */

interface GoogleFlightLeg {
  departure_airport?: { id?: string; time?: string };
  arrival_airport?: { id?: string };
  flight_number?: string;
  airline?: string;
  travel_class?: string;
}

interface GoogleItinerary {
  flights?: GoogleFlightLeg[];
  /** Total for all passengers in the requested currency. */
  price?: number;
}

export interface GoogleFlightsResponse {
  error?: string;
  best_flights?: GoogleItinerary[];
  other_flights?: GoogleItinerary[];
}

/** Google's travel_class codes. */
export const GOOGLE_TRAVEL_CLASS = { economy: 1, premium_economy: 2, business: 3, first: 4 } as const;

const flightNo = (s: string) => {
  const m = s.replace(/\s+/g, "").match(/^([A-Z0-9]{2})0*(\d{1,4})$/i);
  return m ? `${m[1].toUpperCase()}${m[2]}` : s.replace(/\s+/g, "").toUpperCase();
};

/** The listed itinerary flying exactly these segments, if any. */
export function findExactItinerary(response: GoogleFlightsResponse, slice: Segment[]): GoogleItinerary | null {
  const wanted = slice.map((s) => `${s.carrier}${s.flightNumber}|${s.origin}|${s.destination}`);
  for (const it of [...(response.best_flights ?? []), ...(response.other_flights ?? [])]) {
    const legs = it.flights ?? [];
    if (legs.length !== slice.length || typeof it.price !== "number") continue;
    const have = legs.map((l) => `${flightNo(l.flight_number ?? "")}|${l.departure_airport?.id ?? ""}|${l.arrival_airport?.id ?? ""}`);
    if (have.every((h, i) => h === wanted[i])) return it;
  }
  return null;
}

export type LegPrice = { cents: number; currency: string; note: string } | { problem: string };

export class GoogleFlightsLegPricer {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Price one direction of a trip, one way, in a given Google travel class. */
  async price(slice: Segment[], passengers: number, currency: string, travelClass: number): Promise<LegPrice> {
    const params = new URLSearchParams({
      engine: "google_flights",
      type: "2", // one way
      departure_id: slice[0].origin,
      arrival_id: slice[slice.length - 1].destination,
      outbound_date: slice[0].departureLocal.slice(0, 10),
      travel_class: String(travelClass),
      adults: String(passengers),
      stops: slice.length === 1 ? "1" : "0", // 1 = nonstop only (fewer results to match); 0 = any
      currency,
      hl: "en",
      gl: "us",
      api_key: this.apiKey,
    });
    const res = await this.fetchImpl(`https://serpapi.com/search.json?${params}`);
    const json = (await res.json()) as GoogleFlightsResponse;
    if (!res.ok || json.error) return { problem: `Google Flights lookup failed: ${json.error ?? `HTTP ${res.status}`}` };
    const match = findExactItinerary(json, slice);
    if (!match) {
      const count = (json.best_flights?.length ?? 0) + (json.other_flights?.length ?? 0);
      return { problem: `Google Flights didn't list your exact flight in this class (${count} other options listed).` };
    }
    const cls = match.flights?.[0]?.travel_class;
    return { cents: Math.round(match.price! * 100), currency, note: `Google Flights${cls ? ` ${cls}` : ""}` };
  }
}
