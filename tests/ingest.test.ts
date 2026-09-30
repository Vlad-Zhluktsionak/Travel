import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDbForTests } from "../src/lib/db";
import { ingestEmail, looksLikeTravel } from "../src/lib/ingest";
import * as repo from "../src/lib/repo";
import { hotelStay } from "./fixtures";

describe("travel keyword gate", () => {
  it("lets flight and hotel confirmations through", () => {
    expect(looksLikeTravel({ subject: "Your trip confirmation (SEA - HUX)", text: "American Airlines Flight 1234 departs 7:05 AM" })).toBe(true);
    expect(looksLikeTravel({ subject: "Reservation Details for Your Upcoming Stay at Hyatt Regency DFW", text: "" })).toBe(true);
    expect(looksLikeTravel({ subject: "Reservation Confirmation #77656758", text: "Check-In: Sunday, June 28" })).toBe(true);
  });

  it("skips shop orders, appointments and class registrations", () => {
    expect(looksLikeTravel({ subject: "Order Process Confirmation", text: "Your Nespresso order is ready to ship." })).toBe(false);
    expect(looksLikeTravel({ subject: "Your Registration has been Confirmed", text: "Puppy Social Hour starting 9/19 at 10:30 am" })).toBe(false);
    expect(looksLikeTravel({ subject: "Your visit has been confirmed", text: "Your visit Monday with Dr. Brown" })).toBe(false);
  });

  it("doesn't call the AI for non-travel emails", async () => {
    resetDbForTests();
    const user = await repo.findOrCreateUser("me@example.com");
    const extract = vi.fn();
    const result = await ingestEmail(user.id, { subject: "Order #299279 confirmed", text: "Thank you for your purchase!" }, "test", { extract });
    expect(result.ok).toBe(false);
    expect(extract).not.toHaveBeenCalled();

    extract.mockResolvedValue({ booking: hotelStay });
    const hotel = await ingestEmail(user.id, { subject: "Your Hyatt reservation", text: "Check-in April 2" }, "test", { extract, firstCheck: false });
    expect(hotel.ok).toBe(true);
  });
});
