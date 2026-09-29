import { NextResponse, after, type NextRequest } from "next/server";
import { config } from "@/lib/config";
import { mailboxProviders, type MailboxProviderId } from "@/lib/email/mailbox";
import { syncConnection } from "@/lib/email/sync";
import * as repo from "@/lib/repo";
import { currentUser } from "@/lib/session";
import { verifyValue } from "@/lib/sign";

export const maxDuration = 300;

export async function GET(req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  const { provider: id } = await ctx.params;
  const provider = mailboxProviders[id as MailboxProviderId];
  const user = await currentUser();
  const state = verifyValue<{ uid: number; p: string }>(req.nextUrl.searchParams.get("state"));
  const code = req.nextUrl.searchParams.get("code");

  if (!provider || !user || !state || state.uid !== user.id || state.p !== provider.id || !code) {
    return NextResponse.redirect(`${config.appUrl}/?error=connect-failed`);
  }

  try {
    const { refreshToken, email } = await provider.exchangeCode(code);
    repo.saveConnection(user.id, provider.id, email, refreshToken);
  } catch (err) {
    console.error(`${provider.label} connection failed`, err);
    return NextResponse.redirect(`${config.appUrl}/?error=connect-failed`);
  }

  // Kick off the first scan after responding so the user isn't left waiting on a spinner.
  after(async () => {
    const connection = repo.listConnections(user.id).find((c) => c.provider === provider.id && !c.lastSyncedAt);
    if (connection) await syncConnection(connection).catch((err) => console.error("Initial sync failed", err));
  });

  return NextResponse.redirect(`${config.appUrl}/?connected=${provider.id}`);
}
