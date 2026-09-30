import type { HotelChain, HotelDetails } from "../types";
import type { HotelPriceProvider, HotelQuote, QuoteContext } from "./provider";

/**
 * Hotel prices from Google Hotels via SerpApi (https://serpapi.com/google-hotels-api).
 * Only the price offered by the hotel's own website is used — never an online travel agency's.
 *
 * Each lookup costs one SerpApi search; the first lookup for a hotel may cost two (find the
 * property, then its prices). The property token is cached on the booking afterwards.
 */

interface Money {
  extracted_lowest?: number;
}

export interface SerpPriceEntry {
  source?: string;
  official?: boolean;
  rate_per_night?: Money;
  total_rate?: Money;
}

export interface SerpHotelResponse {
  error?: string;
  name?: string;
  property_token?: string;
  properties?: { name?: string; property_token?: string }[];
  prices?: SerpPriceEntry[];
  featured_prices?: SerpPriceEntry[];
}

/** Booking-site names used by each chain on Google Hotels. */
const CHAIN_SOURCES: Record<Exclude<HotelChain, "other">, RegExp> = {
  marriott: /marriott/i,
  hilton: /hilton/i,
  hyatt: /hyatt/i,
  ihg: /\bihg\b|holiday inn|intercontinental|crowne plaza|kimpton|hotel indigo|staybridge|candlewood|avid hotels/i,
};

export function isOfficialSource(entry: SerpPriceEntry, chain: HotelChain): boolean {
  if (entry.official === true) return true;
  if (chain === "other" || !entry.source) return false;
  return CHAIN_SOURCES[chain].test(entry.source);
}

export function nightsBetween(checkIn: string, checkOut: string): number {
  return Math.round((Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / 86400_000);
}

/** Cheapest official-site total for the whole stay (all rooms), in major units, or null. */
export function cheapestOfficialTotal(response: SerpHotelResponse, hotel: HotelDetails): { total: number; source: string } | null {
  const nights = nightsBetween(hotel.checkIn, hotel.checkOut);
  let best: { total: number; source: string } | null = null;
  for (const entry of [...(response.featured_prices ?? []), ...(response.prices ?? [])]) {
    if (!isOfficialSource(entry, hotel.chain)) continue;
    const perRoom =
      entry.total_rate?.extracted_lowest ??
      (entry.rate_per_night?.extracted_lowest !== undefined ? entry.rate_per_night.extracted_lowest * nights : undefined);
    if (perRoom === undefined || !Number.isFinite(perRoom) || perRoom <= 0) continue;
    const total = perRoom * hotel.rooms;
    if (!best || total < best.total) best = { total, source: entry.source ?? "Official site" };
  }
  return best;
}

const tokens = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1 && !["the", "hotel", "by", "and", "at", "an"].includes(t)),
  );

/** Pick the search result that best matches the booked hotel's name, if any is a clear match. */
export function bestPropertyMatch(properties: { name?: string; property_token?: string }[], hotelName: string): string | null {
  const wanted = tokens(hotelName);
  let best: { token: string; score: number } | null = null;
  for (const p of properties) {
    if (!p.name || !p.property_token) continue;
    const have = tokens(p.name);
    const shared = [...wanted].filter((t) => have.has(t)).length;
    const score = shared / Math.max(wanted.size, have.size, 1);
    if (!best || score > best.score) best = { token: p.property_token, score };
  }
  return best && best.score >= 0.5 ? best.token : null;
}

export class SerpApiHotelProvider implements HotelPriceProvider {
  readonly name = "serpapi";

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async search(hotel: HotelDetails, currency: string, propertyToken?: string | null): Promise<SerpHotelResponse> {
    const params = new URLSearchParams({
      engine: "google_hotels",
      q: [hotel.hotelName, hotel.city].filter(Boolean).join(" "),
      check_in_date: hotel.checkIn,
      check_out_date: hotel.checkOut,
      adults: String(hotel.adults),
      currency,
      gl: "us",
      hl: "en",
      api_key: this.apiKey,
    });
    if (propertyToken) params.set("property_token", propertyToken);
    const res = await this.fetchImpl(`https://serpapi.com/search.json?${params}`);
    const json = (await res.json()) as SerpHotelResponse;
    if (!res.ok || json.error) throw new Error(`SerpApi error ${res.status}: ${json.error ?? "unknown"}`);
    return json;
  }

  async quote(hotel: HotelDetails, ctx: QuoteContext): Promise<HotelQuote> {
    let token = hotel.propertyToken ?? null;
    let details = await this.search(hotel, ctx.currency, token);

    if (!token) {
      if (details.properties?.length) {
        // The query returned a list of hotels: find ours, then fetch its prices.
        token = bestPropertyMatch(details.properties, hotel.hotelName);
        if (!token) return { priceCents: null, currency: null, note: "Couldn't find this hotel on Google Hotels" };
        details = await this.search(hotel, ctx.currency, token);
      } else {
        // The query resolved straight to the property page.
        token = details.property_token ?? null;
      }
    }

    const best = cheapestOfficialTotal(details, hotel);
    if (!best) return { priceCents: null, currency: null, note: "No official-site price for these dates", propertyToken: token };
    return { priceCents: Math.round(best.total * 100), currency: ctx.currency, note: `Official site: ${best.source}`, propertyToken: token };
  }
}
