import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { extractBooking, toParsedBooking, type Extraction } from "../src/lib/extract";

const extraction: Extraction = {
  is_flight_booking: true,
  confirmation_code: "xyz789",
  airline: "Delta Air Lines",
  booking_site: null,
  passenger_names: ["ALEX SMITH"],
  passenger_count: 1,
  cabin: "economy",
  fare_brand: "Main Cabin",
  total_paid: 412.6,
  currency: "usd",
  slices: [
    [
      {
        carrier_iata: "dl",
        flight_number: "DL 0402",
        origin_iata: "jfk",
        destination_iata: "LAX",
        departure_local: "2030-05-01T08:00",
        arrival_local: null,
      },
    ],
  ],
};

describe("toParsedBooking", () => {
  it("normalizes codes, flight numbers and money", () => {
    const { booking } = toParsedBooking(extraction);
    expect(booking).toMatchObject({
      confirmationCode: "XYZ789",
      paidCents: 41_260,
      currency: "USD",
      slices: [[{ carrier: "DL", flightNumber: "402", origin: "JFK", destination: "LAX" }]],
    });
  });

  it("rejects non-bookings and incomplete itineraries", () => {
    expect(toParsedBooking({ ...extraction, is_flight_booking: false }).booking).toBeNull();
    expect(toParsedBooking({ ...extraction, total_paid: null }).reason).toMatch(/price/);
    expect(toParsedBooking({ ...extraction, confirmation_code: null }).booking).toBeNull();
    const badDate = structuredClone(extraction);
    badDate.slices[0][0].departure_local = "May 1";
    expect(toParsedBooking(badDate).booking).toBeNull();
  });
});

describe("extractBooking", () => {
  it("calls Claude with structured output and returns the parsed booking", async () => {
    const parse = vi.fn().mockResolvedValue({ stop_reason: "end_turn", parsed_output: extraction });
    const client = { beta: { messages: { parse } } } as unknown as Anthropic;

    const { booking } = await extractBooking({ subject: "Your trip", from: "delta@t.delta.com", text: "…itinerary…" }, client);

    expect(booking?.confirmationCode).toBe("XYZ789");
    const params = parse.mock.calls[0][0];
    expect(params.model).toBe("claude-opus-5-5");
    expect(params.output_config.format).toBeDefined();
    expect(params.messages[0].content).toContain("Subject: Your trip");
  });

  it("returns a reason instead of throwing on refusal", async () => {
    const parse = vi.fn().mockResolvedValue({ stop_reason: "refusal", parsed_output: null });
    const client = { beta: { messages: { parse } } } as unknown as Anthropic;
    const result = await extractBooking({ subject: "x", text: "y" }, client);
    expect(result.booking).toBeNull();
  });
});
