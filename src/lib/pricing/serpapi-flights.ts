import { isPremiumName } from "../fares";
import type { Segment } from "../types";

/**
 * One-way fares for specific flights from Google Flights via SerpApi
 * (https://serpapi.com/google-flights-api). Used for Premium fares Duffel doesn't sell.
 *
 * Google shows a true premium economy cabin under its "premium economy" class, but extra-legroom
 * products sold in the economy cabin (e.g. Alaska Premium Class) only as a fare option of the flight's
 * economy listing, which takes a second request with the flight's booking_token.
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
  /** For one-way results: opens the flight's fare options. */
  booking_token?: string;
}

/** One way to buy the flight, e.g. Alaska's "Saver" / "Main" / "Premium" / "First" fare options. */
export interface GoogleBookingOption {
  book_with?: string;
  option_title?: string;
  price?: number;
  extensions?: string[];
}

export interface GoogleFlightsResponse {
  error?: string;
  best_flights?: GoogleItinerary[];
  other_flights?: GoogleItinerary[];
  booking_options?: { together?: GoogleBookingOption; separate_tickets?: boolean }[];
}

/** Airlines whose Premium is an extra-legroom fare in the economy cabin, not a separate cabin. */
const PREMIUM_IN_ECONOMY_CABIN = new Set(["AS", "HA", "B6", "WN"]);

/** The cheapest Premium fare option on a flight's booking page. */
export function cheapestPremiumOption(response: GoogleFlightsResponse, carrier: string): GoogleBookingOption | null {
  let best: GoogleBookingOption | null = null;
  for (const o of response.booking_options ?? []) {
    const t = o.together;
    if (!t || typeof t.price !== "number" || o.separate_tickets) continue;
    if (!isPremiumName(t.option_title ?? null, carrier)) continue;
    if (!best || t.price < best.price!) best = t;
  }
  return best;
}

export function describeOptions(response: GoogleFlightsResponse, currency: string): string {
  const fmt = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);
  return (response.booking_options ?? [])
    .map((o) => o.together)
    .filter((t): t is GoogleBookingOption => !!t)
    .slice(0, 6)
    .map((t) => `${t.option_title ?? "untitled"}${t.book_with ? ` via ${t.book_with}` : ""} ${typeof t.price === "number" ? fmt(t.price) : "no price"}`)
    .join("; ");
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

  private async search(extra: Record<string, string>, slice: Segment[], passengers: number, currency: string): Promise<GoogleFlightsResponse> {
    const params = new URLSearchParams({
      engine: "google_flights",
      type: "2", // one way
      departure_id: slice[0].origin,
      arrival_id: slice[slice.length - 1].destination,
      outbound_date: slice[0].departureLocal.slice(0, 10),
      adults: String(passengers),
      stops: slice.length === 1 ? "1" : "0", // 1 = nonstop only (fewer results to match); 0 = any
      currency,
      hl: "en",
      gl: "us",
      ...extra,
      api_key: this.apiKey,
    });
    const res = await this.fetchImpl(`https://serpapi.com/search.json?${params}`);
    const json = (await res.json()) as GoogleFlightsResponse;
    if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
    return json;
  }

  private notListed(json: GoogleFlightsResponse, slice: Segment[], currency: string, cls: string): string {
    const listed = describeListings(json, currency);
    const yours = slice.map((g) => `${g.carrier} ${g.flightNumber} ${g.departureLocal.replace("T", " ")}`).join(" + ");
    return listed
      ? `Google Flights didn't list your flight (${yours}) in ${cls}. It listed: ${listed}.`
      : `Google Flights listed no flights in ${cls} for that day.`;
  }

  /** Price one direction in a given Google travel class (the listed price for your exact flight). */
  async price(slice: Segment[], passengers: number, currency: string, travelClass: number): Promise<LegPrice> {
    let json: GoogleFlightsResponse;
    try {
      json = await this.search({ travel_class: String(travelClass) }, slice, passengers, currency);
    } catch (err) {
      return { problem: `Google Flights lookup failed: ${(err as Error).message}` };
    }
    const match = findExactItinerary(json, slice);
    if (!match) return { problem: this.notListed(json, slice, currency, "that class") };
    const cls = match.flights?.[0]?.travel_class;
    return { cents: Math.round(match.price! * 100), currency, note: `Google Flights${cls ? ` ${cls}` : ""}` };
  }

  /**
   * Price Premium on one direction. Airlines with a separate premium economy cabin are tried in Google's
   * premium economy class first (1 search); otherwise — or if that misses — find the flight in economy and
   * take the Premium fare option from its booking page (2 searches).
   */
  async premium(slice: Segment[], passengers: number, currency: string): Promise<LegPrice> {
    const carrier = slice[0].carrier;
    let first: LegPrice | null = null;
    if (!PREMIUM_IN_ECONOMY_CABIN.has(carrier)) {
      first = await this.price(slice, passengers, currency, GOOGLE_TRAVEL_CLASS.premium_economy);
      if (!("problem" in first)) return first;
    }

    let economy: GoogleFlightsResponse;
    try {
      economy = await this.search({ travel_class: String(GOOGLE_TRAVEL_CLASS.economy) }, slice, passengers, currency);
    } catch (err) {
      return { problem: `Google Flights lookup failed: ${(err as Error).message}` };
    }
    const flight = findExactItinerary(economy, slice);
    if (!flight) return { problem: this.notListed(economy, slice, currency, "economy") };
    if (!flight.booking_token) return { problem: "Google Flights found your flight but gave no way to open its fare options." };

    let options: GoogleFlightsResponse;
    try {
      options = await this.search({ travel_class: String(GOOGLE_TRAVEL_CLASS.economy), booking_token: flight.booking_token }, slice, passengers, currency);
    } catch (err) {
      return { problem: `Google Flights fare options failed: ${(err as Error).message}` };
    }
    const premium = cheapestPremiumOption(options, carrier);
    if (!premium) {
      const seen = describeOptions(options, currency);
      return { problem: `Google Flights found your flight, but no Premium fare option${seen ? `. Options shown: ${seen}` : " was listed"}.` };
    }
    return {
      cents: Math.round(premium.price! * 100),
      currency,
      note: `Google Flights: ${premium.option_title}${premium.book_with ? ` via ${premium.book_with}` : ""}`,
    };
  }
}
