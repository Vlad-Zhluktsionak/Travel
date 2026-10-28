import { beforeEach, describe, expect, it } from "vitest";
import { resetDbForTests } from "../src/lib/db";
import { isBasicFare, sliceSatisfies } from "../src/lib/fares";
import { cachedGooglePremium } from "../src/lib/pricing";
import { DuffelPriceProvider, mainPlusSeats, type DuffelOffer } from "../src/lib/pricing/duffel";
import { findExactItinerary, GoogleFlightsLegPricer, type GoogleFlightsResponse } from "../src/lib/pricing/serpapi-flights";
import type { Cabin, Itinerary } from "../src/lib/types";

const seg = (from: string, to: string, d: string, n: string) => ({
  carrier: "AS", flightNumber: n, origin: from, destination: to, departureLocal: `${d}T10:13`, arrivalLocal: null,
});
/** The user's Alaska trip: Premium Class out, First back, 2 passengers. */
const pvr: Itinerary = {
  slices: [[seg("SEA", "PVR", "2031-01-15", "1360")], [seg("PVR", "SEA", "2031-01-22", "1361")]],
  cabin: "economy", sliceCabins: ["economy", "first"], sliceFareBrands: ["Premium Class", "First Class"],
  passengerCount: 2, fareBrand: "Premium Class",
};

function oneWay(id: string, amount: string, from: string, to: string, d: string, n: string, cabin: Cabin, brand: string): DuffelOffer {
  return {
    id, total_amount: amount, total_currency: "USD",
    slices: [{
      fare_brand_name: brand,
      segments: [{
        origin: { iata_code: from }, destination: { iata_code: to }, departing_at: `${d}T10:13:00`,
        marketing_carrier: { iata_code: "AS" }, marketing_carrier_flight_number: n, passengers: [{ cabin_class: cabin }],
      }],
    }],
  };
}

/** What Duffel returned for the user's trip: no Premium fare out, First back. */
function duffelFetch(calls: string[]) {
  return (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body)).data;
    const from = body.slices[0].origin;
    calls.push(`duffel ${from} ${body.cabin_class}`);
    const offers =
      from === "SEA" && body.cabin_class === "economy"
        ? [oneWay("saver", "745.50", "SEA", "PVR", "2031-01-15", "1360", "economy", "Saver"),
           oneWay("main", "845.50", "SEA", "PVR", "2031-01-15", "1360", "economy", "Main"),
           oneWay("refmain", "1085.50", "SEA", "PVR", "2031-01-15", "1360", "economy", "Refundable Main")]
        : from === "PVR" && body.cabin_class === "first"
          ? [oneWay("first", "1400.00", "PVR", "SEA", "2031-01-22", "1361", "first", "First")]
          : [];
    return new Response(JSON.stringify({ data: { offers } }), { status: 200 });
  }) as unknown as typeof fetch;
}

const googleListing: GoogleFlightsResponse = {
  best_flights: [
    { price: 1120, booking_token: "tok1360", flights: [{ flight_number: "AS 1360", departure_airport: { id: "SEA" }, arrival_airport: { id: "PVR" }, travel_class: "Economy" }] },
  ],
  other_flights: [
    { price: 990, booking_token: "tok1362", flights: [{ flight_number: "AS 1362", departure_airport: { id: "SEA" }, arrival_airport: { id: "PVR" }, travel_class: "Economy" }] },
  ],
};

/** Alaska's fare options on the flight's Google booking page. */
const fareOptions: GoogleFlightsResponse = {
  booking_options: [
    { together: { book_with: "Alaska", option_title: "Saver", price: 1491 } },
    { together: { book_with: "Alaska", option_title: "Main", price: 1691 } },
    { together: { book_with: "Alaska", option_title: "Premium", price: 2051 } },
    { together: { book_with: "Expedia", option_title: "Premium", price: 2099 } },
    { together: { book_with: "Alaska", option_title: "First", price: 2899 } },
  ],
};

