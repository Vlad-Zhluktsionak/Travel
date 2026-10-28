import { createClient } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import { migrate, resetDbForTests } from "../src/lib/db";
import {
  allOptions, detectedPaidKey, fareWatchSettings, levelOf, optionLabel, searchPlan, sliceSatisfies, targetsFor,
} from "../src/lib/fares";
import { checkBooking } from "../src/lib/monitor";
import type { OutgoingEmail } from "../src/lib/notify";
import { DuffelPriceProvider, type DuffelOffer } from "../src/lib/pricing/duffel";
import type { FlightPriceProvider } from "../src/lib/pricing";
import * as repo from "../src/lib/repo";
import type { Cabin, FlightBooking, FlightDetails, Itinerary, ParsedFlight } from "../src/lib/types";
import { roundTrip } from "./fixtures";

const seg = (from: string, to: string, d: string, n: string) => ({
  carrier: "AS", flightNumber: n, origin: from, destination: to, departureLocal: `${d}T10:13`, arrivalLocal: null,
});
/** Alaska SEA ⇄ PVR, Premium Class out, First back, 2 passengers. */
const pvrDetails: FlightDetails = {
  airline: "Alaska Airlines", bookingSite: null, passengerNames: [], passengerCount: 2,
  slices: [[seg("SEA", "PVR", "2031-01-15", "1360")], [seg("PVR", "SEA", "2031-01-22", "1361")]],
  cabin: "economy", sliceCabins: ["economy", "first"], sliceFareBrands: ["Premium Class", "First Class"], fareBrand: "Premium Class",
};

describe("fare levels and options", () => {
  it("maps each airline's names to Main / Premium / First-Business", () => {
    expect(levelOf("economy", "Main Cabin")).toBe("main");
    expect(levelOf("economy", "Saver")).toBe("main");
    expect(levelOf("economy", "Basic Economy")).toBe("main");
    expect(levelOf("economy", "Premium Class")).toBe("extra"); // Alaska
    expect(levelOf("economy", "Main Cabin Extra")).toBe("extra"); // American
    expect(levelOf("economy", "Comfort+")).toBe("extra"); // Delta
    expect(levelOf("economy", "Economy Plus")).toBe("extra"); // United
    expect(levelOf("premium_economy", null)).toBe("extra");
    expect(levelOf("economy", "EvenMore", "B6")).toBe("extra"); // JetBlue
    expect(levelOf("economy", "Extra Legroom", "WN")).toBe("extra"); // Southwest
    expect(levelOf("economy", "Delta Comfort", "DL")).toBe("extra");
    expect(levelOf("economy", "Economy", "UA")).toBe("main"); // not "Economy Plus"
    expect(levelOf("business", null)).toBe("top");
    expect(levelOf("first", "First Class")).toBe("top");
  });

  it("offers 3 round-trip and 6 mixed options for a round trip, 3 for a one-way", () => {
    expect(allOptions(2).map(optionLabel)).toEqual([
      "Main cabin round trip", "Premium (extra legroom) round trip", "First/Business round trip",
      "Main out · Premium back", "Main out · First/Business back",
      "Premium out · Main back", "Premium out · First/Business back",
      "First/Business out · Main back", "First/Business out · Premium back",
    ]);
    expect(allOptions(1).map(optionLabel)).toEqual(["Main cabin one way", "Premium (extra legroom) one way", "First/Business one way"]);
  });

  it("reads what was paid from the email, defaults to watching only that, and honours corrections", () => {
    expect(detectedPaidKey(pvrDetails)).toBe("extra+top");
    expect(fareWatchSettings(pvrDetails)).toEqual({ paid: "extra+top", paidOverridden: false, options: ["extra+top"], maxExtraCents: 20_000, premiumSeatCentsPerPerson: null });
    const corrected = { ...pvrDetails, fareWatch: { paid: "main+top", options: ["top+top", "extra+top"], maxExtraCents: 30_000 } };
    expect(fareWatchSettings(corrected)).toEqual({ paid: "main+top", paidOverridden: true, options: ["main+top", "top+top", "extra+top"], maxExtraCents: 30_000, premiumSeatCentsPerPerson: null });
  });

  it("carries over the old 'Watch upgrades' switch without lowering any leg", () => {
    const legacy = { ...pvrDetails, upgradeWatch: { enabled: true, maxExtraCents: 15_000 } };
    expect(fareWatchSettings(legacy).options).toEqual(["extra+top", "top+top"]);
  });

  it("matches offered fares to levels", () => {
    const main = { level: "main" as const, searchCabins: ["economy" as Cabin] };
    const extra = { level: "extra" as const, searchCabins: ["economy" as Cabin] };
    const top = { level: "top" as const, searchCabins: ["business" as Cabin] };
    expect(sliceSatisfies(main, ["economy"], "Main")).toBe(true);
    expect(sliceSatisfies(main, ["economy"], "Basic Economy")).toBe(false);
    expect(sliceSatisfies(main, ["economy"], "Premium Class")).toBe(false);
    expect(sliceSatisfies(extra, ["economy"], "Premium Class")).toBe(true);
    expect(sliceSatisfies(extra, ["economy"], "Main")).toBe(false);
    expect(sliceSatisfies(extra, ["premium_economy"], "Premium Economy")).toBe(true);
    expect(sliceSatisfies(extra, ["first"], "First")).toBe(false);
    expect(sliceSatisfies(top, ["first"], "First")).toBe(true);
    expect(sliceSatisfies(top, ["business", "first"], null)).toBe(true);
    expect(sliceSatisfies(top, ["economy", "first"], null)).toBe(false); // economy on one segment
    // What was paid keeps the email's exact fare name.
    expect(sliceSatisfies({ ...extra, exactBrand: "Premium Class" }, ["economy"], "Premium")).toBe(true);
  });

  it("counts searches: options sharing a cabin share a search", () => {
    const s = (options: string[], seat: number | null = null) =>
      searchPlan(roundTrip.details, { paid: "main+main", paidOverridden: false, options, maxExtraCents: 0, premiumSeatCentsPerPerson: seat });
    expect(s(["main+main"])).toEqual({ min: 1, max: 1 });
    // Same economy search; fallbacks: premium-economy cabin, then Google Flights for each direction (saved 24h).
    expect(s(["main+main", "extra+extra"])).toEqual({ min: 1, max: 4 });
    // With a typed-in Premium seat price, Premium comes from the Main fare: no Google lookups.
    expect(s(["main+main", "extra+extra"], 15_000)).toEqual({ min: 1, max: 2 });
    expect(s(["main+main", "top+top"])).toEqual({ min: 2, max: 3 }); // + business (first as fallback)
    expect(s(["main+main", "main+top"])).toEqual({ min: 3, max: 4 }); // mixed: one-way economy out + one-way business back
  });
});

