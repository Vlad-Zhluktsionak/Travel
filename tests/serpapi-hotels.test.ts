import { describe, expect, it } from "vitest";
import {
  bestPropertyMatch,
  cheapestOfficialTotal,
  SerpApiHotelProvider,
  type SerpHotelResponse,
} from "../src/lib/pricing/serpapi-hotels";
import { hotelStay } from "./fixtures";

const hotel = hotelStay.details; // Hyatt, 3 nights, 1 room
const ctx = { bookingKey: "1:X", paidCents: 90_000, currency: "USD" };

const propertyPage: SerpHotelResponse = {
  name: "Hyatt Regency Chicago",
  property_token: "tokHyatt",
  featured_prices: [{ source: "Hyatt", official: true, total_rate: { extracted_lowest: 812 } }],
  prices: [
    { source: "Expedia.com", total_rate: { extracted_lowest: 700 } }, // aggregator: ignored
    { source: "Hyatt.com", rate_per_night: { extracted_lowest: 260 } }, // 3 nights → 780
  ],
};

describe("official-site price selection", () => {
  it("ignores aggregators and takes the cheapest official price", () => {
    expect(cheapestOfficialTotal(propertyPage, hotel)).toEqual({ total: 780, source: "Hyatt.com" });
  });

  it("multiplies by the number of rooms", () => {
    expect(cheapestOfficialTotal(propertyPage, { ...hotel, rooms: 2 })?.total).toBe(1560);
  });

  it("recognises IHG brand sites and returns null when only aggregators are listed", () => {
    const ihg = { ...hotel, chain: "ihg" as const };
    expect(cheapestOfficialTotal({ prices: [{ source: "Holiday Inn", total_rate: { extracted_lowest: 300 } }] }, ihg)?.total).toBe(300);
    expect(cheapestOfficialTotal({ prices: [{ source: "Booking.com", total_rate: { extracted_lowest: 1 } }] }, ihg)).toBeNull();
  });

  it("matches the booked hotel among search results", () => {
    const properties = [
      { name: "Hyatt Centric Chicago Magnificent Mile", property_token: "a" },
      { name: "Hyatt Regency Chicago", property_token: "b" },
      { name: "Hilton Chicago", property_token: "c" },
    ];
    expect(bestPropertyMatch(properties, "Hyatt Regency Chicago")).toBe("b");
    expect(bestPropertyMatch([{ name: "Some Other Inn", property_token: "x" }], "Hyatt Regency Chicago")).toBeNull();
  });
});

describe("SerpApiHotelProvider", () => {
  function fakeFetch(responses: SerpHotelResponse[]) {
    const urls: URL[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(new URL(url));
      return new Response(JSON.stringify(responses[urls.length - 1]), { status: 200 });
    }) as unknown as typeof fetch;
    return { fetchImpl, urls };
  }

  it("finds the property from a result list, then prices it (2 searches)", async () => {
    const { fetchImpl, urls } = fakeFetch([
      { properties: [{ name: "Hyatt Regency Chicago", property_token: "tokHyatt" }] },
      propertyPage,
    ]);
    const quote = await new SerpApiHotelProvider("key", fetchImpl).quote(hotel, ctx);
    expect(quote).toMatchObject({ priceCents: 78_000, currency: "USD", propertyToken: "tokHyatt", note: "Official site: Hyatt.com" });
    expect(urls[0].searchParams.get("q")).toBe("Hyatt Regency Chicago Chicago");
    expect(urls[0].searchParams.get("check_in_date")).toBe("2030-04-02");
    expect(urls[0].searchParams.get("adults")).toBe("2");
    expect(urls[1].searchParams.get("property_token")).toBe("tokHyatt");
  });

  it("uses a cached property token (1 search)", async () => {
    const { fetchImpl, urls } = fakeFetch([propertyPage]);
    await new SerpApiHotelProvider("key", fetchImpl).quote({ ...hotel, propertyToken: "tokHyatt" }, ctx);
    expect(urls).toHaveLength(1);
    expect(urls[0].searchParams.get("property_token")).toBe("tokHyatt");
  });

  it("reports API errors", async () => {
    const { fetchImpl } = fakeFetch([{ error: "Invalid API key." }]);
    await expect(new SerpApiHotelProvider("bad", fetchImpl).quote(hotel, ctx)).rejects.toThrow("Invalid API key");
  });
});
