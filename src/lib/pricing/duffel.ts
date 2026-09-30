import type { Itinerary } from "../types";
import type { FlightPriceProvider, PriceQuote } from "./provider";

interface DuffelSegment {
  origin: { iata_code: string };
  destination: { iata_code: string };
  departing_at: string;
  marketing_carrier: { iata_code: string };
  marketing_carrier_flight_number: string;
}

export interface DuffelOffer {
  id: string;
  total_amount: string;
  total_currency: string;
  slices: { fare_brand_name?: string | null; segments: DuffelSegment[] }[];
}

const normalizeFlightNumber = (n: string) => n.replace(/\D/g, "").replace(/^0+(?=\d)/, "");

/** True if the offer flies exactly the booked flights, slice for slice. */
export function offerMatchesItinerary(offer: DuffelOffer, itinerary: Itinerary): boolean {
  if (offer.slices.length !== itinerary.slices.length) return false;
  return itinerary.slices.every((booked, i) => {
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

/**
 * Pick the cheapest offer for the exact same flights. Basic-economy style fares are excluded unless the
 * traveller booked one, since they aren't a like-for-like replacement (no changes, no seat selection).
 */
export function cheapestMatchingOffer(offers: DuffelOffer[], itinerary: Itinerary): DuffelOffer | null {
  const bookedBasic = /basic/i.test(itinerary.fareBrand ?? "");
  let best: DuffelOffer | null = null;
  for (const offer of offers) {
    if (!offerMatchesItinerary(offer, itinerary)) continue;
    if (!bookedBasic && offer.slices.some((s) => /basic/i.test(s.fare_brand_name ?? ""))) continue;
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

  async quote(itinerary: Itinerary): Promise<PriceQuote> {
    const body = {
      data: {
        slices: itinerary.slices.map((slice) => ({
          origin: slice[0].origin,
          destination: slice[slice.length - 1].destination,
          departure_date: slice[0].departureLocal.slice(0, 10),
        })),
        passengers: Array.from({ length: itinerary.passengerCount }, () => ({ type: "adult" })),
        cabin_class: itinerary.cabin,
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
    const offer = cheapestMatchingOffer(json.data.offers ?? [], itinerary);
    if (!offer) return { priceCents: null, currency: null, note: "Exact flights not currently offered" };
    return {
      priceCents: Math.round(Number(offer.total_amount) * 100),
      currency: offer.total_currency,
      note: offer.slices.map((s) => s.fare_brand_name).filter(Boolean).join(" / ") || undefined,
    };
  }
}
