import { createClient } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import { migrate, resetDbForTests } from "../src/lib/db";
import { checkBooking, upgradeCabinsFor } from "../src/lib/monitor";
import type { OutgoingEmail } from "../src/lib/notify";
import type { FlightPriceProvider } from "../src/lib/pricing";
import * as repo from "../src/lib/repo";
import type { Cabin, FlightBooking, ParsedFlight } from "../src/lib/types";
import { roundTrip } from "./fixtures";

/** Provider that answers per cabin; `undefined` for a cabin means "not offered". */
function cabinProvider(prices: Partial<Record<Cabin, number>>) {
  const asked: Cabin[] = [];
  const provider: FlightPriceProvider = {
    name: "test",
    async quote(itinerary) {
      asked.push(itinerary.cabin);
      const cents = prices[itinerary.cabin];
      return cents === undefined ? { priceCents: null, currency: null } : { priceCents: cents, currency: "USD" };
    },
  };
  return { provider, asked };
}

describe("upgrade watching", () => {
  let sent: OutgoingEmail[];
  const mailer = async (e: OutgoingEmail) => void sent.push(e);
  const now = new Date("2030-01-01T12:00:00Z");

  beforeEach(() => {
    resetDbForTests();
    sent = [];
  });

  async function setup(watch: { enabled: boolean; maxExtraCents: number } | null, parsed: ParsedFlight = roundTrip) {
    const user = await repo.findOrCreateUser("me@example.com");
    const { booking } = await repo.upsertBooking(user.id, parsed, "test");
    const details = { ...(booking as FlightBooking).details, upgradeWatch: watch };
    await repo.updateBookingDetails(booking.id, details);
    return (await repo.getBooking(booking.id)) as FlightBooking;
  }

  it("lists only the cabins above the one booked", () => {
    const trip = (sliceCabins: Cabin[]) => ({ ...roundTrip.details, cabin: sliceCabins[0], sliceCabins });
    expect(upgradeCabinsFor(trip(["economy", "economy"]))).toEqual(["premium_economy", "business_first"]);
    expect(upgradeCabinsFor(trip(["premium_economy", "premium_economy"]))).toEqual(["business_first"]);
    expect(upgradeCabinsFor(trip(["premium_economy", "first"]))).toEqual(["business_first"]);
    expect(upgradeCabinsFor(trip(["business", "first"]))).toEqual([]);
  });

  it("upgrading a mixed trip raises only the lower legs", async () => {
    const mixed = { ...roundTrip, details: { ...roundTrip.details, cabin: "premium_economy" as const, sliceCabins: ["premium_economy", "first"] as Cabin[], sliceFareBrands: ["Premium Class", "First"] } };
    const booking = await setup({ enabled: true, maxExtraCents: 0 }, mixed);
    const seen: { cabins?: Cabin[]; brands?: (string | null)[] }[] = [];
    const provider: FlightPriceProvider = {
      name: "test",
      async quote(it) {
        seen.push({ cabins: it.sliceCabins, brands: it.sliceFareBrands });
        return { priceCents: 999_999, currency: "USD" };
      },
    };
    await checkBooking(booking, { providers: { flight: provider }, mailer, now, force: true });
    expect(seen).toEqual([
      { cabins: ["premium_economy", "first"], brands: ["Premium Class", "First"] }, // the booked trip
      { cabins: ["business", "first"], brands: [null, "First"] }, // business/first upgrade keeps first on the way back
    ]);
  });

  it("does nothing extra when the watch is off", async () => {
    const booking = await setup({ enabled: false, maxExtraCents: 50_000 });
    const { provider, asked } = cabinProvider({ economy: 90_000, premium_economy: 85_000 });
    const result = await checkBooking(booking, { providers: { flight: provider }, mailer, now, force: true });
    expect(asked).toEqual(["economy"]);
    expect(result).not.toHaveProperty("upgrades");
    expect(await repo.upgradeSummaries(booking.id)).toEqual([]);
  });

  it("prices each higher cabin, falls back from business to first, and alerts within the limit", async () => {
    const booking = await setup({ enabled: true, maxExtraCents: 10_000 }); // paid $840, limit +$100
    // Premium economy +$60 (alert), business not offered → first +$1,160 (over limit).
    const { provider, asked } = cabinProvider({ economy: 90_000, premium_economy: 90_000, first: 200_000 });
    const result = await checkBooking(booking, { providers: { flight: provider }, mailer, now, force: true });

    expect(asked).toEqual(["economy", "premium_economy", "business", "first"]);
    expect(result).toMatchObject({
      status: "checked",
      alerted: false,
      upgrades: [
        { cabin: "premium_economy", priceCents: 90_000, alerted: true },
        { cabin: "business_first", priceCents: 200_000, alerted: false },
      ],
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe("⬆️ Upgrade: Premium economy for +$60.00 on SFO → BOS (round trip)");
    expect(sent[0].text).toContain("ABC123");

    const summaries = await repo.upgradeSummaries(booking.id);
    expect(summaries.map((s) => [s.cabin, s.latest.priceCents, s.latest.note])).toEqual([
      ["business_first", 200_000, "First"],
      ["premium_economy", 90_000, "Premium economy"],
    ]);
    // Upgrade checks don't pollute the booked cabin's price history.
    expect((await repo.listPriceChecks(booking.id)).map((c) => c.priceCents)).toEqual([90_000]);
  });

  it("only re-alerts on an upgrade when it gets at least $5 cheaper, independently of price-drop alerts", async () => {
    const booking = await setup({ enabled: true, maxExtraCents: 10_000 });
    const run = (premium: number, economy = 90_000) =>
      checkBooking(booking, { providers: { flight: cabinProvider({ economy, premium_economy: premium }).provider }, mailer, now, force: true });

    await run(90_000); // alert
    await run(89_800); // only $2 cheaper: no new alert
    await run(85_000); // $50 cheaper: alert again
    await run(85_000, 70_000); // economy dropped $140: a normal price-drop alert too
    expect(sent.map((e) => e.subject.slice(0, 12))).toEqual(["⬆️ Upgrade: ", "⬆️ Upgrade: ", "💸 Price dro"]);
    const alerts = await repo.listAlerts(booking.id);
    expect(alerts.map((a) => a.cabin)).toEqual([null, "premium_economy", "premium_economy"]);
  });

  it("keeps the upgrade settings when the same confirmation is imported again", async () => {
    const booking = await setup({ enabled: true, maxExtraCents: 12_300 });
    await repo.upsertBooking(booking.userId, roundTrip, "test");
    expect(((await repo.getBooking(booking.id)) as FlightBooking).details.upgradeWatch).toEqual({ enabled: true, maxExtraCents: 12_300 });
  });

  it("adds the cabin columns to an existing database without losing data", async () => {
    const c = createClient({ url: ":memory:" });
    await c.execute("CREATE TABLE price_checks (id INTEGER PRIMARY KEY, booking_id INTEGER, price_cents INTEGER)");
    await c.execute("CREATE TABLE alerts (id INTEGER PRIMARY KEY, booking_id INTEGER, found_cents INTEGER)");
    await c.execute("INSERT INTO price_checks (booking_id, price_cents) VALUES (1, 12345)");
    await migrate(c);
    await migrate(c); // idempotent
    const row = (await c.execute("SELECT price_cents, cabin FROM price_checks")).rows[0];
    expect([Number(row.price_cents), row.cabin]).toEqual([12345, null]);
    expect((await c.execute("PRAGMA table_info(alerts)")).rows.map((r) => r.name)).toContain("cabin");
    c.close();
  });
});
