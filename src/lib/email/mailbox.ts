import { config } from "../config";
import { htmlToText } from "./normalize";

export interface MailboxMessage {
  id: string;
  subject: string;
  from: string | null;
  text: string;
}

export interface MailboxProvider {
  id: "gmail" | "outlook";
  label: string;
  isConfigured(): boolean;
  authUrl(state: string): string;
  exchangeCode(code: string): Promise<{ refreshToken: string; email: string }>;
  /** Returns recent messages likely to be flight confirmations, plus the (possibly rotated) refresh token. */
  fetchCandidates(refreshToken: string, sinceDays: number): Promise<{ refreshToken: string; messages: MailboxMessage[] }>;
}

const redirectUri = (provider: string) => `${config.appUrl}/api/connect/${provider}/callback`;

async function postForm(url: string, params: Record<string, string>) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`OAuth token error ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

async function getJson<T>(url: string, accessToken: string): Promise<T> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`${new URL(url).host} error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

// Subject keywords used by airlines and hotel chains for booking confirmations.
const SUBJECT_TERMS = ["flight confirmation", "itinerary", "e-ticket", "eticket", "booking confirmation", "trip confirmation", "your flight", "reservation confirmation", "travel receipt", "your reservation", "your stay", "hotel confirmation"];

// ---------------- Gmail ----------------

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
  headers?: { name: string; value: string }[];
}

function gmailBody(part: GmailPart): { html: string; text: string } {
  const out = { html: "", text: "" };
  const walk = (p: GmailPart) => {
    const data = p.body?.data ? Buffer.from(p.body.data, "base64url").toString("utf8") : "";
    if (p.mimeType === "text/html" && data) out.html += data;
    else if (p.mimeType === "text/plain" && data) out.text += data;
    p.parts?.forEach(walk);
  };
  walk(part);
  return out;
}

export const gmail: MailboxProvider = {
  id: "gmail",
  label: "Gmail",
  isConfigured: () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
  authUrl(state) {
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      redirect_uri: redirectUri("gmail"),
      response_type: "code",
      scope: "openid email https://www.googleapis.com/auth/gmail.readonly",
      access_type: "offline",
      prompt: "consent",
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  },
  async exchangeCode(code) {
    const tokens = await postForm("https://oauth2.googleapis.com/token", {
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri("gmail"),
      grant_type: "authorization_code",
    });
    const info = await getJson<{ email: string }>("https://openidconnect.googleapis.com/v1/userinfo", String(tokens.access_token));
    if (!tokens.refresh_token) throw new Error("Google did not return a refresh token");
    return { refreshToken: String(tokens.refresh_token), email: info.email };
  },
  async fetchCandidates(refreshToken, sinceDays) {
    const tokens = await postForm("https://oauth2.googleapis.com/token", {
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      grant_type: "refresh_token",
    });
    const access = String(tokens.access_token);
    const q = `newer_than:${sinceDays}d {${SUBJECT_TERMS.map((t) => `subject:"${t}"`).join(" ")}}`;
    const list = await getJson<{ messages?: { id: string }[] }>(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=50&q=${encodeURIComponent(q)}`,
      access,
    );
    const messages: MailboxMessage[] = [];
    for (const { id } of list.messages ?? []) {
      const msg = await getJson<{ id: string; payload: GmailPart }>(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
        access,
      );
      const header = (name: string) => msg.payload.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? null;
      const body = gmailBody(msg.payload);
      messages.push({
        id: msg.id,
        subject: header("subject") ?? "",
        from: header("from"),
        text: body.html ? htmlToText(body.html) : body.text,
      });
    }
    return { refreshToken, messages };
  },
};

// ---------------- Outlook / Microsoft 365 ----------------

const MS_SCOPES = "openid email offline_access https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read";

export const outlook: MailboxProvider = {
  id: "outlook",
  label: "Outlook",
  isConfigured: () => Boolean(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET),
  authUrl(state) {
    const params = new URLSearchParams({
      client_id: process.env.MICROSOFT_CLIENT_ID!,
      redirect_uri: redirectUri("outlook"),
      response_type: "code",
      response_mode: "query",
      scope: MS_SCOPES,
      state,
    });
    return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`;
  },
  async exchangeCode(code) {
    const tokens = await postForm("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
      code,
      client_id: process.env.MICROSOFT_CLIENT_ID!,
      client_secret: process.env.MICROSOFT_CLIENT_SECRET!,
      redirect_uri: redirectUri("outlook"),
      grant_type: "authorization_code",
      scope: MS_SCOPES,
    });
    const me = await getJson<{ mail: string | null; userPrincipalName: string }>(
      "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName",
      String(tokens.access_token),
    );
    return { refreshToken: String(tokens.refresh_token), email: me.mail ?? me.userPrincipalName };
  },
  async fetchCandidates(refreshToken, sinceDays) {
    const tokens = await postForm("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
      refresh_token: refreshToken,
      client_id: process.env.MICROSOFT_CLIENT_ID!,
      client_secret: process.env.MICROSOFT_CLIENT_SECRET!,
      grant_type: "refresh_token",
      scope: MS_SCOPES,
    });
    const access = String(tokens.access_token);
    const since = new Date(Date.now() - sinceDays * 86400_000).toISOString();
    const subjectFilter = SUBJECT_TERMS.map((t) => `contains(subject,'${t}')`).join(" or ");
    const params = new URLSearchParams({
      $filter: `receivedDateTime ge ${since} and (${subjectFilter})`,
      $select: "id,subject,from,body",
      $top: "50",
    });
    const list = await getJson<{
      value: { id: string; subject: string; from?: { emailAddress?: { address?: string } }; body: { contentType: string; content: string } }[];
    }>(`https://graph.microsoft.com/v1.0/me/messages?${params}`, access);
    return {
      // Microsoft rotates refresh tokens; persist the newest one.
      refreshToken: tokens.refresh_token ? String(tokens.refresh_token) : refreshToken,
      messages: list.value.map((m) => ({
        id: m.id,
        subject: m.subject ?? "",
        from: m.from?.emailAddress?.address ?? null,
        text: m.body.contentType === "html" ? htmlToText(m.body.content) : m.body.content,
      })),
    };
  },
};

export const mailboxProviders = { gmail, outlook } as const;
export type MailboxProviderId = keyof typeof mailboxProviders;
