import { config } from "./config";

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export type Mailer = (email: OutgoingEmail) => Promise<void>;

/** Sends through Resend when RESEND_API_KEY is set; otherwise logs the email (handy in development). */
export const sendEmail: Mailer = async (email) => {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.log(`\n[email] to=${email.to}\nSubject: ${email.subject}\n\n${email.text}\n`);
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: config.emailFrom, to: [email.to], subject: email.subject, text: email.text, html: email.html }),
  });
  if (!res.ok) throw new Error(`Resend error ${res.status}: ${await res.text()}`);
};

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