describe("Duffel with fares to watch", () => {
  function slice(from: string, to: string, d: string, n: string, cabin: Cabin, brand: string) {
    return {
      fare_brand_name: brand,
      segments: [{
        origin: { iata_code: from }, destination: { iata_code: to }, departing_at: `${d}T10:13:00`,
        marketing_carrier: { iata_code: "AS" }, marketing_carrier_flight_number: n, passengers: [{ cabin_class: cabin }],
      }],
    };
  }
  const rt = (amount: string, out: [Cabin, string], back: [Cabin, string]): DuffelOffer => ({
    id: amount, total_amount: amount, total_currency: "USD",
    slices: [slice("SEA", "PVR", "2031-01-15", "1360", ...out), slice("PVR", "SEA", "2031-01-22", "1361", ...back)],
  });

  it("prices several options with one shared search per cabin", async () => {
    const requests: string[] = [];
    // Alaska: "Saver" is basic economy, so the Main option uses the real Main fare.
    const economy = [rt("600.00", ["economy", "Main"], ["economy", "Main"]), rt("800.00", ["economy", "Premium"], ["economy", "Premium"])];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)).data;
      requests.push(`${body.slices.length}|${body.cabin_class}`);
      return new Response(JSON.stringify({ data: { offers: body.cabin_class === "economy" ? economy : [] } }), { status: 200 });
    }) as unknown as typeof fetch;
    const duffel = new DuffelPriceProvider("tok", fetchImpl);
    const ctx = { bookingKey: "1", paidCents: 0, currency: "USD", searchCache: new Map() };
    const price = async (key: string) =>
      (await duffel.quote({ ...pvrDetails, targets: targetsFor(pvrDetails, key, { isPaid: false, overridden: false }) } as Itinerary, ctx)).priceCents;

    expect(await price("main+main")).toBe(60_000);
    expect(await price("extra+extra")).toBe(80_000);
    expect(requests).toEqual(["2|economy"]); // both from the same economy round-trip search
  });
});

