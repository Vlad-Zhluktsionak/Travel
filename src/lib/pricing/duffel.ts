import { CABIN_LABELS, CABIN_RANK } from "../cabins";
import { LEVEL_LABELS, sameSearchOrder, sliceSatisfies, targetsFor, detectedPaidKey, type SliceTarget } from "../fares";
import type { Cabin, Itinerary } from "../types";
import type { FlightPriceProvider, PriceQuote, QuoteContext } from "./provider";

export { sameFareBrand } from "../fares";

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

/** What each slice must match: the itinerary's explicit targets, or (by default) exactly what was booked. */
function targetsOf(it: Itinerary): SliceTarget[] {
  return it.targets ?? targetsFor(it, detectedPaidKey(it), { isPaid: true, overridden: false });
}

/** Cabins of a slice's segments, as reported per passenger. */
function sliceCabinList(slice: DuffelOffer["slices"][number]): Cabin[] {
  return slice.segments.flatMap((s) => (s.passengers ?? []).map((p) => p.cabin_class).filter((c): c is Cabin => !!c && c in CABIN_RANK));
}

/** Same flights as booked, slice for slice and segment for segment. */
function sameFlights(offer: DuffelOffer, it: Itinerary): boolean {
  if (offer.slices.length !== it.slices.length) return false;
  return it.slices.every((booked, i) => {
    const offered = offer.slices[i].segments;
    if (offered.length !== booked.length) return false;
    return booked.every((seg, j) => {
      const o = offered[j];
      return (
        o.marketing_carrier.iata_code === seg.carrier &&
        normalizeFlightNumber(o.marketing_carrier_flight_number) === seg.flightNumber &&
        o.origin.iata_code === seg.origin &&
        o.destination.iata_code === seg.destination &&
        o.departing_at.slice(0, 10) === seg.departureLocal.slice(0, 10)
      );
    });
  });
}

/** True if the offer flies exactly the booked flights and every slice meets its fare target. */
export function offerMatchesItinerary(offer: DuffelOffer, it: Itinerary): boolean {
  if (!sameFlights(offer, it)) return false;
  const targets = targetsOf(it);
  return offer.slices.every((s, i) => sliceSatisfies(targets[i], sliceCabinList(s), s.fare_brand_name));
}

/**
 * Cheapest like-for-like offer: the exact same flights, and on every slice the target fare level (and,
 * for what was paid, the same fare name — so "Premium Class" is never compared with "Main"/"Saver").
 */
export function cheapestMatchingOffer(offers: DuffelOffer[], it: Itinerary): DuffelOffer | null {
  let best: DuffelOffer | null = null;
  for (const offer of offers) {
    if (!offerMatchesItinerary(offer, it)) continue;
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

  /** One offer request (Duffel takes a single cabin per request). */
  private async fetchOffers(it: Itinerary, cabin: Cabin): Promise<DuffelOffer[]> {
    const body = {
      data: {
        slices: it.slices.map((slice) => ({
          origin: slice[0].origin,
          destination: slice[slice.length - 1].destination,
          departure_date: slice[0].departureLocal.slice(0, 10),
        })),
        passengers: Array.from({ length: it.passengerCount }, () => ({ type: "adult" })),
        cabin_class: cabin,
        max_connections: Math.max(...it.slices.map((s) => s.length - 1)),
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
    return json.data.offers ?? [];
  }

  /** Offers for these slices in this cabin, searched at most once per check (see QuoteContext.searchCache). */
  private offers(it: Itinerary, sliceIdx: number[], cabin: Cabin, cache?: Map<string, Promise<unknown>>): Promise<DuffelOffer[]> {
    const sub: Itinerary = { ...it, slices: sliceIdx.map((i) => it.slices[i]) };
    const key = `duffel|${sub.slices.map((s) => s.map((g) => `${g.carrier}${g.flightNumber}@${g.departureLocal.slice(0, 10)}`).join(">")).join("|")}|${cabin}|${it.passengerCount}`;
    const hit = cache?.get(key) as Promise<DuffelOffer[]> | undefined;
    if (hit) return hit;
    const pending = this.fetchOffers(sub, cabin);
    cache?.set(key, pending);
    pending.catch(() => cache?.delete(key));
    return pending;
  }

  /** Cheapest match for a group of slices, trying the target's search cabins in order. */
  private async best(it: Itinerary, sliceIdx: number[], targets: SliceTarget[], ctx?: QuoteContext): Promise<DuffelOffer | null> {
    const sub: Itinerary = { ...it, slices: sliceIdx.map((i) => it.slices[i]), targets: sliceIdx.map((i) => targets[i]) };
    for (const cabin of targets[sliceIdx[0]].searchCabins) {
      const offer = cheapestMatchingOffer(await this.offers(it, sliceIdx, cabin, ctx?.searchCache), sub);
      if (offer) return offer;
    }
    return null;
  }

  async quote(it: Itinerary, ctx?: QuoteContext): Promise<PriceQuote> {
    const targets = targetsOf(it);

    if (sameSearchOrder(targets)) {
      const offer = await this.best(it, it.slices.map((_, i) => i), targets, ctx);
      if (!offer) return { priceCents: null, currency: null, note: "Exact flights and fare not currently offered" };
      return {
        priceCents: Math.round(Number(offer.total_amount) * 100),
        currency: offer.total_currency,
        note: offer.slices.map((s) => s.fare_brand_name).filter(Boolean).join(" / ") || undefined,
      };
    }

    // Different cabins per direction can't be searched in one request, so price each direction as a
    // one-way and add them up. Most airlines price round trips close to the sum of one-ways, so this
    // is an estimate — the note says so.
    let total = 0;
    let currency: string | null = null;
    const names: string[] = [];
    for (let i = 0; i < it.slices.length; i++) {
      const offer = await this.best(it, [i], targets, ctx);
      if (!offer) {
        const what = targets[i].exactBrand ?? LEVEL_LABELS[targets[i].level] ?? CABIN_LABELS[targets[i].searchCabins[0]];
        return { priceCents: null, currency: null, note: `${what} not currently offered on leg ${i + 1}` };
      }
      if (currency && offer.total_currency !== currency) {
        return { priceCents: null, currency: null, note: "One-way prices came back in different currencies" };
      }
      currency = offer.total_currency;
      total += Math.round(Number(offer.total_amount) * 100);
      names.push(offer.slices[0].fare_brand_name ?? LEVEL_LABELS[targets[i].level]);
    }
    return { priceCents: total, currency, note: `${names.join(" / ")} (${names.length} one-way prices added together)` };
  }
}
