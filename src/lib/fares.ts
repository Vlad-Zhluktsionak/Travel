/**
 * Fare levels and per-trip "fares to watch" options.
 *
 * Airlines name the same products differently, so we use three general levels per direction:
 *   main  – standard economy (Main Cabin, Main, Saver/Standard — not Basic)
 *   extra – the middle tier: extra-legroom economy (Alaska Premium Class, American Main Cabin Extra,
 *           Delta Comfort+, United Economy Plus, ...) or a separate premium economy cabin
 *   top   – business or first
 * An option picks one level per direction, e.g. "main+top" = main out, first/business back.
 */
import { CABIN_RANK, sliceCabins } from "./cabins";
import type { Cabin, FlightDetails, Itinerary } from "./types";

export type FareLevel = "main" | "extra" | "top";
export const FARE_LEVELS: FareLevel[] = ["main", "extra", "top"];

export const LEVEL_LABELS: Record<FareLevel, string> = {
  main: "Main cabin",
  extra: "Premium (extra legroom)",
  top: "First/Business",
};

/** Short names for mixed options ("Main out · First/Business back"). */
const LEVEL_SHORT: Record<FareLevel, string> = { main: "Main", extra: "Premium", top: "First/Business" };

/** One level per slice, joined by "+": "main+main", "extra+top". */
export type OptionKey = string;

/** What a price search must match on one slice. */
export interface SliceTarget {
  level: FareLevel;
  /** When the booking names a fare (e.g. "Premium Class"), require that same fare on this slice. */
  exactBrand?: string | null;
  /** Cabins to search, in order (the first that yields a match wins). */
  searchCabins: Cabin[];
}

/**
 * What airlines call their middle tier (checked 2026). Extra-legroom economy: Alaska "Premium Class"
 * (also replaced Hawaiian "Extra Comfort"), American "Main Cabin Extra", Delta "Comfort+"/"Delta Comfort",
 * United "Economy Plus", JetBlue "EvenMore" (formerly "Even More Space"), Southwest "Extra Legroom".
 * Separate premium economy cabins: "Premium Economy", Delta "Premium Select", United "Premium Plus",
 * British Airways "World Traveller Plus", Virgin Atlantic "Premium".
 */
export const PREMIUM_NAMES_BY_AIRLINE: Record<string, string[]> = {
  AS: ["Premium Class", "Premium"],
  HA: ["Extra Comfort", "Premium Class", "Premium"],
  AA: ["Main Cabin Extra", "Premium Economy"],
  DL: ["Comfort+", "Comfort Plus", "Delta Comfort", "Premium Select"],
  UA: ["Economy Plus", "Premium Plus"],
  B6: ["EvenMore", "Even More Space", "Even More"],
  WN: ["Extra Legroom"],
  BA: ["World Traveller Plus"],
  VS: ["Premium"],
};

export const EXTRA_LEGROOM_BRAND =
  /premium|main cabin extra|\bextra\b|comfort|economy\s*plus|\bplus\b|even\s*more|more\s*(leg\s*room|space)|preferred|stretch|world traveller plus/i;

/** Is this fare name an airline's middle tier (extra legroom / premium economy)? */
export function isPremiumName(brand: string | null | undefined, carrier?: string): boolean {
  if (!brand || BASIC_BRAND_RE.test(brand)) return false;
  const known = carrier ? PREMIUM_NAMES_BY_AIRLINE[carrier.toUpperCase()] ?? [] : [];
  // The airline's name must appear in full ("Economy Plus" is premium; plain "Economy" is not).
  const offered = brandWords(brand);
  return known.some((n) => [...brandWords(n)].every((w) => offered.has(w))) || EXTRA_LEGROOM_BRAND.test(brand);
}
const BASIC_BRAND = /basic/i;
const BASIC_BRAND_RE = BASIC_BRAND;

