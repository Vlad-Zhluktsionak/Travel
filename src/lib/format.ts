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
