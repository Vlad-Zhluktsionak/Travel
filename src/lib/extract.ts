import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { ParsedBooking } from "./types";

const SegmentSchema = z.object({
  carrier_iata: z.string().describe("2-character IATA code of the marketing airline, e.g. UA, DL, BA"),
  flight_number: z.string().describe("Flight number digits only, without the airline code"),
  origin_iata: z.string().describe("3-letter IATA airport code"),
  destination_iata: z.string().describe("3-letter IATA airport code"),
  departure_local: z.string().describe("Local departure date/time at origin, format YYYY-MM-DDTHH:MM"),
  arrival_local: z.string().nullable().describe("Local arrival date/time at destination, YYYY-MM-DDTHH:MM"),
});

const FlightSchema = z.object({
  airline: z.string().nullable().describe("Name of the main marketing airline"),
  booking_site: z.string().nullable().describe("Where it was purchased if not directly from the airline (Expedia, Chase Travel, ...)"),
  passenger_names: z.array(z.string()),
  passenger_count: z.number().int(),
  cabin: z.enum(["economy", "premium_economy", "business", "first"]),
  fare_brand: z.string().nullable().describe("Fare family if stated, e.g. 'Basic Economy', 'Main Cabin', 'Economy Light'"),
  slices: z
    .array(z.array(SegmentSchema))
    .describe("One entry per journey direction (outbound, return, additional legs of a multi-city trip). Each is its ordered list of flight segments incl. connections."),
});

const HotelSchema = z.object({
  hotel_name: z.string().describe("Full property name, e.g. 'Courtyard by Marriott Boston Downtown'"),
  chain: z.enum(["marriott", "hilton", "hyatt", "ihg", "other"]).describe("Parent company of the brand (e.g. Westin → marriott, Hampton Inn → hilton, Holiday Inn → ihg)"),
  booked_directly: z
    .boolean()
    .describe("True if booked on the hotel's or hotel chain's own website/app/phone line; false for online travel agencies and aggregators (Expedia, Booking.com, Hotels.com, Priceline, Agoda, credit-card travel portals, ...)"),
  booking_site: z.string().nullable().describe("Name of the site it was booked through"),
  city: z.string().nullable(),
  address: z.string().nullable(),
  check_in: z.string().describe("YYYY-MM-DD"),
  check_out: z.string().describe("YYYY-MM-DD"),
  adults: z.number().int().describe("Adults per room"),
  rooms: z.number().int(),
  room_type: z.string().nullable(),
  rate_name: z.string().nullable().describe("Rate plan, e.g. 'Member Flexible Rate', 'Advance Purchase'"),
  refundable: z.boolean().nullable().describe("True if it can be cancelled free of charge, false if prepaid/non-refundable, null if the email doesn't say"),
  cancel_by: z.string().nullable().describe("Last date for free cancellation, YYYY-MM-DD, if stated"),
});

export const ExtractionSchema = z.object({
  booking_type: z
    .enum(["flight", "hotel", "none"])
    .describe("'flight' or 'hotel' only if this email confirms a purchased booking; 'none' for promos, reminders without the itinerary, receipts for other things, etc."),
  confirmation_code: z.string().nullable().describe("Airline record locator / PNR, or hotel confirmation number"),
  paid_with_points: z
    .boolean()
    .describe("True if the booking was paid fully or partly with points, miles, a free-night award or certificate (e.g. 'Total Points Redeemed', award ticket), even if taxes were paid in cash"),
  total_paid: z
    .number()
    .nullable()
    .describe("Flights: total charged for the airfare for all passengers. Hotels: total for the whole stay incl. taxes and fees (estimated total if pay-at-hotel). Decimal number in the currency's major unit."),
  currency: z.string().nullable().describe("ISO 4217 code, e.g. USD"),
  flight: FlightSchema.nullable().describe("Required when booking_type is 'flight', otherwise null"),
  hotel: HotelSchema.nullable().describe("Required when booking_type is 'hotel', otherwise null"),
});

export type Extraction = z.infer<typeof ExtractionSchema>;

const SYSTEM_PROMPT = `You read flight and hotel confirmation emails and extract the booking so a price tracker can re-price the exact same trip later.

Be precise: the tracker searches for these exact flights/hotel on these exact dates, so copy codes, names, dates and times verbatim from the email. If the email is a forwarded message, extract the original booking inside it. If a schedule change or modification email lists both old and new details, use the new ones. For flights, report the airfare actually paid (base fare + taxes and carrier fees, excluding seats, bags and insurance where itemized separately). If a value is not present in the email, return null rather than guessing.`;

/** Emails beyond this size are rejected rather than silently truncated. */
export const MAX_EMAIL_CHARS = 150_000;

export class ExtractionError extends Error {}

let defaultClient: Anthropic | undefined;
const getClient = () => (defaultClient ??= new Anthropic());

