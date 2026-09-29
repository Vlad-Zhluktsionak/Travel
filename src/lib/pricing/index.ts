import { config } from "../config";
import { DuffelPriceProvider } from "./duffel";
import { MockPriceProvider } from "./mock";
import type { PriceProvider } from "./provider";

export type { PriceProvider, PriceQuote } from "./provider";

export function getPriceProvider(): PriceProvider {
  if (config.priceProvider === "duffel") {
    const token = process.env.DUFFEL_ACCESS_TOKEN;
    if (!token) throw new Error("PRICE_PROVIDER=duffel requires DUFFEL_ACCESS_TOKEN");
    return new DuffelPriceProvider(token);
  }
  return new MockPriceProvider();
}
