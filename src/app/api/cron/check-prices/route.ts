import { NextResponse, type NextRequest } from "next/server";
import { config } from "@/lib/config";
import { syncAllConnections } from "@/lib/email/sync";
import { runMonitor } from "@/lib/monitor";

export const maxDuration = 300;

/** Scheduled job: pull new confirmations from connected mailboxes, then re-price every active trip. */
export async function GET(req: NextRequest) {
  const secret = config.cronSecret;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const mailboxes = await syncAllConnections();
  const prices = await runMonitor();
  return NextResponse.json({ mailboxes, prices });
}