export type ExtractResult = { booking: ParsedBooking | null; reason?: string };

/**
 * Ask Claude to pull a structured booking out of a confirmation email.
 * Returns null (with a reason) when the email isn't a trackable booking.
 */
export async function extractBooking(
  email: { subject: string; from?: string | null; text: string },
  client: Anthropic = getClient(),
): Promise<ExtractResult> {
  if (email.text.length > MAX_EMAIL_CHARS) {
    throw new ExtractionError(`Email is too long to parse (${email.text.length} characters).`);
  }

  const response = await client.beta.messages.parse({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    // Server-side fallback: if a safety classifier declines, the API retries on a suitable model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: betaZodOutputFormat(ExtractionSchema) },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `From: ${email.from ?? "unknown"}\nSubject: ${email.subject}\n\n<email>\n${email.text}\n</email>`,
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    return { booking: null, reason: "The AI model declined to process this email." };
  }
  if (response.stop_reason === "max_tokens") {
    throw new ExtractionError("The model ran out of output tokens while reading this email.");
  }
  const parsed = response.parsed_output;
  if (!parsed) throw new ExtractionError("The model did not return a valid booking.");
  return toParsedBooking(parsed);
}

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Validate the model's extraction and convert it into our domain type. */
export function toParsedBooking(x: Extraction): ExtractResult {
  if (x.booking_type === "none") return { booking: null, reason: "This doesn't look like a flight or hotel booking confirmation." };
  if (!x.confirmation_code) return { booking: null, reason: "No confirmation number found." };
  if (x.paid_with_points) {
    return { booking: null, reason: "Bookings paid with points, miles or award certificates aren't tracked — there's no cash price to compare." };
  }
  if (x.total_paid === null || !x.currency) {
    return { booking: null, reason: "Couldn't find the price you paid, so there's nothing to compare against." };
  }
  const base = {
    confirmationCode: x.confirmation_code.trim().toUpperCase(),
    paidCents: Math.round(x.total_paid * 100),
    currency: x.currency.trim().toUpperCase(),
  };

  if (x.booking_type === "hotel") {
    const h = x.hotel;
    if (!h) return { booking: null, reason: "Couldn't read the hotel details." };
    if (!h.booked_directly) {
      return {
        booking: null,
        reason: `Only hotel stays booked directly on the hotel's official site are tracked${h.booking_site ? ` (this one was booked via ${h.booking_site})` : ""}.`,
      };
    }
    const checkIn = h.check_in.trim();
    const checkOut = h.check_out.trim();
    if (!isDate(checkIn) || !isDate(checkOut) || checkOut <= checkIn) {
      return { booking: null, reason: "Couldn't read the check-in and check-out dates reliably." };
    }
    const cancelBy = h.cancel_by?.trim().slice(0, 10) ?? null;
    return {
      booking: {
        kind: "hotel",
        ...base,
        details: {
          hotelName: h.hotel_name.trim(),
          chain: h.chain,
          city: h.city,
          address: h.address,
          checkIn,
          checkOut,
          adults: Math.max(1, h.adults || 1),
          rooms: Math.max(1, h.rooms || 1),
          roomType: h.room_type,
          rateName: h.rate_name,
          refundable: h.refundable,
          cancelBy: cancelBy && isDate(cancelBy) ? cancelBy : null,
          propertyToken: null,
        },
      },
    };
  }

  const f = x.flight;
  if (!f) return { booking: null, reason: "Couldn't read the flight details." };
  const slices = f.slices
    .map((slice) =>
      slice.map((s) => ({
        carrier: s.carrier_iata.trim().toUpperCase(),
        flightNumber: s.flight_number.replace(/\D/g, "").replace(/^0+(?=\d)/, ""),
        origin: s.origin_iata.trim().toUpperCase(),
        destination: s.destination_iata.trim().toUpperCase(),
        departureLocal: s.departure_local.trim(),
        arrivalLocal: s.arrival_local?.trim() || null,
      })),
    )
    .filter((slice) => slice.length > 0);

  const valid = slices.every((slice) =>
    slice.every(
      (s) =>
        /^[A-Z0-9]{2}$/.test(s.carrier) &&
        /^\d{1,4}$/.test(s.flightNumber) &&
        /^[A-Z]{3}$/.test(s.origin) &&
        /^[A-Z]{3}$/.test(s.destination) &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s.departureLocal),
    ),
  );
  if (slices.length === 0 || !valid) return { booking: null, reason: "Couldn't read the flight details reliably." };

  return {
    booking: {
      kind: "flight",
      ...base,
      details: {
        airline: f.airline,
        bookingSite: f.booking_site,
        passengerNames: f.passenger_names,
        passengerCount: Math.max(1, f.passenger_count || f.passenger_names.length || 1),
        cabin: f.cabin,
        fareBrand: f.fare_brand,
        slices,
      },
    },
  };
}
