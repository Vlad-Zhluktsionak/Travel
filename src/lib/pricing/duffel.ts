import { CABIN_LABELS, CABIN_RANK, isMixedCabin, sliceCabins } from "../cabins";
import type { Cabin, Itinerary } from "../types";
import type { FlightPriceProvider, PriceQuote } from "./provider";

interface DuffelSegment {
  origin: { iata_code: string };
  destination: { iata_code: string };
  departing_at: string;
  marketing_carrier: { iata_code: string };
  marketing_carrier_flight_number: string;
  /** Per-passenger cabin on this segment. */
  passengers?: { cabin_class?: string | null; cabin_class_marketing_name?: string | null }[];
}

export interface DuffelOffer {
  id: string;
  total_amount: string;
  total_currency: string;
  slices: { fare_brand_name?: string | null; segments: DuffelSegment[] }[];
}

const normalizeFlightNumber = (n: string) => n.replace(/\D/g, "").replace(/^0+(?=\d)/, "");

/** Fare brand of each slice; falls back to the trip-wide brand for older bookings. */
function sliceBrands(it: Itinerary): (string | null)[] {
  const per = it.sliceFareBrands;
  return it.slices.map((_, i) => (per && per.length === it.slices.length ? per[i] : it.fareBrand));
}

const BRAND_FILLER = new Set(["class", "cabin", "fare", "the", "seat", "seats", "ticket"]);
const brandWords = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((w) => w && !BRAND_FILLER.has(w)),
  );

/**
 * Same fare product? Names differ slightly between confirmation emails and airline APIs
 * ("Premium Class" vs "Premium", "Main Cabin" vs "Main"), so compare their meaningful words.
 */
export function sameFareBrand(booked: string, offered: string): boolean {
  const a = brandWords(booked);
  const b = brandWords(offered);
  if (a.size === 0 || b.size === 0) return false;
  // "Basic" changes the product (no changes, no seat choice): "Economy" is not "Basic Economy".
  if (a.has("basic") !== b.has("basic")) return false;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  return [...small].every((w) => big.has(w));
}

/** True if the offer flies exactly the booked flights, slice for slice, in the booked cabin (or better). */
export function offerMatchesItinerary(offer: DuffelOffer, itinerary: Itinerary): boolean {
  if (offer.slices.length !== itinerary.slices.length) return false;
  const cabins = sliceCabins(itinerary);
  return itinerary.slices.every((booked, i) => {
    const offered = offer.slices[i].segments;
    if (offered.length !== booked.length) return false;
    return booked.every((seg, j) => {
      const o = offered[j];
      // Never compare against a lower cabin (e.g. economy on a leg booked in first).
      const segCabins = (o.passengers ?? []).map((p) => p.cabin_class).filter((c): c is Cabin => !!c && c in CABIN_RANK);
      const cabinOk = segCabins.every((c) => CABIN_RANK[c] >= CABIN_RANK[cabins[i]]);
      return (
        cabinOk &&
        o.marketing_carrier.iata_code === seg.carrier &&
        normalizeFlightNumber(o.marketing_carrier_flight_number) === seg.flightNumber &&
        o.origin.iata_code === seg.origin &&
        o.destination.iata_code === seg.destination &&
        o.departing_at.slice(0, 10) === seg.departureLocal.slice(0, 10)
      );
    });
  });
}

/**
 * Pick the cheapest offer that is a like-for-like replacement: the exact same flights, the same cabin
 * (or better) on every leg, and — where the booking names a fare brand for a slice — the same fare
 * brand (so "Premium Class" is never compared with a plain "Main"/"Saver" seat). Basic-economy fares
 * are excluded unless that's what was booked.
 */
export function cheapestMatchingOffer(offers: DuffelOffer[], itinerary: Itinerary): DuffelOffer | null {
  const brands = sliceBrands(itinerary);
  let best: DuffelOffer | null = null;
  for (const offer of offers) {
    if (!offerMatchesItinerary(offer, itinerary)) continue;
    const brandsOk = offer.slices.every((s, i) => {
      const booked = brands[i];
      const offered = s.fare_brand_name ?? null;
      if (booked && offered) return sameFareBrand(booked, offered);
      // Unknown on either side: only rule out basic economy (unless that's what was booked).
      return /basic/i.test(booked ?? "") || !/basic/i.test(offered ?? "");
    });
    if (!brandsOk) continue;
    if (!best || Number(offer.total_amount) < Number(best.total_amount)) best = offer;
  }
  return best;
}

/** Live fares from the Duffel Flights API (https://duffel.com/docs/api/offer-requests). */
export class DuffelPriceProvider implements FlightPriceProvider {
  readonly name = "duffel";

  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** One offer request (Duffel takes a single cabin per request); returns the cheapest like-for-like offer. */
  private async search(itinerary: Itinerary, cabin: Cabin): Promise<DuffelOffer | null> {
    const body = {
      data: {
        slices: itinerary.slices.map((slice) => ({
          origin: slice[0].origin,
          destination: slice[slice.length - 1].destination,
          departure_date: slice[0].departureLocal.slice(0, 10),
        })),
        passengers: Array.from({ length: itinerary.passengerCount }, () => ({ type: "adult" })),
        cabin_class: cabin,
        max_connections: Math.max(...itinerary.slices.map((s) => s.length - 1)),
      },
    };

    const res = await this.fetchImpl("https://api.duffel.com/air/offer_requests?return_offers=true&supplier_timeout=20000", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Duffel-Version": "v2",
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Duffel offer request failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    }
    const json = (await res.json()) as { data: { offers: DuffelOffer[] } };
    return cheapestMatchingOffer(json.data.offers ?? [], itinerary);
  }

  async quote(itinerary: Itinerary): Promise<PriceQuote> {
    const cabins = sliceCabins(itinerary);
    const brands = sliceBrands(itinerary);

    if (!isMixedCabin(itinerary)) {
      const offer = await this.search(itinerary, cabins[0]);
      if (!offer) return { priceCents: null, currency: null, note: "Exact flights and fare not currently offered" };
      return {
        priceCents: Math.round(Number(offer.total_amount) * 100),
        currency: offer.total_currency,
        note: offer.slices.map((s) => s.fare_brand_name).filter(Boolean).join(" / ") || undefined,
      };
    }

    // Mixed cabins (e.g. premium out, first back) can't be searched in one request, so price each
    // direction as a one-way in its own cabin and add them up. Most airlines price round trips close to
    // the sum of one-ways, so this is an estimate — the note says so.
    let total = 0;
    let currency: string | null = null;
    const names: string[] = [];
    for (let i = 0; i < itinerary.slices.length; i++) {
      const oneWay: Itinerary = {
        ...itinerary,
        slices: [itinerary.slices[i]],
        cabin: cabins[i],
        sliceCabins: [cabins[i]],
        sliceFareBrands: [brands[i]],
        fareBrand: brands[i],
      };
      const offer = await this.search(oneWay, cabins[i]);
      if (!offer) {
        return { priceCents: null, currency: null, note: `${CABIN_LABELS[cabins[i]]} not currently offered on leg ${i + 1}` };
      }
      if (currency && offer.total_currency !== currency) {
        return { priceCents: null, currency: null, note: "One-way prices came back in different currencies" };
      }
      currency = offer.total_currency;
      total += Math.round(Number(offer.total_amount) * 100);
      names.push(offer.slices[0].fare_brand_name ?? CABIN_LABELS[cabins[i]]);
    }
    return { priceCents: total, currency, note: `${names.join(" / ")} (${names.length} one-way prices added together)` };
  }
}
