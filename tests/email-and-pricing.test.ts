import { describe, expect, it } from "vitest";
import { forwardTokenFromAddresses, htmlToText, normalizeInbound } from "../src/lib/email/normalize";
import { cheapestMatchingOffer, DuffelPriceProvider, type DuffelOffer } from "../src/lib/pricing/duffel";
import { signValue, verifyValue } from "../src/lib/sign";
import { roundTrip } from "./fixtures";

describe("inbound email", () => {
  it("normalizes Postmark JSON", () => {
    const email = normalizeInbound({
      FromFull: { Email: "Jane@Example.com" },
      ToFull: [{ Email: "trips+a1b2c3d4e5@in.example.com" }],
      Subject: "Fwd: Your United itinerary",
      HtmlBody: "<html><head><style>x{}</style></head><body><table><tr><td>UA 1234</td><td>SFO&nbsp;&rarr; DEN</td></tr></table></body></html>",
      MessageID: "abc",
    });
    expect(email.from).toBe("jane@example.com");
    expect(email.to).toEqual(["trips+a1b2c3d4e5@in.example.com"]);
    expect(email.text).toContain("UA 1234");
    expect(email.text).not.toContain("x{}");
    expect(forwardTokenFromAddresses(email.to, "in.example.com")).toBe("a1b2c3d4e5");
  });

  it("normalizes SendGrid/Mailgun form fields", () => {
    const email = normalizeInbound({ from: '"Jane" <jane@example.com>', to: "a1b2c3d4e5@in.example.com", subject: "Trip", text: "plain body" });
    expect(email).toMatchObject({ from: "jane@example.com", subject: "Trip", text: "plain body" });
    expect(forwardTokenFromAddresses(email.to, "IN.example.com")).toBe("a1b2c3d4e5");
    expect(forwardTokenFromAddresses(["someone@else.com"], "in.example.com")).toBeNull();
  });

  it("decodes entities and keeps line structure", () => {
    expect(htmlToText("<p>A&amp;B</p><p>&#36;412</p>")).toBe("A&B\n$412");
  });
});

function offer(amount: string, overrides: Partial<{ flight: string; brand: string; date: string }> = {}): DuffelOffer {
  const seg = (carrier: string, num: string, o: string, d: string, dep: string) => ({
    origin: { iata_code: o },
    destination: { iata_code: d },
    departing_at: `${dep}:00`,
    marketing_carrier: { iata_code: carrier },
    marketing_carrier_flight_number: num,
  });
  return {
    id: amount,
    total_amount: amount,
    total_currency: "USD",
    slices: [
      { fare_brand_name: overrides.brand ?? "Economy", segments: [seg("UA", overrides.flight ?? "1234", "SFO", "DEN", overrides.date ?? "2030-03-10T07:00"), seg("UA", "0567", "DEN", "BOS", "2030-03-10T11:45")] },
      { fare_brand_name: overrides.brand ?? "Economy", segments: [seg("UA", "890", "BOS", "SFO", "2030-03-17T18:00")] },
    ],
  };
}

describe("Duffel matching", () => {
  it("picks the cheapest offer on the exact same flights, excluding basic economy", () => {
    const offers = [
      offer("790.00"),
      offer("600.00", { flight: "9999" }), // different flight
      offer("650.00", { brand: "Basic Economy" }), // not like-for-like
      offer("700.00", { date: "2030-03-11T07:00" }), // different day
      offer("760.50"),
    ];
    expect(cheapestMatchingOffer(offers, roundTrip.details)?.total_amount).toBe("760.50");
    expect(cheapestMatchingOffer(offers, { ...roundTrip.details, fareBrand: "Basic Economy" })?.total_amount).toBe("650.00");
  });

  it("builds the offer request from the itinerary", async () => {
    let body: any;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ data: { offers: [offer("760.50")] } }), { status: 200 });
    }) as unknown as typeof fetch;
    const quote = await new DuffelPriceProvider("tok", fetchImpl).quote(roundTrip.details);
    expect(quote).toMatchObject({ priceCents: 76_050, currency: "USD" });
    expect(body.data.slices).toEqual([
      { origin: "SFO", destination: "BOS", departure_date: "2030-03-10" },
      { origin: "BOS", destination: "SFO", departure_date: "2030-03-17" },
    ]);
    expect(body.data.passengers).toHaveLength(2);
    expect(body.data.max_connections).toBe(1);
  });
});

describe("signed values", () => {
  it("round-trips and rejects tampering", () => {
    const signed = signValue({ uid: 7 }, 60);
    expect(verifyValue<{ uid: number }>(signed)?.uid).toBe(7);
    const [payload, sig] = signed.split(".");
    const forged = Buffer.from(JSON.stringify({ uid: 1, exp: 9e9 })).toString("base64url");
    expect(verifyValue(`${forged}.${sig}`)).toBeNull();
    expect(verifyValue(`${payload}.x${sig.slice(1)}`)).toBeNull();
  });
});
