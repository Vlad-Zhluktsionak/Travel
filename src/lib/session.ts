import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { config } from "./config";
import { findUserById } from "./repo";
import { signValue, verifyValue } from "./sign";
import type { User } from "./types";

const COOKIE = "fw_session";
const THIRTY_DAYS = 30 * 24 * 3600;

export function isEmailAllowed(email: string): boolean {
  const allowed = config.allowedEmails;
  // Fail closed when deployed: an open sign-up would let strangers spend your API credits.
  if (allowed.length === 0) return !config.isProduction;
  return allowed.includes(email.trim().toLowerCase());
}

export async function startSession(userId: number) {
  (await cookies()).set(COOKIE, signValue({ uid: userId }, THIRTY_DAYS), {
    httpOnly: true,
    sameSite: "lax",
    secure: config.appUrl.startsWith("https://"),
    path: "/",
    maxAge: THIRTY_DAYS,
  });
}

export async function endSession() {
  (await cookies()).delete(COOKIE);
}

export async function currentUser(): Promise<User | null> {
  const data = verifyValue<{ uid: number }>((await cookies()).get(COOKIE)?.value);
  const user = data ? await findUserById(data.uid) : null;
  // Re-check the allowlist so removing an email from ALLOWED_EMAILS revokes existing sessions.
  return user && isEmailAllowed(user.email) ? user : null;
}

export async function requireUser(): Promise<User> {
  const user = await currentUser();
  if (!user) redirect("/");
  return user;
}
