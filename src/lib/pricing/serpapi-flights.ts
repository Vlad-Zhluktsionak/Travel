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

const AIRLINE_NAMES: Record<string, RegExp> = {
  AS: /alaska/i, HA: /hawaiian/i, AA: /american/i, DL: /delta/i, UA: /united/i, B6: /jetblue/i, WN: /southwest/i,
};

/** "2031-01-15 10:13" / "2031-01-15T10:13" → "2031-01-15T10:13" */
const minute = (t: string | undefined) => (t ?? "").replace(" ", "T").slice(0, 16);

/** Same flight? By flight number, or (if Google writes it differently) same airline, airports and departure minute. */
function sameLeg(leg: GoogleFlightLeg, seg: Segment): boolean {
  const airportsMatch = leg.departure_airport?.id === seg.origin && leg.arrival_airport?.id === seg.destination;
  if (!airportsMatch) return false;
  if (flightNo(leg.flight_number ?? "") === `${seg.carrier}${seg.flightNumber}`) return true;
  const sameAirline =
    (leg.flight_number ?? "").toUpperCase().startsWith(seg.carrier) || (AIRLINE_NAMES[seg.carrier]?.test(leg.airline ?? "") ?? false);
  return sameAirline && minute(leg.departure_airport?.time) === minute(seg.departureLocal);
}

/** The listed itinerary flying exactly these segments (with a price), if any. */
export function findExactItinerary(response: GoogleFlightsResponse, slice: Segment[]): GoogleItinerary | null {
  for (const it of [...(response.best_flights ?? []), ...(response.other_flights ?? [])]) {
    const legs = it.flights ?? [];
    if (legs.length !== slice.length || typeof it.price !== "number") continue;
    if (legs.every((l, i) => sameLeg(l, slice[i]))) return it;
  }
  return null;
}

/** Short description of what Google listed, for diagnosing a non-match. */
export function describeListings(response: GoogleFlightsResponse, currency: string): string {
  const all = [...(response.best_flights ?? []), ...(response.other_flights ?? [])];
  return all
    .slice(0, 4)
    .map((it) => {
      const legs = (it.flights ?? [])
        .map((l) => `${l.flight_number ?? "?"} ${l.departure_airport?.id ?? "?"}→${l.arrival_airport?.id ?? "?"} ${minute(l.departure_airport?.time).replace("T", " ") || "?"}${l.travel_class ? ` (${l.travel_class})` : ""}`)
        .join(" + ");
      const price = typeof it.price === "number" ? new Intl.NumberFormat("en-US", { style: "currency", currency }).format(it.price) : "no price";
      return `${legs} ${price}`;
    })
    .join("; ");
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
      const listed = describeListings(json, currency);
      return {
        problem: listed
          ? `Google Flights didn't match your flight (${slice.map((g) => `${g.carrier} ${g.flightNumber} ${g.departureLocal.replace("T", " ")}`).join(" + ")}). It listed: ${listed}.`
          : "Google Flights listed no flights in this class for that day.",
      };
    }
    const cls = match.flights?.[0]?.travel_class;
    return { cents: Math.round(match.price! * 100), currency, note: `Google Flights${cls ? ` ${cls}` : ""}` };
  }
}
