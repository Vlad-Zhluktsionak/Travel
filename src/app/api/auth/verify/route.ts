import { NextResponse, type NextRequest } from "next/server";
import { config } from "@/lib/config";
import { consumeLoginToken } from "@/lib/repo";
import { startSession } from "@/lib/session";

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  const userId = token ? await consumeLoginToken(token) : null;
  if (!userId) return NextResponse.redirect(`${config.appUrl}/?error=link-expired`);
  await startSession(userId);
  return NextResponse.redirect(`${config.appUrl}/`);
}
