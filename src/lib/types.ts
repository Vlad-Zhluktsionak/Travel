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

export interface FlightDetails extends Itinerary {
  airline: string | null;
  bookingSite: string | null;
  passengerNames: string[];
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