/** SerpApi stand-in: the economy search, then the fare options for the booking token. */
function googleFetch(calls: string[], options: GoogleFlightsResponse = fareOptions) {
  return (async (u: string) => {
    const q = new URL(u).searchParams;
    const token = q.get("booking_token");
    calls.push(token ? `google options ${token}` : `google search class ${q.get("travel_class")}`);
    return new Response(JSON.stringify(token ? options : googleListing), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("Alaska fares", () => {
  it("treats Alaska 'Saver' as basic economy, so Main means the real Main fare", () => {
    expect(isBasicFare("Saver", "AS")).toBe(true);
    expect(isBasicFare("Saver", "UA")).toBe(false);
    const main = { level: "main" as const, searchCabins: ["economy" as Cabin] };
    expect(sliceSatisfies(main, ["economy"], "Saver", "AS")).toBe(false);
    expect(sliceSatisfies(main, ["economy"], "Main", "AS")).toBe(true);
  });
});

describe("Google Flights lookup", () => {
  it("finds the listing for the exact flight, not a cheaper one at another time", () => {
    expect(findExactItinerary(googleListing, [seg("SEA", "PVR", "2031-01-15", "1360")])?.price).toBe(1120);
    expect(findExactItinerary(googleListing, [seg("SEA", "PVR", "2031-01-15", "999")])).toBeNull();
  });

  it("also matches the same airline, airports and departure minute when Google writes the flight number differently", () => {
    const listing: GoogleFlightsResponse = {
      best_flights: [{ price: 1180, flights: [{ flight_number: "AS1360A", airline: "Alaska", departure_airport: { id: "SEA", time: "2031-01-15 10:13" }, arrival_airport: { id: "PVR" } }] }],
    };
    expect(findExactItinerary(listing, [seg("SEA", "PVR", "2031-01-15", "1360")])?.price).toBe(1180);
    const otherTime: GoogleFlightsResponse = {
      best_flights: [{ price: 900, flights: [{ flight_number: "AS1360A", airline: "Alaska", departure_airport: { id: "SEA", time: "2031-01-15 16:40" }, arrival_airport: { id: "PVR" } }] }],
    };
    expect(findExactItinerary(otherTime, [seg("SEA", "PVR", "2031-01-15", "1360")])).toBeNull();
  });

  it("says what Google listed when nothing matches", async () => {
    const listing: GoogleFlightsResponse = {
      best_flights: [{ price: 698, flights: [{ flight_number: "DL 1921", departure_airport: { id: "SEA", time: "2031-01-15 09:42" }, arrival_airport: { id: "PVR" }, travel_class: "Premium Economy" }] }],
    };
    const fetchImpl = (async () => new Response(JSON.stringify(listing), { status: 200 })) as unknown as typeof fetch;
    const result = await new GoogleFlightsLegPricer("key", fetchImpl).premium([seg("SEA", "PVR", "2031-01-15", "1360")], 2, "USD");
    expect(result).toEqual({
      problem: "Google Flights didn't list your flight (AS 1360 2031-01-15 10:13) in economy. It listed: DL 1921 SEA→PVR 2031-01-15 09:42 (Premium Economy) $698.00.",
    });
  });

  it("finds Alaska Premium Class among the flight's fare options (economy search + fare options)", async () => {
    const calls: string[] = [];
    const urls: URL[] = [];
    const inner = googleFetch(calls);
    const fetchImpl = (async (u: string) => {
      urls.push(new URL(u));
      return inner(u);
    }) as unknown as typeof fetch;
    const result = await new GoogleFlightsLegPricer("key", fetchImpl).premium([seg("SEA", "PVR", "2031-01-15", "1360")], 2, "USD");
    expect(result).toEqual({ cents: 205_100, currency: "USD", note: "Google Flights: Premium via Alaska" });
    expect(calls).toEqual(["google search class 1", "google options tok1360"]); // Alaska: no premium-economy-class search
    expect(Object.fromEntries(urls[0].searchParams)).toMatchObject({
      engine: "google_flights", type: "2", departure_id: "SEA", arrival_id: "PVR", outbound_date: "2031-01-15",
      travel_class: "1", adults: "2", currency: "USD",
    });
  });

  it("lists the fare options it saw when none is Premium", async () => {
    const options: GoogleFlightsResponse = { booking_options: [{ together: { book_with: "Alaska", option_title: "Main", price: 1691 } }] };
    const result = await new GoogleFlightsLegPricer("key", googleFetch([], options)).premium([seg("SEA", "PVR", "2031-01-15", "1360")], 2, "USD");
    expect(result).toEqual({ problem: "Google Flights found your flight, but no Premium fare option. Options shown: Main via Alaska $1,691.00." });
  });

  it("tries Google's premium economy class first for airlines with a separate premium economy cabin", async () => {
    const calls: string[] = [];
    const delta = [{ ...seg("SEA", "PVR", "2031-01-15", "1360"), carrier: "DL" }];
    const listing: GoogleFlightsResponse = {
      best_flights: [{ price: 698, flights: [{ flight_number: "DL 1360", departure_airport: { id: "SEA" }, arrival_airport: { id: "PVR" }, travel_class: "Premium Economy" }] }],
    };
    const fetchImpl = (async (u: string) => {
      calls.push(`class ${new URL(u).searchParams.get("travel_class")}`);
      return new Response(JSON.stringify(listing), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await new GoogleFlightsLegPricer("key", fetchImpl).premium(delta, 2, "USD")).toEqual({ cents: 69_800, currency: "USD", note: "Google Flights Premium Economy" });
    expect(calls).toEqual(["class 2"]);
  });
});

describe("pricing the user's Alaska trip", () => {
  beforeEach(() => resetDbForTests());

  it("uses Google Flights for the Premium leg Duffel can't price, and Duffel for First back", async () => {
    const calls: string[] = [];
    const fallback = cachedGooglePremium(new GoogleFlightsLegPricer("key", googleFetch(calls)), 24);
    const duffel = new DuffelPriceProvider("tok", duffelFetch(calls), fallback);
    const ctx = () => ({ bookingKey: "x", paidCents: 0, currency: "USD", searchCache: new Map() });

    const quote = await duffel.quote(pvr, ctx());
    expect(quote).toEqual({
      priceCents: 205_100 + 140_000,
      currency: "USD",
      note: "Premium out (Google Flights: Premium via Alaska) · First back — 2 one-way fares added together",
    });
    expect(calls).toEqual([
      "duffel SEA economy", "duffel SEA premium_economy", "google search class 1", "google options tok1360", "duffel PVR first",
    ]);

    // The next check within 24 hours reuses the saved Google price instead of spending another search.
    await duffel.quote(pvr, ctx());
    expect(calls.filter((c) => c.startsWith("google"))).toHaveLength(2); // still just the first lookup's 2 searches
  });

  it("explains when Google doesn't list the flight either, without retrying every check", async () => {
    let googleCalls = 0;
    const googleFetch = (async () => {
      googleCalls++;
      return new Response(JSON.stringify({ best_flights: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const duffel = new DuffelPriceProvider("tok", duffelFetch([]), cachedGooglePremium(new GoogleFlightsLegPricer("key", googleFetch), 24));
    const q1 = await duffel.quote(pvr, { bookingKey: "x", paidCents: 0, currency: "USD", searchCache: new Map() });
    expect(q1.priceCents).toBeNull();
    expect(q1.note).toContain("Google Flights: Google Flights listed no flights in economy for that day.");
    const q2 = await duffel.quote(pvr, { bookingKey: "x", paidCents: 0, currency: "USD", searchCache: new Map() });
    expect(q2.note).toContain("saved lookup");
    expect(googleCalls).toBe(1);
  });

  it("with a typed-in seat price, prices Premium as the Main fare + seats, with no Google searches", async () => {
    const calls: string[] = [];
    const fallback = cachedGooglePremium(new GoogleFlightsLegPricer("key", googleFetch(calls)), 24);
    const duffel = new DuffelPriceProvider("tok", duffelFetch(calls), fallback);
    const quote = await duffel.quote({ ...pvr, premiumSeatCentsPerPerson: 15_000 }, { bookingKey: "x", paidCents: 0, currency: "USD", searchCache: new Map() });
    expect(quote).toEqual({
      priceCents: 84_550 + 2 * 15_000 + 140_000, // Main (not Saver) + $150 seat × 2 passengers, + First back
      currency: "USD",
      note: "Premium out (Main fare + your Premium seat price) · First back — 2 one-way fares added together",
    });
    expect(calls.some((c) => c.startsWith("google"))).toBe(false);
  });

  it("adds the seat price for every passenger on both directions of a Premium round trip", () => {
    const rt = (id: string, amount: string, brand: string): DuffelOffer => {
      const out = oneWay(id, amount, "SEA", "PVR", "2031-01-15", "1360", "economy", brand);
      const back = oneWay(id, amount, "PVR", "SEA", "2031-01-22", "1361", "economy", brand);
      return { ...out, slices: [out.slices[0], back.slices[0]] };
    };
    const offer = mainPlusSeats([rt("saver", "1400.00", "Saver"), rt("main", "1600.00", "Main")], pvr, 10_000, "USD");
    expect(offer?.total_amount).toBe("2000.00"); // $1,600 + $100 × 2 passengers × 2 directions
    expect(mainPlusSeats([rt("saver", "1400.00", "Saver")], pvr, 10_000, "USD")).toBeNull(); // never on top of basic
  });

  it("turns Duffel errors into a short readable message", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ errors: [{ title: "Requested offer is no longer available", code: "offer_no_longer_available" }] }), { status: 422 })) as unknown as typeof fetch;
    await expect(new DuffelPriceProvider("tok", fetchImpl).quote(pvr)).rejects.toThrow(
      "Duffel search failed: Requested offer is no longer available (offer_no_longer_available)",
    );
  });
});
