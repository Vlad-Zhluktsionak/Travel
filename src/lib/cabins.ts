import type { Cabin, Itinerary, UpgradeCabin } from "./types";

export const CABIN_RANK: Record<Cabin, number> = { economy: 0, premium_economy: 1, business: 2, first: 3 };

export const CABIN_LABELS: Record<Cabin, string> = {
  economy: "Economy",
  premium_economy: "Premium economy",
  business: "Business",
  first: "First",
};

/** Cabin booked on each slice (journey direction). Older bookings only stored one cabin for all. */
export function sliceCabins(it: Pick<Itinerary, "slices" | "cabin" | "sliceCabins">): Cabin[] {
  const per = it.sliceCabins;
  return it.slices.map((_, i) => (per && per.length === it.slices.length ? per[i] : it.cabin));
}

export const isMixedCabin = (it: Pick<Itinerary, "slices" | "cabin" | "sliceCabins">) => new Set(sliceCabins(it)).size > 1;

/** The lowest cabin on the trip (what an upgrade would improve). */
export function lowestCabin(it: Pick<Itinerary, "slices" | "cabin" | "sliceCabins">): Cabin {
  return sliceCabins(it).reduce((a, b) => (CABIN_RANK[b] < CABIN_RANK[a] ? b : a));
}

/** "Premium economy out · First back" for mixed trips, otherwise just the cabin. */
export function describeCabins(it: Pick<Itinerary, "slices" | "cabin" | "sliceCabins">): string {
  const cabins = sliceCabins(it);
  if (!isMixedCabin(it)) return CABIN_LABELS[cabins[0]];
  if (cabins.length === 2) return `${CABIN_LABELS[cabins[0]]} out · ${CABIN_LABELS[cabins[1]]} back`;
  return cabins.map((c, i) => `Leg ${i + 1}: ${CABIN_LABELS[c]}`).join(" · ");
}

/**
 * The same itinerary with every slice raised to at least `target` (never lowered), e.g. upgrading a
 * "premium out, first back" trip to business keeps first on the way back.
 */
export function raiseCabins<T extends Itinerary>(it: T, target: Cabin): T {
  const cabins = sliceCabins(it).map((c) => (CABIN_RANK[c] >= CABIN_RANK[target] ? c : target));
  return { ...it, cabin: cabins[0], sliceCabins: cabins };
}

/** Upgrade cabins worth watching: those that would raise at least one slice. */
export function upgradeCabinsFor(it: Pick<Itinerary, "slices" | "cabin" | "sliceCabins">): UpgradeCabin[] {
  const lowest = CABIN_RANK[lowestCabin(it)];
  const out: UpgradeCabin[] = [];
  if (lowest < CABIN_RANK.premium_economy) out.push("premium_economy");
  if (lowest < CABIN_RANK.business) out.push("business_first");
  return out;
}
