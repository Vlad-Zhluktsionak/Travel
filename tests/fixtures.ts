import type { ParsedFlight, ParsedHotel } from "../src/lib/types";

export const roundTrip: ParsedFlight = {
  kind: "flight",
  confirmationCode: "ABC123",
  paidCents: 84_000,
  currency: "USD",
  details: {
    airline: "United Airlines",
    bookingSite: null,
    passengerNames: ["JANE DOE", "JOHN DOE"],
    passengerCount: 2,
    cabin: "economy",
    fareBrand: "Economy",
    slices: [
      [
        { carrier: "UA", flightNumber: "1234", origin: "SFO", destination: "DEN", departureLocal: "2030-03-10T07:00", arrivalLocal: "2030-03-10T10:30" },
        { carrier: "UA", flightNumber: "567", origin: "DEN", destination: "BOS", departureLocal: "2030-03-10T11:45", arrivalLocal: "2030-03-10T17:20" },
      ],
      [{ carrier: "UA", flightNumber: "890", origin: "BOS", destination: "SFO", departureLocal: "2030-03-17T18:00", arrivalLocal: "2030-03-17T21:45" }],
    ],
  },
};

export const hotelStay: ParsedHotel = {
  kind: "hotel",
  confirmationCode: "78123456",
  paidCents: 90_000,
  currency: "USD",
  details: {
    hotelName: "Hyatt Regency Chicago",
    chain: "hyatt",
    city: "Chicago",
    address: "151 E Wacker Dr, Chicago, IL",
    checkIn: "2030-04-02",
    checkOut: "2030-04-05",
    adults: 2,
    rooms: 1,
    roomType: "1 King Bed",
    rateName: "Member Rate",
    refundable: true,
    cancelBy: "2030-04-01",
    propertyToken: null,
  },
};
