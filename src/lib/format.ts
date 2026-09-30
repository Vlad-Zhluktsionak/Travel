export function formatMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/** "2026-11-03" → "Tue, Nov 3" (dates are local to the airport/hotel, so format in UTC). */
export function formatDate(isoDate: string): string {
  return new Date(`${isoDate.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** "2026-11-03T08:15" → "Tue, Nov 3 · 08:15" (the time is already local to the airport). */
export function formatLocal(isoLocal: string): string {
  const [date, time] = isoLocal.split("T");
  return time ? `${formatDate(date)} · ${time.slice(0, 5)}` : formatDate(date);
}

/** Display timezone for timestamps (price checks, alerts). Set APP_TIMEZONE to override. */
const displayTimeZone = () => process.env.APP_TIMEZONE || "America/Los_Angeles";

/** SQLite "YYYY-MM-DD HH:MM:SS" (UTC) → "9/29/2026, 9:07 PM" in the display timezone. */
export function formatTimestamp(sqlUtc: string, dateOnly = false): string {
  const d = new Date(`${sqlUtc.replace(" ", "T")}Z`);
  const opts: Intl.DateTimeFormatOptions = { timeZone: displayTimeZone() };
  return dateOnly
    ? d.toLocaleDateString("en-US", opts)
    : d.toLocaleString("en-US", { ...opts, dateStyle: "short", timeStyle: "short" });
}
