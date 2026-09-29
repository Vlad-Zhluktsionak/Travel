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
  cabin: Cabin;
  passengerCount: number;
  fareBrand: string | null;
}

export interface ParsedBooking extends Itinerary {
  confirmationCode: string;
  airline: string | null;
  bookingSite: string | null;
  passengerNames: string[];
  /** Total paid for all passengers, in minor units (cents). */
  paidCents: number;
  currency: string;
}

export interface Booking extends ParsedBooking {
  id: number;
  userId: number;
  source: string;
  status: "active" | "paused" | "departed";
  createdAt: string;
}

export interface PriceCheck {
  id: number;
  bookingId: number;
  checkedAt: string;
  provider: string;
  priceCents: number | null;
  currency: string | null;
  note: string | null;
}

export interface Alert {
  id: number;
  bookingId: number;
  createdAt: string;
  paidCents: number;
  foundCents: number;
  currency: string;
}

export interface User {
  id: number;
  email: string;
  forwardToken: string;
  alertThresholdCents: number;
}