const DEFAULT_SEARCH: Record<FareLevel, Cabin[]> = {
  main: ["economy"],
  // Extra-legroom fares are sold in the economy cabin; real premium economy cabins are the fallback.
  extra: ["economy", "premium_economy"],
  top: ["business", "first"],
};

export const optionKey = (levels: FareLevel[]): OptionKey => levels.join("+");

export function parseOptionKey(key: OptionKey, sliceCount: number): FareLevel[] | null {
  const levels = key.split("+") as FareLevel[];
  if (levels.length !== sliceCount || !levels.every((l) => FARE_LEVELS.includes(l))) return null;
  return levels;
}

export function optionLabel(key: OptionKey): string {
  const levels = key.split("+") as FareLevel[];
  if (!levels.every((l) => FARE_LEVELS.includes(l))) {
    // Pre-"fares to watch" upgrade rows.
    return key === "premium_economy" ? "Premium economy" : key === "business_first" ? "Business / First" : key;
  }
  if (levels.every((l) => l === levels[0])) return `${LEVEL_LABELS[levels[0]]} ${levels.length === 1 ? "one way" : levels.length === 2 ? "round trip" : "all legs"}`;
  if (levels.length === 2) return `${LEVEL_SHORT[levels[0]]} out · ${LEVEL_SHORT[levels[1]]} back`;
  return levels.map((l, i) => `Leg ${i + 1}: ${LEVEL_SHORT[l]}`).join(" · ");
}

/** Every option offered for a trip: all combinations for 1–2 directions; same level on every leg beyond that. */
export function allOptions(sliceCount: number): OptionKey[] {
  if (sliceCount > 2) return FARE_LEVELS.map((l) => optionKey(Array(sliceCount).fill(l)));
  const uniform = FARE_LEVELS.map((l) => optionKey(Array(sliceCount).fill(l)));
  if (sliceCount === 1) return uniform;
  const mixed: OptionKey[] = [];
  for (const a of FARE_LEVELS) for (const b of FARE_LEVELS) if (a !== b) mixed.push(optionKey([a, b]));
  return [...uniform, ...mixed];
}

/** The level a booked slice falls in, from the cabin and fare name in the confirmation. */
export function levelOf(cabin: Cabin, brand: string | null | undefined, carrier?: string): FareLevel {
  if (CABIN_RANK[cabin] >= CABIN_RANK.business) return "top";
  if (cabin === "premium_economy") return "extra";
  return isPremiumName(brand, carrier) ? "extra" : "main";
}

function bookedBrands(d: Itinerary): (string | null)[] {
  const per = d.sliceFareBrands;
  return d.slices.map((_, i) => (per && per.length === d.slices.length ? per[i] : d.fareBrand) ?? null);
}

/** The option the AI read from the confirmation email. */
export function detectedPaidKey(d: Itinerary): OptionKey {
  const brands = bookedBrands(d);
  return optionKey(sliceCabins(d).map((c, i) => levelOf(c, brands[i], d.slices[i][0]?.carrier)));
}

export interface FareWatchSettings {
  paid: OptionKey;
  /** True when the user corrected what they paid (then we don't insist on the email's fare names). */
  paidOverridden: boolean;
  /** Ticked options, always including `paid` first. */
  options: OptionKey[];
  maxExtraCents: number;
}

const DEFAULT_MAX_EXTRA_CENTS = 20_000;

/** Effective settings for a flight, including trips saved before "fares to watch" existed. */
export function fareWatchSettings(d: FlightDetails): FareWatchSettings {
  const n = d.slices.length;
  const detected = detectedPaidKey(d);
  const saved = d.fareWatch;
  const override = saved?.paid && parseOptionKey(saved.paid, n) ? saved.paid : null;
  const paid = override ?? detected;

  let extras: OptionKey[];
  if (saved) {
    extras = saved.options.filter((k) => parseOptionKey(k, n));
  } else if (d.upgradeWatch?.enabled) {
    // Carry over the old "Watch upgrades" switch: premium economy → extra, business/first → top,
    // never lowering a leg that was already higher.
    const paidLevels = parseOptionKey(paid, n)!;
    const raise = (to: FareLevel) => optionKey(paidLevels.map((l) => (FARE_LEVELS.indexOf(l) >= FARE_LEVELS.indexOf(to) ? l : to)));
    extras = [raise("extra"), raise("top")];
  } else {
    extras = [];
  }
  const options = [paid, ...extras.filter((k, i) => k !== paid && extras.indexOf(k) === i)];
  const maxExtraCents = saved?.maxExtraCents ?? d.upgradeWatch?.maxExtraCents ?? DEFAULT_MAX_EXTRA_CENTS;
  return { paid, paidOverridden: Boolean(override && override !== detected), options, maxExtraCents };
}

