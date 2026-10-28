import { beforeEach, describe, expect, it } from "vitest";
import { resetDbForTests } from "../src/lib/db";
import { cheapestMatchingOffer, DuffelPriceProvider, sameFareBrand, type DuffelOffer } from "../src/lib/pricing/duffel";
import * as repo from "../src/lib/repo";
import type { Cabin, Itinerary, ParsedFlight } from "../src/lib/types";

const seg = (from: string, to: string, date: string, num: string) => ({
  carrier: "AS", flightNumber: num, origin: from, destination: to, departureLocal: `${date}T10:13`, arrivalLocal: null,
});

/** SEA → PVR in Premium Class, PVR → SEA in First, 2 passengers. */
const pvr: Itinerary = {
  slices: [[seg("SEA", "PVR", "2031-01-15", "1360")], [seg("PVR", "SEA", "2031-01-22", "1361")]],
  cabin: "premium_economy",
  sliceCabins: ["premium_economy", "first"],
  sliceFareBrands: ["Premium Class", "First Class"],
  passengerCount: 2,
  fareBrand: "Premium Class",
};

function offerSlice(from: string, to: string, date: string, num: string, cabin: Cabin, brand: string) {
  return {
    fare_brand_name: brand,
    segments: [{
      origin: { iata_code: from }, destination: { iata_code: to }, departing_at: `${date}T10:13:00`,
      marketing_carrier: { iata_code: "AS" }, marketing_carrier_flight_number: num,
      passengers: [{ cabin_class: cabin }],
    }],
  };
}
const offer = (amount: string, slices: DuffelOffer["slices"]): DuffelOffer => ({ id: amount, total_amount: amount, total_currency: "USD", slices });

describe("fare brand matching", () => {
  it("matches the same fare product across naming differences", () => {
    expect(sameFareBrand("Premium Class", "Premium")).toBe(true);
    expect(sameFareBrand("Main Cabin", "Main")).toBe(true);
    expect(sameFareBrand("First Class", "First")).toBe(true);
    expect(sameFareBrand("Premium Class", "Main")).toBe(false);
    expect(sameFareBrand("Premium Class", "Saver")).toBe(false);
    expect(sameFareBrand("First Class", "Premium")).toBe(false);
    expect(sameFareBrand("Economy", "Basic Economy")).toBe(false);
  });
});

describe("like-for-like offers", () => {
  const outbound = (amount: string, cabin: Cabin, brand: string) =>
    offer(amount, [offerSlice("SEA", "PVR", "2031-01-15", "1360", cabin, brand)]);
  const oneWayOut: Itinerary = { ...pvr, slices: [pvr.slices[0]], cabin: "premium_economy", sliceCabins: ["premium_economy"], sliceFareBrands: ["Premium Class"] };

  it("never compares Premium Class with a cheaper Main/Saver seat or a higher cabin", () => {
    const offers = [
      outbound("300.00", "economy", "Saver"),
      outbound("350.00", "economy", "Main"),
      outbound("900.00", "first", "First"),
      outbound("520.00", "premium_economy", "Premium"),
    ];
    expect(cheapestMatchingOffer(offers, oneWayOut)?.total_amount).toBe("520.00");
  });

  it("accepts the airline's own name for the same premium fare (email 'Premium Class', Duffel 'Premium Economy')", () => {
    const offers = [outbound("350.00", "economy", "Main"), outbound("498.00", "premium_economy", "Premium Economy")];
    expect(cheapestMatchingOffer(offers, oneWayOut)?.total_amount).toBe("498.00");
    // Also when the airline sells it in the economy cabin under its premium name.
    expect(cheapestMatchingOffer([outbound("480.00", "economy", "Premium")], oneWayOut)?.total_amount).toBe("480.00");
  });

  it("without a fare name, only a fare of the same level counts (not a lower or higher one)", () => {
    const noBrand = { ...oneWayOut, sliceFareBrands: [null] };
    expect(cheapestMatchingOffer([outbound("300.00", "economy", "")], noBrand)).toBeNull(); // lower: plain economy
    expect(cheapestMatchingOffer([outbound("700.00", "first", "")], noBrand)).toBeNull(); // higher: a different product
    expect(cheapestMatchingOffer([outbound("520.00", "premium_economy", "")], noBrand)?.total_amount).toBe("520.00");
  });
});

