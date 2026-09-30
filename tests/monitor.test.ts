import { beforeEach, describe, expect, it } from "vitest";
import { resetDbForTests } from "../src/lib/db";
import { checkBooking, runMonitor } from "../src/lib/monitor";
import type { OutgoingEmail } from "../src/lib/notify";
import type { FlightPriceProvider, HotelPriceProvider } from "../src/lib/pricing";
import * as repo from "../src/lib/repo";
import type { HotelBooking } from "../src/lib/types";
import { hotelStay, roundTrip } from "./fixtures";

function fixedProvider(prices: (number | null)[], currency = "USD"): FlightPriceProvider & HotelPriceProvider {
  let i = 0;
  return {
    name: "test",
    async quote() {
      const priceCents = prices[Math.min(i++, prices.length - 1)];
      return { priceCents, currency: priceCents === null ? null : currency };
    },
  };
}

describe("price monitor", () => {
  let sent: OutgoingEmail[];
  const mailer = async (e: OutgoingEmail) => void sent.push(e);
  const now = new Date("2030-01-01T12:00:00Z");
  const deps = (p: FlightPriceProvider & HotelPriceProvider, extra = {}) => ({
    providers: { flight: p, hotel: p },
    mailer,
    now,
    force: true,
    ...extra,
  });

  beforeEach(() => {
    resetDbForTests();
    sent = [];
  });

  async function setup(parsed = roundTrip as typeof roundTrip | typeof hotelStay) {
    const user = await repo.findOrCreateUser("Jane@Example.com");
    const { booking } = await repo.upsertBooking(user.id, parsed, "test");
    return { user, booking };
  }

  it("records the price and does not alert when the fare is higher", async () => {
    const { booking } = await setup();
    const result = await checkBooking(booking, deps(fixedProvider([90_000])));
    expect(result).toMatchObject({ status: "checked", priceCents: 90_000, alerted: false });
    expect(await repo.listPriceChecks(booking.id)).toHaveLength(1);
    expect(sent).toHaveLength(0);
  });

  it("alerts once the drop exceeds the threshold, and only re-alerts on a further drop", async () => {
    const { booking } = await setup();
    const provider = fixedProvider([80_000, 79_800, 74_000]);

    expect(await checkBooking(booking, deps(provider))).toMatchObject({ alerted: true });
    expect(sent[0].to).toBe("jane@example.com");
    expect(sent[0].subject).toContain("$40.00");
    expect(sent[0].text).toContain("United doesn't charge change fees");

    // $2 further drop: below the re-alert step.
    expect(await checkBooking(booking, deps(provider))).toMatchObject({ alerted: false });
    // $58 further drop: alert again.
    expect(await checkBooking(booking, deps(provider))).toMatchObject({ alerted: true });
    expect(await repo.listAlerts(booking.id)).toHaveLength(2);
  });

  it("respects the user's threshold", async () => {
    const { user, booking } = await setup();
    await repo.updateThreshold(user.id, 10_000);
    expect(await checkBooking(booking, deps(fixedProvider([80_000])))).toMatchObject({ alerted: false });
  });

  it("never alerts across currencies", async () => {
    const { booking } = await setup();
    const result = await checkBooking(booking, deps(fixedProvider([10_000], "EUR")));
    expect(result).toMatchObject({ status: "checked", alerted: false });
  });

  it("handles unavailable prices and provider errors without alerting", async () => {
    const { booking } = await setup();
    expect(await checkBooking(booking, deps(fixedProvider([null])))).toMatchObject({ status: "unavailable" });

    const failing = { name: "broken", quote: async () => { throw new Error("boom"); } };
    expect(await checkBooking(booking, deps(failing))).toMatchObject({ status: "error" });
    expect((await repo.listPriceChecks(booking.id)).map((c) => c.note)).toEqual([null, "Error: boom"]);
    expect(sent).toHaveLength(0);
  });

  it("skips trips checked recently unless forced", async () => {
    const { booking } = await setup();
    const provider = fixedProvider([90_000]);
    await checkBooking(booking, deps(provider));
    const fresh = (await repo.getBooking(booking.id))!;
    expect(await checkBooking(fresh, deps(provider, { force: false, now: new Date() }))).toEqual({ status: "skipped" });
  });

  it("re-checks flights every ~6 hours and hotels every ~12 hours on scheduled runs", async () => {
    const { booking: flight } = await setup();
    const { booking: hotel } = await setup(hotelStay);
    const provider = fixedProvider([90_000]);
    const at = (hoursAfterCheck: number) => ({ ...deps(provider), force: false, now: new Date(Date.UTC(2030, 0, 1) + hoursAfterCheck * 3600_000) });
    const checkedAtMidnight = { lastCheckedAt: "2030-01-01 00:00:00" };

    // One scheduler tick later (~6 h, arriving a bit early): flights are due, hotels are not.
    expect((await checkBooking({ ...flight, ...checkedAtMidnight }, at(5.5))).status).toBe("checked");
    expect((await checkBooking({ ...hotel, ...checkedAtMidnight }, at(5.5))).status).toBe("skipped");
    // Two ticks later (~12 h): hotels are due too.
    expect((await checkBooking({ ...hotel, ...checkedAtMidnight }, at(11.5))).status).toBe("checked");
  });

  it("marks trips as past once the start date arrives", async () => {
    await setup();
    await setup(hotelStay);
    const summary = await runMonitor(deps(fixedProvider([1]), { now: new Date("2030-04-02T00:00:00Z") }));
    expect(summary.departed).toBe(2);
    expect(await repo.listActiveBookings()).toHaveLength(0);
  });

  it("updates an existing booking in place when the same confirmation arrives again", async () => {
    const { user, booking } = await setup();
    const again = await repo.upsertBooking(user.id, { ...roundTrip, confirmationCode: "abc123", paidCents: 70_000 }, "test");
    expect(again.created).toBe(false);
    expect(again.booking.id).toBe(booking.id);
    expect(again.booking.paidCents).toBe(70_000);
    expect(again.booking.details).toEqual(roundTrip.details);
  });

  describe("hotels", () => {
    it("alerts with cancel-and-rebook advice and caches the property token", async () => {
      const { booking } = await setup(hotelStay);
      const provider: HotelPriceProvider = {
        name: "test",
        quote: async () => ({ priceCents: 81_000, currency: "USD", propertyToken: "tok123" }),
      };
      const result = await checkBooking(booking, { providers: { hotel: provider }, mailer, now, force: true });
      expect(result).toMatchObject({ alerted: true });
      expect(sent[0].subject).toBe("💸 Price drop: save $90.00 on Hyatt Regency Chicago, Tue, Apr 2–Fri, Apr 5");
      expect(sent[0].text).toContain("Hyatt.com");
      expect(sent[0].text).toContain("2030-04-01");
      expect(((await repo.getBooking(booking.id)) as HotelBooking).details.propertyToken).toBe("tok123");

      // A re-imported confirmation keeps the cached token.
      await repo.upsertBooking(booking.userId, hotelStay, "test");
      expect(((await repo.getBooking(booking.id)) as HotelBooking).details.propertyToken).toBe("tok123");
    });

    it("still alerts on non-refundable rates but flags them", async () => {
      const { booking } = await setup({ ...hotelStay, details: { ...hotelStay.details, refundable: false } });
      await checkBooking(booking, deps(fixedProvider([80_000])));
      expect(sent[0].subject).toContain("non-refundable");
      expect(sent[0].text).toContain("can't cancel and rebook");
    });
  });
});
