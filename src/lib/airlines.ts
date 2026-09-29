/**
 * How travellers typically capture a fare drop, by marketing carrier. Policies change often and
 * depend on fare type and point of sale, so the copy always tells people to confirm with the airline.
 */
const POLICIES: Record<string, string> = {
  AA: "American Airlines doesn't charge change fees on most Main Cabin and above fares booked from the US — rebook the same flights and keep the difference as a Trip Credit.",
  DL: "Delta doesn't charge change fees on Main Cabin and above for most itineraries — rebook the same flights and receive the difference as an eCredit.",
  UA: "United doesn't charge change fees on Economy and above for most itineraries — rebook the same flights and keep the difference as a travel credit.",
  AS: "Alaska Airlines doesn't charge change fees on Main and above — rebook the same flights and keep the difference as a credit.",
  WN: "Southwest lets you change to a lower fare and keep the difference as travel funds (or a refund on refundable fares).",
  B6: "JetBlue waives change fees on most fares other than Blue Basic — rebook the same flights and keep the difference as a travel credit.",
  HA: "Hawaiian Airlines doesn't charge change fees on Main Cabin and above — rebook and keep the difference as a credit.",
};

const GENERIC =
  "Check your fare rules: if your ticket allows free changes, rebooking the same flights at the lower fare usually returns the difference as a travel credit. Recently booked? Many tickets can be cancelled free within 24 hours.";

export function rebookAdvice(carrier: string | undefined, fareBrand: string | null): string {
  if (fareBrand && /basic/i.test(fareBrand)) {
    return "Basic economy fares usually can't be changed, but if you booked within the last 24 hours you may be able to cancel for a full refund and rebook at the lower price.";
  }
  const policy = carrier ? POLICIES[carrier] : undefined;
  return `${policy ?? GENERIC} Always confirm the fare rules with the airline before rebooking.`;
}
