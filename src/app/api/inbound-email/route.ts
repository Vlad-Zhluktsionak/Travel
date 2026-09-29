import crypto from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { config } from "@/lib/config";
import { forwardTokenFromAddresses, normalizeInbound } from "@/lib/email/normalize";
import { describeBooking, ingestEmail } from "@/lib/ingest";
import { sendEmail } from "@/lib/notify";
import * as repo from "@/lib/repo";

export const maxDuration = 120;

function secretMatches(provided: string | null) {
  const expected = config.inboundSecret;
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Webhook for forwarded confirmation emails. Point your inbound mail provider
 * (Postmark / SendGrid Inbound Parse / Mailgun Routes) at /api/inbound-email?secret=INBOUND_SECRET.
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

  // Route by the personal forwarding address first, then by the sender's registered email.
  const token = forwardTokenFromAddresses(email.to, config.inboundDomain);
  const user = (token && repo.findUserByForwardToken(token)) || (email.from && repo.findUserByEmail(email.from)) || null;
  if (!user) {
    // 200 so the mail provider doesn't retry an email we'll never be able to route.
    return NextResponse.json({ ok: false, reason: "unknown recipient" });
  }

  if (email.messageId && !repo.markMessageProcessed(user.id, "forward", email.messageId)) {
    return NextResponse.json({ ok: true, duplicate: true });
  }

  let reply: { subject: string; text: string };
  try {
    const result = await ingestEmail(user.id, email, "forward");
    reply = result.ok
      ? {
          subject: result.created ? "✈️ We're watching your flight price" : "✈️ Trip updated",
          text: `Got it! We're now tracking ${describeBooking(result.booking)} and will email you if the price drops.\n\n${config.appUrl}/trips/${result.booking.id}`,
        }
      : {
          subject: "We couldn't track that email",
          text: `We couldn't find a flight booking we can track in "${email.subject}": ${result.reason}\n\nTip: forward the airline's original confirmation email (with flight numbers, dates and the price paid).`,
        };
  } catch (err) {
    if (email.messageId) repo.unmarkMessageProcessed(user.id, "forward", email.messageId);
    console.error("Inbound ingestion failed", err);
    // 500 lets the inbound provider retry later.
    return NextResponse.json({ ok: false, reason: "processing failed" }, { status: 500 });
  }

  await sendEmail({ to: user.email, ...reply }).catch((err) => console.error("Reply email failed", err));
  return NextResponse.json({ ok: true });
}