describe("checking a trip's ticked fares", () => {
  let sent: OutgoingEmail[];
  const mailer = async (e: OutgoingEmail) => void sent.push(e);
  const now = new Date("2030-01-01T12:00:00Z");
  beforeEach(() => {
    resetDbForTests();
    sent = [];
  });

  /** Fake provider pricing by per-slice levels. */
  function levelProvider(prices: Record<string, number | null>) {
    const asked: string[] = [];
    const provider: FlightPriceProvider = {
      name: "test",
      async quote(it) {
        const key = (it.targets ?? []).map((t) => t.level).join("+");
        asked.push(key);
        const cents = prices[key];
        return cents == null ? { priceCents: null, currency: null } : { priceCents: cents, currency: "USD" };
      },
    };
    return { provider, asked };
  }

  async function setup(fareWatch: FlightDetails["fareWatch"]) {
    const user = await repo.findOrCreateUser("me@example.com");
    const { booking } = await repo.upsertBooking(user.id, roundTrip, "test"); // paid $840, main+main
    await repo.updateBookingDetails(booking.id, { ...(booking as FlightBooking).details, fareWatch });
    return (await repo.getBooking(booking.id)) as FlightBooking;
  }

  it("only prices what was paid by default", async () => {
    const booking = await setup(null);
    const { provider, asked } = levelProvider({ "main+main": 90_000 });
    const result = await checkBooking(booking, { providers: { flight: provider }, mailer, now, force: true });
    expect(asked).toEqual(["main+main"]);
    expect(result).not.toHaveProperty("options");
  });

  it("prices each ticked option and emails the ones within the limit", async () => {
    const booking = await setup({ options: ["extra+extra", "top+top", "main+top"], maxExtraCents: 10_000 });
    const { provider, asked } = levelProvider({ "main+main": 90_000, "extra+extra": 90_000, "top+top": 300_000, "main+top": null });
    const result = await checkBooking(booking, { providers: { flight: provider }, mailer, now, force: true });
    expect(asked).toEqual(["main+main", "extra+extra", "top+top", "main+top"]);
    expect(result).toMatchObject({
      status: "checked",
      options: [
        { key: "extra+extra", priceCents: 90_000, alerted: true },
        { key: "top+top", priceCents: 300_000, alerted: false },
        { key: "main+top", priceCents: null, alerted: false },
      ],
    });
    expect(sent.map((e) => e.subject)).toEqual(["⬆️ Premium (extra legroom) round trip for +$60.00: SFO → BOS (round trip)"]);
    expect((await repo.listPriceChecks(booking.id)).map((c) => c.priceCents)).toEqual([90_000]); // paid history stays separate
    expect((await repo.upgradeSummaries(booking.id)).map((s) => s.cabin).sort()).toEqual(["extra+extra", "main+top", "top+top"]);
  });

  it("passes the typed-in Premium seat price to every quote", async () => {
    const booking = await setup({ options: ["extra+extra"], maxExtraCents: 10_000, premiumSeatCentsPerPerson: 15_000 });
    const seen: (number | null | undefined)[] = [];
    const provider: FlightPriceProvider = {
      name: "test",
      async quote(it) {
        seen.push(it.premiumSeatCentsPerPerson);
        return { priceCents: 90_000, currency: "USD" };
      },
    };
    await checkBooking(booking, { providers: { flight: provider }, mailer, now, force: true });
    expect(seen).toEqual([15_000, 15_000]);
  });

  it("keeps fare-watch settings when the same confirmation is imported again", async () => {
    const booking = await setup({ options: ["top+top"], maxExtraCents: 12_300 });
    await repo.upsertBooking(booking.userId, roundTrip as ParsedFlight, "test");
    expect(((await repo.getBooking(booking.id)) as FlightBooking).details.fareWatch).toEqual({ options: ["top+top"], maxExtraCents: 12_300 });
  });

  it("adds the cabin columns to an existing database without losing data", async () => {
    const c = createClient({ url: ":memory:" });
    await c.execute("CREATE TABLE price_checks (id INTEGER PRIMARY KEY, booking_id INTEGER, price_cents INTEGER)");
    await c.execute("CREATE TABLE alerts (id INTEGER PRIMARY KEY, booking_id INTEGER, found_cents INTEGER)");
    await c.execute("INSERT INTO price_checks (booking_id, price_cents) VALUES (1, 12345)");
    await migrate(c);
    await migrate(c);
    const row = (await c.execute("SELECT price_cents, cabin FROM price_checks")).rows[0];
    expect([Number(row.price_cents), row.cabin]).toEqual([12345, null]);
    c.close();
  });
});
