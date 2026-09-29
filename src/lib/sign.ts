import crypto from "node:crypto";
import { config } from "./config";

const mac = (payload: string) => crypto.createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");

/** Produce `base64url(json).signature`, valid until `ttlSeconds` from now. */
export function signValue(data: Record<string, unknown>, ttlSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ ...data, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString("base64url");
  return `${payload}.${mac(payload)}`;
}

export function verifyValue<T extends Record<string, unknown>>(value: string | undefined | null): T | null {
  if (!value) return null;
  const [payload, signature] = value.split(".");
  if (!payload || !signature) return null;
  const expected = Buffer.from(mac(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as T & { exp: number };
    if (typeof data.exp !== "number" || data.exp < Date.now() / 1000) return null;
    return data;
  } catch {
    return null;
  }
}