/** Per-slice search targets for an option. The paid option keeps the email's fare names unless overridden. */
export function targetsFor(d: Itinerary, key: OptionKey, opts: { isPaid: boolean; overridden: boolean }): SliceTarget[] {
  const levels = parseOptionKey(key, d.slices.length);
  if (!levels) throw new Error(`Invalid fare option ${key}`);
  const cabins = sliceCabins(d);
  const brands = bookedBrands(d);
  return levels.map((level, i) => {
    const exact = opts.isPaid && !opts.overridden && levelOf(cabins[i], brands[i], d.slices[i][0]?.carrier) === level;
    const order = exact ? [cabins[i], ...DEFAULT_SEARCH[level].filter((c) => c !== cabins[i])] : DEFAULT_SEARCH[level];
    return { level, exactBrand: exact ? brands[i] : null, searchCabins: order };
  });
}

/**
 * Does an offered slice (its cabins and fare name) satisfy a target? The level decides: an airline's own
 * name for the same fare (email "Premium Class", API "Premium Economy") is fine, a different level never is.
 */
export function sliceSatisfies(target: SliceTarget, cabins: Cabin[], brand: string | null | undefined, carrier?: string): boolean {
  const atLeast = (c: Cabin) => cabins.every((x) => CABIN_RANK[x] >= CABIN_RANK[c]);
  const isBasic = BASIC_BRAND.test(brand ?? "");
  const bookedBasic = BASIC_BRAND.test(target.exactBrand ?? "");
  switch (target.level) {
    case "top":
      return atLeast("business");
    case "extra":
      if (cabins.length && cabins.every((c) => c === "premium_economy")) return true;
      if (!cabins.every((c) => c === "economy")) return false;
      return isPremiumName(brand, carrier) || (!!target.exactBrand && !!brand && sameFareBrand(target.exactBrand, brand));
    case "main":
      if (!cabins.every((c) => c === "economy")) return false;
      // Basic economy only counts when that's exactly what was booked.
      if (isBasic) return bookedBasic && !!target.exactBrand && !!brand && sameFareBrand(target.exactBrand, brand);
      return !isPremiumName(brand, carrier);
  }
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

/**
 * Searches one check needs for a set of options (each search = one cabin over either the whole trip or
 * one direction). `min` assumes the first cabin tried always matches; `max` includes every fallback.
 */
export function searchPlan(d: Itinerary, settings: FareWatchSettings): { min: number; max: number } {
  const first = new Set<string>();
  const all = new Set<string>();
  for (const key of settings.options) {
    const targets = targetsFor(d, key, { isPaid: key === settings.paid, overridden: settings.paidOverridden });
    const roundTrip = sameSearchOrder(targets);
    const groups = roundTrip ? [targets.map((_, i) => i)] : targets.map((_, i) => [i]);
    for (const g of groups) {
      const order = targets[g[0]].searchCabins;
      first.add(`${g.join(",")}|${order[0]}`);
      for (const c of order) all.add(`${g.join(",")}|${c}`);
    }
  }
  return { min: first.size, max: all.size };
}

/** One search can cover every slice only when they all need the same cabin(s). */
export function sameSearchOrder(targets: SliceTarget[]): boolean {
  return targets.every((t) => t.searchCabins.join() === targets[0].searchCabins.join());
}
