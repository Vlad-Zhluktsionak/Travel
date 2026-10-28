import { CABIN_LABELS, CABIN_RANK } from "../cabins";
import { LEVEL_LABELS, isPremiumName, sameSearchOrder, sliceSatisfies, targetsFor, detectedPaidKey, type SliceTarget } from "../fares";
import type { Cabin, Itinerary } from "../types";
import type { FlightPriceProvider, PriceQuote, QuoteContext } from "./provider";

export { sameFareBrand } from "../fares";

interface DuffelSegment {
  id?: string;
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

/** Duffel seat map (https://duffel.com/docs/api/seat-maps): one per segment of an offer. */
export interface DuffelSeatMap {
  segment_id: string;
  cabins: {
    cabin_class?: string | null;
    rows: {
      sections: {
        elements: {
          type: string;
          designator?: string;
          name?: string | null;
          disclosures?: string[];
          available_services?: { passenger_id?: string; total_amount: string; total_currency: string }[];
        }[];
      }[];
    }[];
  }[];
}

const EXTRA_LEGROOM_SEAT = /premium|extra\s*leg\s*room|more\s*leg\s*room|extra\s*comfort|comfort|even\s*more|economy\s*plus|main cabin extra/i;

/**
 * Cheapest premium (extra-legroom) seats on each segment for every passenger: how airlines like Alaska
 * sell Premium Class on top of a Main fare. A seat counts as premium when the seat map puts it in a
 * premium economy cabin or labels it (name or disclosures) as premium / extra legroom.
 */
export function premiumSeatCost(
  maps: DuffelSeatMap[],
  segmentIds: string[],
  passengers: number,
  carrier?: string,
): { cents: number; currency: string } | { problem: string } {
  let total = 0;
  let currency: string | null = null;
  for (const segId of segmentIds) {
    const map = maps.find((m) => m.segment_id === segId);
    if (!map) return { problem: "The airline didn't provide a seat map for this flight." };
    const prices: { cents: number; currency: string }[] = [];
    const labels = new Set<string>();
    let paidSeats = 0;
    for (const cabin of map.cabins) {
      for (const row of cabin.rows) {
        for (const section of row.sections) {
          for (const el of section.elements) {
            if (el.type !== "seat" || !el.available_services?.length) continue;
            paidSeats++;
            const label = [el.name, ...(el.disclosures ?? [])].filter(Boolean).join(" ");
            if (label) labels.add(label);
            const premium =
              cabin.cabin_class === "premium_economy" ||
              isPremiumName(el.name ?? null, carrier) ||
              EXTRA_LEGROOM_SEAT.test(label);
            if (!premium) continue;
            const cheapest = el.available_services.reduce((a, b) => (Number(b.total_amount) < Number(a.total_amount) ? b : a));
            prices.push({ cents: Math.round(Number(cheapest.total_amount) * 100), currency: cheapest.total_currency });
          }
        }
      }
    }
    if (prices.length < passengers) {
      const seen = labels.size ? ` Seat labels seen: ${[...labels].slice(0, 5).join("; ")}.` : "";
      return {
        problem:
          prices.length === 0
            ? `No premium / extra-legroom seats found in the seat map (${paidSeats} seats for sale).${seen}`
            : `Only ${prices.length} premium seat(s) left for ${passengers} passengers.`,
      };
    }
    prices.sort((a, b) => a.cents - b.cents);
    for (const p of prices.slice(0, passengers)) {
      if (currency && p.currency !== currency) return { problem: "Seat prices came back in different currencies." };
      currency = p.currency;
      total += p.cents;
    }
  }
  return { cents: total, currency: currency ?? "USD" };
}

const LEVEL_SHORT_NAMES = { main: "Main", extra: "Premium", top: "First/Business" } as const;

/**
 * What was checked on one leg, and how it was priced: { name: "Premium", how: "Main fare + Premium seats" },
 * { name: "First", how: null } (the airline's fare name is dropped when it just repeats the name).
 */
function legLabel(level: SliceTarget["level"], fareName: string | null | undefined): { name: string; how: string | null } {
  let name: string = LEVEL_SHORT_NAMES[level];
  // Show "First" or "Business" rather than "First/Business" when the airline's fare says which one it is.
  if (level === "top" && fareName && /^first\b/i.test(fareName)) name = "First";
  if (level === "top" && fareName && /^business\b/i.test(fareName)) name = "Business";
  const how = fareName && fareName.trim().toLowerCase() !== name.toLowerCase() ? fareName : null;
  return { name, how };
}

/** A Duffel API error, with the short code (e.g. "offer_no_longer_available") and a readable message. */
export class DuffelError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
  }
}

