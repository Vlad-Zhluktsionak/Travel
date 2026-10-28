import { describe, expect, it } from "vitest";
import { isBasicFare, sliceSatisfies } from "../src/lib/fares";
import { DuffelPriceProvider, premiumSeatCost, type DuffelOffer, type DuffelSeatMap } from "../src/lib/pricing/duffel";
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
        id: `seg_${id}`, origin: { iata_code: from }, destination: { iata_code: to }, departing_at: `${d}T10:13:00`,
        marketing_carrier: { iata_code: "AS" }, marketing_carrier_flight_number: n, passengers: [{ cabin_class: cabin }],
      }],
    }],
  };
}

const seat = (designator: string, price: string, name?: string, disclosures?: string[]) => ({
  type: "seat", designator, name, disclosures, available_services: [{ total_amount: price, total_currency: "USD" }],
});
const seatMap = (segmentId: string, seats: ReturnType<typeof seat>[]): DuffelSeatMap => ({
  segment_id: segmentId,
  cabins: [{ cabin_class: "economy", rows: [{ sections: [{ elements: seats }] }] }],
});

describe("Alaska fares", () => {
  it("treats Alaska 'Saver' as basic economy, so Main means the real Main fare", () => {
    expect(isBasicFare("Saver", "AS")).toBe(true);
    expect(isBasicFare("Saver", "UA")).toBe(false);
    const main = { level: "main" as const, searchCabins: ["economy" as Cabin] };
    expect(sliceSatisfies(main, ["economy"], "Saver", "AS")).toBe(false);
    expect(sliceSatisfies(main, ["economy"], "Main", "AS")).toBe(true);
  });
});

describe("premium seats from a seat map", () => {
  const map = seatMap("seg_1", [
    seat("20A", "25.00"),
    seat("7A", "89.00", "Premium Class"),
    seat("7B", "79.00", undefined, ["Extra legroom"]),
    seat("7C", "79.00", "Premium Class"),
  ]);

  it("adds the cheapest premium seat for each passenger", () => {
    expect(premiumSeatCost([map], ["seg_1"], 2, "AS")).toEqual({ cents: 15_800, currency: "USD" });
  });

  it("explains when there aren't enough premium seats, or none are labelled", () => {
    expect(premiumSeatCost([map], ["seg_1"], 4, "AS")).toEqual({ problem: "Only 3 premium seat(s) left for 4 passengers." });
    const plain = seatMap("seg_1", [seat("20A", "25.00", "Standard"), seat("21A", "30.00", "Preferred legroom?")]);
    const result = premiumSeatCost([plain], ["seg_1"], 2, "AS");
    expect(result).toMatchObject({ problem: expect.stringContaining("Seat labels seen: Standard") });
  });
});

describe("pricing the user's Alaska trip", () => {
  it("prices Premium Class as Main + 2 premium seats when no Premium fare is sold", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.includes("/air/seat_maps")) {
        calls.push(`seatmap ${new URL(url).searchParams.get("offer_id")}`);
        return new Response(JSON.stringify({ data: [seatMap("seg_main", [seat("20A", "25.00"), seat("7A", "79.00", "Premium Class"), seat("7C", "89.00", "Premium Class")])] }), { status: 200 });
      }
      const body = JSON.parse(String(init!.body)).data;
      const from = body.slices[0].origin;
      calls.push(`search ${from} ${body.cabin_class}`);
      const offers =
        from === "SEA" && body.cabin_class === "economy"
          ? [oneWay("saver", "745.50", "SEA", "PVR", "2031-01-15", "1360", "economy", "Saver"),
             oneWay("main", "845.50", "SEA", "PVR", "2031-01-15", "1360", "economy", "Main")]
          : from === "PVR" && body.cabin_class === "first"
            ? [oneWay("first", "1400.00", "PVR", "SEA", "2031-01-22", "1361", "first", "First")]
            : [];
      return new Response(JSON.stringify({ data: { offers } }), { status: 200 });
    }) as unknown as typeof fetch;

    const quote = await new DuffelPriceProvider("tok", fetchImpl).quote(pvr, { bookingKey: "x", paidCents: 0, currency: "USD", searchCache: new Map() });
    // Main $845.50 + seats $79 + $89 out, First $1,400 back.
    expect(quote).toEqual({
      priceCents: 84_550 + 7_900 + 8_900 + 140_000,
      currency: "USD",
      note: "Premium out (Main fare + Premium seats) · First back — 2 one-way fares added together",
    });
    expect(calls).toEqual(["search SEA economy", "search SEA premium_economy", "seatmap main", "search PVR first"]);
  });
});

describe("expired offers", () => {
  it("refreshes the Main offer and retries the seat map when Duffel says the offer is no longer available", async () => {
    const calls: string[] = [];
    let searches = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.includes("/air/seat_maps")) {
        const id = new URL(url).searchParams.get("offer_id")!;
        calls.push(`seatmap ${id}`);
        if (id === "main_1") {
          return new Response(JSON.stringify({ errors: [{ title: "Requested offer is no longer available", code: "offer_no_longer_available", type: "airline_error" }] }), { status: 422 });
        }
        return new Response(JSON.stringify({ data: [seatMap("seg_main_2", [seat("7A", "79.00", "Premium Class"), seat("7C", "89.00", "Premium Class")])] }), { status: 200 });
      }
      const body = JSON.parse(String(init!.body)).data;
      const from = body.slices[0].origin;
      calls.push(`search ${from} ${body.cabin_class}`);
      if (from === "SEA" && body.cabin_class === "economy") {
        searches++;
        return new Response(JSON.stringify({ data: { offers: [oneWay(`main_${searches}`, "845.50", "SEA", "PVR", "2031-01-15", "1360", "economy", "Main")] } }), { status: 200 });
      }
      const offers = from === "PVR" && body.cabin_class === "first" ? [oneWay("first", "1400.00", "PVR", "SEA", "2031-01-22", "1361", "first", "First")] : [];
      return new Response(JSON.stringify({ data: { offers } }), { status: 200 });
    }) as unknown as typeof fetch;

    const quote = await new DuffelPriceProvider("tok", fetchImpl).quote(pvr, { bookingKey: "x", paidCents: 0, currency: "USD", searchCache: new Map() });
    expect(quote.priceCents).toBe(84_550 + 7_900 + 8_900 + 140_000);
    expect(calls).toEqual([
      "search SEA economy", "search SEA premium_economy", "seatmap main_1", // expired
      "search SEA economy", "seatmap main_2", // refreshed and retried
      "search PVR first",
    ]);
  });

  it("turns Duffel errors into a short readable message", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.includes("/air/seat_maps")) {
        return new Response(JSON.stringify({ errors: [{ title: "Seat maps are not available for this airline", code: "unsupported" }] }), { status: 400 });
      }
      return new Response(JSON.stringify({ data: { offers: [oneWay("m", "845.50", "SEA", "PVR", "2031-01-15", "1360", "economy", "Main")] } }), { status: 200 });
    }) as unknown as typeof fetch;
    const quote = await new DuffelPriceProvider("tok", fetchImpl).quote({ ...pvr, slices: [pvr.slices[0]], sliceCabins: ["economy"], sliceFareBrands: ["Premium Class"] });
    expect(quote.note).toContain("Main + premium seat: Seat map failed: Seat maps are not available for this airline (unsupported)");
  });
});
