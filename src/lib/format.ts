export function formatMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/** "2026-11-03T08:15" → "Tue, Nov 3 · 08:15" (the time is already local to the airport). */
export function formatLocal(isoLocal: string): string {
  const [date, time] = isoLocal.split("T");
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  return time ? `${day} · ${time.slice(0, 5)}` : day;
}