async function duffelError(what: string, res: Response): Promise<DuffelError> {
  const body = await res.text();
  try {
    const e = (JSON.parse(body) as { errors?: { title?: string; message?: string; code?: string }[] }).errors?.[0];
    if (e) return new DuffelError(res.status, e.code ?? null, `${what} failed: ${e.title ?? e.message ?? "error"}${e.code ? ` (${e.code})` : ""}`);
  } catch {
    // not JSON
  }
  return new DuffelError(res.status, null, `${what} failed: HTTP ${res.status} ${body.slice(0, 120)}`);
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

/**
 * What the same flights *were* offered as, e.g. "Duffel offered: Saver (economy) $612 · First (first) $1,410",
 * so a missing fare can be diagnosed (wrong fare name vs. airline not selling through Duffel).
 */
export function describeOffered(sameFlightOffers: DuffelOffer[]): string {
  if (sameFlightOffers.length === 0) {
    return "Duffel returned no offers for these exact flights (the airline may not sell this route through Duffel).";
  }
  const cheapest = new Map<string, { cents: number; currency: string }>();
  for (const o of sameFlightOffers) {
    const label = o.slices
      .map((s) => `${s.fare_brand_name ?? "no fare name"} (${[...new Set(sliceCabinList(s))].join("/") || "cabin?"})`)
      .join(" + ");
    const cents = Math.round(Number(o.total_amount) * 100);
    const prev = cheapest.get(label);
    if (!prev || cents < prev.cents) cheapest.set(label, { cents, currency: o.total_currency });
  }
  const list = [...cheapest.entries()]
    .sort((a, b) => a[1].cents - b[1].cents)
    .slice(0, 6)
    .map(([label, p]) => `${label} ${new Intl.NumberFormat("en-US", { style: "currency", currency: p.currency }).format(p.cents / 100)}`);
  return `Duffel offered: ${list.join(" · ")}`;
}

/** True if the offer flies exactly the booked flights and every slice meets its fare target. */
export function offerMatchesItinerary(offer: DuffelOffer, it: Itinerary): boolean {
  if (!sameFlights(offer, it)) return false;
  const targets = targetsOf(it);
  return offer.slices.every((s, i) => sliceSatisfies(targets[i], sliceCabinList(s), s.fare_brand_name, s.segments[0]?.marketing_carrier.iata_code));
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
      throw await duffelError("Duffel search", res);
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
  private async best(
    it: Itinerary,
    sliceIdx: number[],
    targets: SliceTarget[],
    ctx?: QuoteContext,
  ): Promise<{ offer: DuffelOffer | null; seen: string }> {
    const sub: Itinerary = { ...it, slices: sliceIdx.map((i) => it.slices[i]), targets: sliceIdx.map((i) => targets[i]) };
    const sameFlightOffers: DuffelOffer[] = [];
    for (const cabin of targets[sliceIdx[0]].searchCabins) {
      const offers = await this.offers(it, sliceIdx, cabin, ctx?.searchCache);
      const offer = cheapestMatchingOffer(offers, sub);
      if (offer) return { offer, seen: "" };
      sameFlightOffers.push(...offers.filter((o) => sameFlights(o, sub)));
    }
    let seen = describeOffered(sameFlightOffers);

    // No Premium fare for sale: airlines like Alaska sell Premium Class as a seat on a Main ticket, so
    // price it as the cheapest Main fare plus the cheapest premium seats (1 seat-map request).
    if (sliceIdx.some((i) => targets[i].level === "extra")) {
      const viaSeats = await this.mainPlusPremiumSeats(it, sliceIdx, targets, ctx);
      if ("offer" in viaSeats) return { offer: viaSeats.offer, seen: "" };
      seen = `${seen} Main + premium seat: ${viaSeats.problem}`;
    }
    return { offer: null, seen };
  }

  /** Seat maps for an offer, fetched at most once per check. */
  private seatMaps(offerId: string, cache?: Map<string, Promise<unknown>>): Promise<DuffelSeatMap[]> {
    const key = `duffel-seats|${offerId}`;
    const hit = cache?.get(key) as Promise<DuffelSeatMap[]> | undefined;
    if (hit) return hit;
    const pending = (async () => {
      const res = await this.fetchImpl(`https://api.duffel.com/air/seat_maps?offer_id=${encodeURIComponent(offerId)}`, {
        headers: { Authorization: `Bearer ${this.token}`, "Duffel-Version": "v2", Accept: "application/json" },
      });
      if (!res.ok) throw await duffelError("Seat map", res);
      return ((await res.json()) as { data: DuffelSeatMap[] }).data ?? [];
    })();
    cache?.set(key, pending);
    pending.catch(() => cache?.delete(key));
    return pending;
  }

  private async mainPlusPremiumSeats(
    it: Itinerary,
    sliceIdx: number[],
    targets: SliceTarget[],
    ctx?: QuoteContext,
  ): Promise<{ offer: DuffelOffer } | { problem: string }> {
    // Same group, but Premium legs priced as a regular (non-basic) Main fare.
    const mainTargets = sliceIdx.map((i) =>
      targets[i].level === "extra" ? { level: "main" as const, exactBrand: null, searchCabins: ["economy" as Cabin] } : targets[i],
    );
    const sub: Itinerary = { ...it, slices: sliceIdx.map((i) => it.slices[i]), targets: mainTargets };
    let base = cheapestMatchingOffer(await this.offers(it, sliceIdx, "economy", ctx?.searchCache), sub);
    if (!base) return { problem: "no regular Main fare to add a seat to." };

    // Offers expire quickly, and a later search can invalidate earlier ones. If the Main offer has
    // expired, search Main again (fresh, uncached) and ask for its seat map straight away.
    let maps: DuffelSeatMap[];
    try {
      try {
        maps = await this.seatMaps(base.id, ctx?.searchCache);
      } catch (err) {
        if (!(err instanceof DuffelError && (err.status === 422 || err.code === "offer_no_longer_available"))) throw err;
        base = cheapestMatchingOffer(await this.fetchOffers({ ...it, slices: sliceIdx.map((i) => it.slices[i]) }, "economy"), sub);
        if (!base) return { problem: "no regular Main fare to add a seat to (after refreshing an expired offer)." };
        maps = await this.seatMaps(base.id);
      }
    } catch (err) {
      return { problem: err instanceof Error ? err.message : String(err) };
    }
    const offer = base;
    const premiumSegments = sliceIdx.flatMap((i, k) =>
      targets[i].level === "extra" ? offer.slices[k].segments.map((g) => g.id).filter((id): id is string => !!id) : [],
    );
    if (premiumSegments.length === 0) return { problem: "the offer has no segment ids for a seat map." };
    const carrier = offer.slices[0]?.segments[0]?.marketing_carrier.iata_code;
    const seats = premiumSeatCost(maps, premiumSegments, it.passengerCount, carrier);
    if ("problem" in seats) return seats;
    if (seats.currency !== offer.total_currency) return { problem: "seat prices are in a different currency than the fare." };

    const totalCents = Math.round(Number(offer.total_amount) * 100) + seats.cents;
    return {
      offer: {
        ...offer,
        total_amount: (totalCents / 100).toFixed(2),
        slices: offer.slices.map((sl, k) => ({
          ...sl,
          fare_brand_name:
            targets[sliceIdx[k]].level === "extra" ? `${sl.fare_brand_name ?? "Main"} fare + Premium seats` : sl.fare_brand_name,
        })),
      },
    };
  }

  async quote(it: Itinerary, ctx?: QuoteContext): Promise<PriceQuote> {
    const targets = targetsOf(it);

    if (sameSearchOrder(targets)) {
      const { offer, seen } = await this.best(it, it.slices.map((_, i) => i), targets, ctx);
      if (!offer) return { priceCents: null, currency: null, note: `Your fare wasn't found for these flights. ${seen}` };
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
    const names: { name: string; how: string | null }[] = [];
    for (let i = 0; i < it.slices.length; i++) {
      const { offer, seen } = await this.best(it, [i], targets, ctx);
      if (!offer) {
        const what = targets[i].exactBrand ?? LEVEL_LABELS[targets[i].level] ?? CABIN_LABELS[targets[i].searchCabins[0]];
        return { priceCents: null, currency: null, note: `${what} wasn't found on leg ${i + 1}. ${seen}` };
      }
      if (currency && offer.total_currency !== currency) {
        return { priceCents: null, currency: null, note: "One-way prices came back in different currencies" };
      }
      currency = offer.total_currency;
      total += Math.round(Number(offer.total_amount) * 100);
      names.push(legLabel(targets[i].level, offer.slices[0].fare_brand_name));
    }
    const leg = (l: { name: string; how: string | null }, suffix: string) => `${l.name}${suffix}${l.how ? ` (${l.how})` : ""}`;
    const legs =
      names.length === 2 ? `${leg(names[0], " out")} · ${leg(names[1], " back")}` : names.map((n, i) => `Leg ${i + 1}: ${leg(n, "")}`).join(" · ");
    return { priceCents: total, currency, note: `${legs} — ${names.length} one-way fares added together` };
  }
}
