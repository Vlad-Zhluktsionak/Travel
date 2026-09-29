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

export const ExtractionSchema = z.object({
  is_flight_booking: z
    .boolean()
    .describe("True only if this email confirms a purchased flight booking/e-ticket (not a promo, check-in reminder without itinerary, or search result)"),
  confirmation_code: z.string().nullable().describe("Airline record locator / PNR, or the booking site's reference if that's all there is"),
  airline: z.string().nullable().describe("Name of the main operating/marketing airline"),
  booking_site: z.string().nullable().describe("Where it was purchased if not directly from the airline (Expedia, Chase Travel, ...)"),
  passenger_names: z.array(z.string()),
  passenger_count: z.number().int(),
  cabin: z.enum(["economy", "premium_economy", "business", "first"]),
  fare_brand: z.string().nullable().describe("Fare family if stated, e.g. 'Basic Economy', 'Main Cabin', 'Economy Light'"),
  total_paid: z.number().nullable().describe("Total amount charged for the flights for all passengers, as a decimal number in the currency's major unit"),
  currency: z.string().nullable().describe("ISO 4217 code, e.g. USD"),
  slices: z
    .array(z.array(SegmentSchema))
    .describe("One entry per journey direction (outbound, return, additional legs of a multi-city trip). Each is its ordered list of flight segments incl. connections."),
});

export type Extraction = z.infer<typeof ExtractionSchema>;

const SYSTEM_PROMPT = `You read airline and travel-agency emails and extract the booked flight itinerary so a price tracker can re-price the exact same flights later.

Be precise: the tracker searches for these exact flight numbers on these exact dates, so copy codes, dates and times verbatim from the email. If the email is a forwarded message, extract the original booking inside it. If a schedule change email lists both old and new flights, use the new ones. Report the total price actually paid for airfare (base fare + taxes and carrier fees, excluding seat upgrades, bags and insurance where they are itemized separately). If a value is not present in the email, return null rather than guessing.`;

/** Emails beyond this size are rejected rather than silently truncated. */
export const MAX_EMAIL_CHARS = 150_000;

export class ExtractionError extends Error {}

let defaultClient: Anthropic | undefined;
const getClient = () => (defaultClient ??= new Anthropic());

/**
 * Ask Claude to pull a structured itinerary out of a confirmation email.
 * Returns null when the email isn't a flight booking or lacks what we need to track it.
 */
export async function extractBooking(
  email: { subject: string; from?: string | null; text: string },
  client: Anthropic = getClient(),
): Promise<{ booking: ParsedBooking | null; reason?: string }> {
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
  if (!parsed) throw new ExtractionError("The model did not return a valid itinerary.");
  return toParsedBooking(parsed);
}

/** Validate the model's extraction and convert it into our domain type. */
export function toParsedBooking(x: Extraction): { booking: ParsedBooking | null; reason?: string } {
  if (!x.is_flight_booking) return { booking: null, reason: "This doesn't look like a flight booking confirmation." };
  if (!x.confirmation_code) return { booking: null, reason: "No confirmation code found." };
  if (x.total_paid === null || !x.currency) {
    return { booking: null, reason: "Couldn't find the price you paid, so there's nothing to compare against." };
  }

  const slices = x.slices
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
      confirmationCode: x.confirmation_code.trim().toUpperCase(),
      airline: x.airline,
      bookingSite: x.booking_site,
      passengerNames: x.passenger_names,
      passengerCount: Math.max(1, x.passenger_count || x.passenger_names.length || 1),
      cabin: x.cabin,
      fareBrand: x.fare_brand,
      paidCents: Math.round(x.total_paid * 100),
      currency: x.currency.trim().toUpperCase(),
      slices,
    },
  };
}
