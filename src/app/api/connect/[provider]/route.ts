import { NextResponse, type NextRequest } from "next/server";
import { config } from "@/lib/config";
import { mailboxProviders, type MailboxProviderId } from "@/lib/email/mailbox";
import { currentUser } from "@/lib/session";
import { signValue } from "@/lib/sign";

/** Start the OAuth flow to connect a Gmail or Outlook mailbox (read-only). */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  const { provider: id } = await ctx.params;
  const provider = mailboxProviders[id as MailboxProviderId];
  const user = await currentUser();
  if (!provider || !user) return NextResponse.redirect(`${config.appUrl}/`);
  if (!provider.isConfigured()) return NextResponse.redirect(`${config.appUrl}/?error=${id}-not-configured`);
  const state = signValue({ uid: user.id, p: provider.id }, 600);
  return NextResponse.redirect(provider.authUrl(state));
}
