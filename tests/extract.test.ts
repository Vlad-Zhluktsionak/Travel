import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { extractBooking, toParsedBooking, type Extraction } from "../src/lib/extract";

const flightExtraction: Extraction = {
  booking_type: "flight",
  confirmation_code: "xyz789",
  total_paid: 412.6,
  currency: "usd",
  hotel: null,
  flight: {
    airline: "Delta Air Lines",
    booking_site: null,
    passenger_names: ["ALEX SMITH"],
    passenger_count: 1,
    cabin: "economy",
    fare_brand: "Main Cabin",
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
  },
};

const hotelExtraction: Extraction = {
  booking_type: "hotel",
  confirmation_code: "91234567",
  total_paid: 689.4,
  currency: "USD",
  flight: null,
  hotel: {
    hotel_name: "Chicago Marriott Downtown Magnificent Mile",
    chain: "marriott",
    booked_directly: true,
    booking_site: "Marriott.com",
    city: "Chicago",
    address: null,
    check_in: "2030-06-10",
    check_out: "2030-06-12",
    adults: 2,
    rooms: 1,
    room_type: "Guest room, 1 King",
    rate_name: "Flexible Rate",
    refundable: true,
    cancel_by: "2030-06-09",
  },
};

describe("toParsedBooking", () => {
  it("normalizes flight codes, flight numbers and money", () => {
    const { booking } = toParsedBooking(flightExtraction);
    expect(booking).toMatchObject({
      kind: "flight",
      confirmationCode: "XYZ789",
      paidCents: 41_260,
      currency: "USD",
      details: { slices: [[{ carrier: "DL", flightNumber: "402", origin: "JFK", destination: "LAX" }]] },
    });
  });

  it("rejects non-bookings and incomplete itineraries", () => {
    expect(toParsedBooking({ ...flightExtraction, booking_type: "none" }).booking).toBeNull();
    expect(toParsedBooking({ ...flightExtraction, total_paid: null }).reason).toMatch(/price/);
    expect(toParsedBooking({ ...flightExtraction, confirmation_code: null }).booking).toBeNull();
    const badDate = structuredClone(flightExtraction);
    badDate.flight!.slices[0][0].departure_local = "May 1";
    expect(toParsedBooking(badDate).booking).toBeNull();
  });

  it("parses direct hotel bookings", () => {
    const { booking } = toParsedBooking(hotelExtraction);
    expect(booking).toMatchObject({
      kind: "hotel",
      paidCents: 68_940,
      details: { chain: "marriott", checkIn: "2030-06-10", checkOut: "2030-06-12", refundable: true, cancelBy: "2030-06-09", propertyToken: null },
    });
  });

  it("rejects hotel bookings made through aggregators", () => {
    const viaExpedia = structuredClone(hotelExtraction);
    viaExpedia.hotel!.booked_directly = false;
    viaExpedia.hotel!.booking_site = "Expedia";
    const result = toParsedBooking(viaExpedia);
    expect(result.booking).toBeNull();
    expect(result.reason).toContain("Expedia");
  });

  it("rejects hotel stays with unreadable dates", () => {
    const bad = structuredClone(hotelExtraction);
    bad.hotel!.check_out = "2030-06-09";
    expect(toParsedBooking(bad).booking).toBeNull();
  });
});

describe("extractBooking", () => {
  it("calls Claude with structured output and returns the parsed booking", async () => {
    const parse = vi.fn().mockResolvedValue({ stop_reason: "end_turn", parsed_output: flightExtraction });
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
