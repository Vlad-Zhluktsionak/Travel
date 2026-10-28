export type Cabin = "economy" | "premium_economy" | "business" | "first";

export interface Segment {
  /** IATA code of the marketing carrier, e.g. "UA". */
  carrier: string;
  /** Flight number without the carrier prefix, e.g. "1234". */
  flightNumber: string;
  origin: string;
  destination: string;
  /** Local departure time at the origin airport, "YYYY-MM-DDTHH:MM". */
  departureLocal: string;
  arrivalLocal: string | null;
}

/** What we need to price a trip: the exact flights, cabin and party size. */
export interface Itinerary {
  /** One entry per journey direction (outbound, return, ...), each a list of flight segments. */
  slices: Segment[][];
  /** Cabin of the first slice (kept for older code/data); see sliceCabins for the per-direction cabins. */
  cabin: Cabin;
  /** Cabin booked on each slice, e.g. ["premium_economy", "first"]. Missing on older bookings = `cabin` everywhere. */
  sliceCabins?: Cabin[];
  passengerCount: number;
  fareBrand: string | null;
  /** Fare brand booked on each slice (e.g. "Premium Class", "First"); null where the email doesn't say. */
  sliceFareBrands?: (string | null)[];
  /** Set only when pricing a specific fare option: what each slice must match (see lib/fares.ts). */
  targets?: import("./fares").SliceTarget[];
}

export interface FlightDetails extends Itinerary {
  airline: string | null;
  bookingSite: string | null;
  passengerNames: string[];
  /** Legacy (before "fares to watch"): opt-in to price higher cabins. Converted by fareWatchSettings(). */
  upgradeWatch?: UpgradeWatch | null;
  /** Which fare options to price for this trip (see lib/fares.ts). Missing = only what was paid. */
  fareWatch?: FareWatch | null;
}

export interface FareWatch {
  /** User's correction of what they paid, as an option key ("main+top"); null = use what the email says. */
  paid?: string | null;
  /** Extra option keys to price besides what was paid. */
  options: string[];
  /** Email when a ticked option costs at most this much more than what was paid (all passengers). */
  maxExtraCents: number;
}

export interface UpgradeWatch {
  enabled: boolean;
  /** Email when an upgrade cabin costs at most this much more than what was paid (all passengers). */
  maxExtraCents: number;
}


export type HotelChain = "marriott" | "hilton" | "hyatt" | "ihg" | "other";

export interface HotelDetails {
  hotelName: string;
  chain: HotelChain;
  city: string | null;
  address: string | null;
  /** "YYYY-MM-DD" */
  checkIn: string;
  /** "YYYY-MM-DD" */
  checkOut: string;
  adults: number;
  rooms: number;
  roomType: string | null;
  rateName: string | null;
  /** null when the email doesn't say. */
  refundable: boolean | null;
  /** Last date the reservation can be cancelled free of charge, "YYYY-MM-DD". */
  cancelBy: string | null;
  /** Google Hotels id for the property, cached after the first lookup. */
  propertyToken?: string | null;
}

interface ParsedBase {
  confirmationCode: string;
  /** Total paid, in minor units (cents). Flights: all passengers. Hotels: whole stay incl. taxes. */
  paidCents: number;
  currency: string;
}

export type ParsedFlight = ParsedBase & { kind: "flight"; details: FlightDetails };
export type ParsedHotel = ParsedBase & { kind: "hotel"; details: HotelDetails };
export type ParsedBooking = ParsedFlight | ParsedHotel;

interface Stored {
  id: number;
  userId: number;
  source: string;
  status: "active" | "paused" | "departed";
  createdAt: string;
  lastCheckedAt: string | null;
}

export type FlightBooking = ParsedFlight & Stored;
export type HotelBooking = ParsedHotel & Stored;
export type Booking = FlightBooking | HotelBooking;

export interface PriceCheck {
  id: number;
  bookingId: number;
  checkedAt: string;
  provider: string;
  priceCents: number | null;
  currency: string | null;
  note: string | null;
  /** null = what was paid; otherwise the fare option key this check priced (e.g. "extra+top"). */
  cabin: string | null;
}

export interface Alert {
  id: number;
  bookingId: number;
  createdAt: string;
  paidCents: number;
  foundCents: number;
  currency: string;
  /** null = a price drop on what was paid; otherwise an alert for this fare option key. */
  cabin: string | null;
}

export interface User {
  id: number;
  email: string;
  forwardToken: string;
  alertThresholdCents: number;
}
