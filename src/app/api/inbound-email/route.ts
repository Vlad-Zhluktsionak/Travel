import crypto from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { config } from "@/lib/config";
import { forwardTokenFromAddresses, normalizeInbound } from "@/lib/email/normalize";
import { describeBooking, ingestEmail } from "@/lib/ingest";
import { sendEmail } from "@/lib/notify";
import * as repo from "@/lib/repo";
import { isEmailAllowed } from "@/lib/session";
import type { User } from "@/lib/types";

export const maxDuration = 120;

function secretMatches(provided: string | null) {
  const expected = config.inboundSecret;
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Personal forwarding address first, then a registered user among the recipients, then the sender. */
async function routeToUser(to: string[], from: string | null): Promise<User | null> {
  const token = forwardTokenFromAddresses(to, config.inboundDomain);
  if (token) {
    const user = await repo.findUserByForwardToken(token);
    if (user) return user;
  }
  for (const address of [...to, ...(from ? [from] : [])]) {
    const user = await repo.findUserByEmail(address);
    if (user) return user;
  }
  return null;
}

/**
 * Webhook for confirmation emails, called by:
 * - the Gmail Apps Script in scripts/gmail-apps-script.gs (sends `Source: "gmail-script"`), or
 * - an inbound mail service (Postmark / SendGrid Inbound Parse / Mailgun Routes) for the forwarding address.
 * URL: /api/inbound-email?secret=INBOUND_SECRET
 */
export async function POST(req: NextRequest) {
  if (!secretMatches(req.nextUrl.searchParams.get("secret"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    payload = (await req.json()) as Record<string, unknown>;
  } else {
    payload = Object.fromEntries([...(await req.formData()).entries()].filter(([, v]) => typeof v === "string"));
  }

  const email = normalizeInbound(payload);
  const source = payload.Source === "gmail-script" ? "gmail-script" : "forward";

  const user = await routeToUser(email.to, email.from);
  if (!user || !isEmailAllowed(user.email)) {
    // 200 so the sender doesn't retry an email we'll never be able to route.
    return NextResponse.json({ ok: false, reason: "unknown recipient" });
  }

  if (email.messageId && !(await repo.markMessageProcessed(user.id, source, email.messageId))) {
    return NextResponse.json({ ok: true, duplicate: true });
  }

  let result;
  try {
    result = await ingestEmail(user.id, email, source);
  } catch (err) {
    if (email.messageId) await repo.unmarkMessageProcessed(user.id, source, email.messageId);
    console.error("Inbound ingestion failed", err);
    // 500 lets the sender retry later.
    return NextResponse.json({ ok: false, reason: "processing failed" }, { status: 500 });
  }

  // The Gmail script scans automatically, so only confirm successes; a manual forward always gets a reply.
  if (result.ok || source === "forward") {
    const icon = result.ok && result.booking.kind === "hotel" ? "🏨" : "✈️";
    const reply = result.ok
      ? {
          subject: `${icon} ${result.created ? "We're watching the price" : "Trip updated"}`,
          text: `Got it! We're now tracking ${describeBooking(result.booking)} and will email you if the price drops.\n\n${config.appUrl}/trips/${result.booking.id}`,
        }
      : {
          subject: "We couldn't track that email",
          text: `We couldn't find a booking we can track in "${email.subject}": ${result.reason}\n\nTip: forward the original confirmation email (with dates and the price paid).`,
        };
    await sendEmail({ to: user.email, ...reply }).catch((err) => console.error("Reply email failed", err));
  }

  return NextResponse.json(result.ok ? { ok: true, bookingId: result.booking.id } : { ok: false, reason: result.reason });
}
