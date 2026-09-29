import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { config } from "./config";
import { findUserById } from "./repo";
import { signValue, verifyValue } from "./sign";
import type { User } from "./types";

const COOKIE = "fw_session";
const THIRTY_DAYS = 30 * 24 * 3600;

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
  return data ? findUserById(data.uid) : null;
}

export async function requireUser(): Promise<User> {
  const user = await currentUser();
  if (!user) redirect("/");
  return user;
}
