import { beforeEach, describe, expect, it } from "vitest";
import { resetDbForTests } from "../src/lib/db";
import { checkBooking, runMonitor } from "../src/lib/monitor";
import type { OutgoingEmail } from "../src/lib/notify";
import type { PriceProvider } from "../src/lib/pricing";
import * as repo from "../src/lib/repo";
import { roundTrip } from "./fixtures";

function fixedProvider(prices: (number | null)[], currency = "USD"): PriceProvider {
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

  beforeEach(() => {
    resetDbForTests();
    sent = [];
  });

  function setup() {
    const user = repo.findOrCreateUser("Jane@Example.com");
    const { booking } = repo.upsertBooking(user.id, roundTrip, "test");
    return { user, booking };
  }

  it("records the price and does not alert when the fare is higher", async () => {
    const { booking } = setup();
    const result = await checkBooking(booking, { provider: fixedProvider([90_000]), mailer, now });
    expect(result).toMatchObject({ status: "checked", priceCents: 90_000, alerted: false });
    expect(repo.listPriceChecks(booking.id)).toHaveLength(1);
    expect(sent).toHaveLength(0);
  });

  it("alerts once the drop exceeds the threshold, and only re-alerts on a further drop", async () => {
    const { booking } = setup();
    const provider = fixedProvider([80_000, 79_800, 74_000]);

    const first = await checkBooking(booking, { provider, mailer, now });
    expect(first).toMatchObject({ alerted: true });
    expect(sent[0].to).toBe("jane@example.com");
    expect(sent[0].subject).toContain("$40.00");
    expect(sent[0].text).toContain("United doesn't charge change fees");

    // $2 further drop: below the re-alert step.
    expect(await checkBooking(booking, { provider, mailer, now })).toMatchObject({ alerted: false });
    // $58 further drop: alert again.
    expect(await checkBooking(booking, { provider, mailer, now })).toMatchObject({ alerted: true });
    expect(repo.listAlerts(booking.id)).toHaveLength(2);
  });

  it("respects the user's threshold", async () => {
    const { user, booking } = setup();
    repo.updateThreshold(user.id, 10_000);
    const result = await checkBooking(booking, { provider: fixedProvider([80_000]), mailer, now });
    expect(result).toMatchObject({ alerted: false });
  });

  it("never alerts across currencies", async () => {
    const { booking } = setup();
    const result = await checkBooking(booking, { provider: fixedProvider([10_000], "EUR"), mailer, now });
    expect(result).toMatchObject({ status: "checked", alerted: false });
  });

  it("handles unavailable flights and provider errors without alerting", async () => {
    const { booking } = setup();
    expect(await checkBooking(booking, { provider: fixedProvider([null]), mailer, now })).toMatchObject({ status: "unavailable" });

    const failing: PriceProvider = { name: "broken", quote: async () => { throw new Error("boom"); } };
    expect(await checkBooking(booking, { provider: failing, mailer, now })).toMatchObject({ status: "error" });
    expect(repo.listPriceChecks(booking.id).map((c) => c.note)).toEqual([null, "Error: boom"]);
    expect(sent).toHaveLength(0);
  });

  it("marks trips as departed once the first flight date has passed", async () => {
    setup();
    const summary = await runMonitor({ provider: fixedProvider([1]), mailer, now: new Date("2030-03-10T00:00:00Z") });
    expect(summary.departed).toBe(1);
    expect(repo.listActiveBookings()).toHaveLength(0);
  });

  it("updates an existing booking in place when the same confirmation arrives again", () => {
    const { user, booking } = setup();
    const again = repo.upsertBooking(user.id, { ...roundTrip, confirmationCode: "abc123", paidCents: 70_000 }, "test");
    expect(again.created).toBe(false);
    expect(again.booking.id).toBe(booking.id);
    expect(again.booking.paidCents).toBe(70_000);
    expect(again.booking.slices).toEqual(roundTrip.slices);
  });
});
