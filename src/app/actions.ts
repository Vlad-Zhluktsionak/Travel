"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { config } from "@/lib/config";
import { syncConnection } from "@/lib/email/sync";
import { htmlToText } from "@/lib/email/normalize";
import { ExtractionError } from "@/lib/extract";
import { describeBooking, ingestEmail } from "@/lib/ingest";
import { checkBooking } from "@/lib/monitor";
import { sendEmail } from "@/lib/notify";
import * as repo from "@/lib/repo";
import { endSession, requireUser } from "@/lib/session";

export interface FormState {
  ok?: boolean;
  message?: string;
  devLink?: string;
}

export async function requestLogin(_prev: FormState, form: FormData): Promise<FormState> {
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, message: "Enter a valid email address." };

  const user = repo.findOrCreateUser(email);
  const link = `${config.appUrl}/api/auth/verify?token=${repo.createLoginToken(user.id)}`;
  await sendEmail({
    to: email,
    subject: "Your FareWatch sign-in link",
    text: `Click to sign in (valid for 20 minutes):\n\n${link}\n\nIf you didn't request this, ignore this email.`,
  });
  return {
    ok: true,
    message: "Check your inbox for a sign-in link.",
    // Without an email provider configured, show the link so local development works end to end.
    devLink: !config.isProduction && !process.env.RESEND_API_KEY ? link : undefined,
  };
}

export async function logout() {
  await endSession();
  redirect("/");
}

export async function addFromPastedEmail(_prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  const raw = String(form.get("email") ?? "").trim();
  if (raw.length < 40) return { ok: false, message: "Paste the full confirmation email, including flight details and price." };
  const text = /<\/?(html|table|div|td|p)\b/i.test(raw) ? htmlToText(raw) : raw;
  const subject = text.match(/^subject:\s*(.+)$/im)?.[1] ?? "Pasted email";

  try {
    const result = await ingestEmail(user.id, { subject, text }, "paste");
    if (!result.ok) return { ok: false, message: result.reason };
    revalidatePath("/");
    return { ok: true, message: `${result.created ? "Now tracking" : "Updated"} ${describeBooking(result.booking)}.` };
  } catch (err) {
    if (err instanceof ExtractionError) return { ok: false, message: err.message };
    console.error("Paste ingestion failed", err);
    return { ok: false, message: "Something went wrong reading that email. Please try again." };
  }
}

export async function updateThreshold(form: FormData) {
  const user = await requireUser();
  const dollars = Number(form.get("threshold"));
  if (Number.isFinite(dollars) && dollars >= 0 && dollars <= 10_000) {
    repo.updateThreshold(user.id, Math.round(dollars * 100));
  }
  revalidatePath("/");
}

export async function checkNow(form: FormData) {
  const user = await requireUser();
  const booking = repo.getBooking(Number(form.get("bookingId")), user.id);
  if (booking && booking.status === "active") await checkBooking(booking);
  revalidatePath(`/trips/${booking?.id}`);
  revalidatePath("/");
}

export async function setTracking(form: FormData) {
  const user = await requireUser();
  const id = Number(form.get("bookingId"));
  repo.setBookingStatus(id, form.get("active") === "1" ? "active" : "paused", user.id);
  revalidatePath(`/trips/${id}`);
  revalidatePath("/");
}

export async function removeBooking(form: FormData) {
  const user = await requireUser();
  repo.deleteBooking(Number(form.get("bookingId")), user.id);
  revalidatePath("/");
  redirect("/");
}

export async function syncMailbox(form: FormData) {
  const user = await requireUser();
  const connection = repo.listConnections(user.id).find((c) => c.id === Number(form.get("connectionId")));
  if (connection) await syncConnection(connection);
  revalidatePath("/");
}

export async function disconnectMailbox(form: FormData) {
  const user = await requireUser();
  repo.deleteConnection(user.id, Number(form.get("connectionId")));
  revalidatePath("/");
}
