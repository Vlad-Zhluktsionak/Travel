import type { ParsedBooking } from "../src/lib/types";

export const roundTrip: ParsedBooking = {
  confirmationCode: "ABC123",
  airline: "United Airlines",
  bookingSite: null,
  passengerNames: ["JANE DOE", "JOHN DOE"],
  passengerCount: 2,
  cabin: "economy",
  fareBrand: "Economy",
  paidCents: 84_000,
  currency: "USD",
  slices: [
    [
      { carrier: "UA", flightNumber: "1234", origin: "SFO", destination: "DEN", departureLocal: "2030-03-10T07:00", arrivalLocal: "2030-03-10T10:30" },
      { carrier: "UA", flightNumber: "567", origin: "DEN", destination: "BOS", departureLocal: "2030-03-10T11:45", arrivalLocal: "2030-03-10T17:20" },
    ],
    [
      { carrier: "UA", flightNumber: "890", origin: "BOS", destination: "SFO", departureLocal: "2030-03-17T18:00", arrivalLocal: "2030-03-17T21:45" },
    ],
  ],
};