describe("Duffel pricing for mixed-cabin trips", () => {
  it("prices each direction as a one-way in its own cabin and adds them up", async () => {
    const bodies: { slices: { origin: string }[]; cabin_class: string }[] = [];
    const responses = [
      [offer("300.00", [offerSlice("SEA", "PVR", "2031-01-15", "1360", "economy", "Main")]),
       offer("520.00", [offerSlice("SEA", "PVR", "2031-01-15", "1360", "premium_economy", "Premium")])],
      [offer("900.00", [offerSlice("PVR", "SEA", "2031-01-22", "1361", "first", "First")])],
    ];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)).data);
      return new Response(JSON.stringify({ data: { offers: responses[bodies.length - 1] } }), { status: 200 });
    }) as unknown as typeof fetch;

    const quote = await new DuffelPriceProvider("tok", fetchImpl).quote(pvr);
    expect(bodies.map((b) => [b.slices.map((s) => s.origin), b.cabin_class])).toEqual([
      [["SEA"], "premium_economy"],
      [["PVR"], "first"],
    ]);
    expect(quote).toEqual({ priceCents: 142_000, currency: "USD", note: "Premium / First (2 one-way prices added together)" });
  });

  it("reports no price (rather than a wrong one) when a leg's fare isn't offered", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: { offers: [offer("300.00", [offerSlice("SEA", "PVR", "2031-01-15", "1360", "economy", "Saver")])] } }), { status: 200 })) as unknown as typeof fetch;
    const quote = await new DuffelPriceProvider("tok", fetchImpl).quote(pvr);
    expect(quote.priceCents).toBeNull();
    // Says what *was* offered for the same flights, so a missing fare can be diagnosed.
    expect(quote.note).toBe(
      "Premium Class wasn't found on leg 1. Duffel offered: Saver (economy) $300.00 Main + premium seat: no regular Main fare to add a seat to.",
    );
  });

  it("says when the airline returned nothing at all for these flights", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ data: { offers: [] } }), { status: 200 })) as unknown as typeof fetch;
    const quote = await new DuffelPriceProvider("tok", fetchImpl).quote(pvr);
    expect(quote.note).toContain("Duffel returned no offers for these exact flights");
  });
});

describe("re-importing with corrected cabins", () => {
  beforeEach(() => resetDbForTests());

  it("clears the old price history and alerts, which were for a different fare", async () => {
    const user = await repo.findOrCreateUser("me@example.com");
    const wrong: ParsedFlight = {
      kind: "flight", confirmationCode: "AVRLJZ", paidCents: 233_318, currency: "USD",
      details: { ...pvr, cabin: "economy", sliceCabins: undefined, sliceFareBrands: undefined, fareBrand: null, airline: "Alaska Airlines", bookingSite: null, passengerNames: [] },
    };
    const { booking } = await repo.upsertBooking(user.id, wrong, "gmail-script");
    await repo.recordPriceCheck(booking.id, "duffel", 137_918, "USD", "Saver / Saver");
    await repo.createAlert(booking.id, 233_318, 137_918, "USD");

    // Same email re-imported unchanged: history kept.
    await repo.upsertBooking(user.id, wrong, "paste");
    expect(await repo.listPriceChecks(booking.id)).toHaveLength(1);

    // Corrected cabins: history and alerts cleared, and the next scheduled run re-checks right away.
    const fixed: ParsedFlight = { ...wrong, details: { ...wrong.details, ...pvr, airline: "Alaska Airlines" } };
    await repo.upsertBooking(user.id, fixed, "paste");
    expect(await repo.listPriceChecks(booking.id)).toEqual([]);
    expect(await repo.listAlerts(booking.id)).toEqual([]);
    expect((await repo.getBooking(booking.id))!.lastCheckedAt).toBeNull();
  });
});
