/** Minimal HTML → text conversion that keeps table/line structure readable for the model. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h[1-6]|table|section)>/gi, "\n")
      .replace(/<\/(td|th)>/gi, " \t ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

export interface InboundEmail {
  messageId: string | null;
  from: string | null;
  to: string[];
  subject: string;
  text: string;
}

/** Pull the bare address out of `"Name" <addr@x.com>`. */
export function extractAddress(value: string): string {
  const match = value.match(/<([^>]+)>/);
  return (match ? match[1] : value).trim().toLowerCase();
}

function splitAddresses(value: unknown): string[] {
  if (typeof value !== "string" || !value) return [];
  return value.split(",").map(extractAddress).filter(Boolean);
}

/**
 * Normalize inbound-mail webhook payloads from Postmark (JSON), SendGrid Inbound Parse (form)
 * and Mailgun Routes (form) into one shape.
 */
export function normalizeInbound(payload: Record<string, unknown>): InboundEmail {
  const str = (...keys: string[]) => {
    for (const key of keys) {
      const value = payload[key];
      if (typeof value === "string" && value.trim()) return value;
    }
    return "";
  };

  const to: string[] = [];
  if (Array.isArray(payload.ToFull)) {
    for (const entry of payload.ToFull as { Email?: string }[]) if (entry.Email) to.push(entry.Email.toLowerCase());
  }
  if (Array.isArray(payload.CcFull)) {
    for (const entry of payload.CcFull as { Email?: string }[]) if (entry.Email) to.push(entry.Email.toLowerCase());
  }
  to.push(...splitAddresses(str("To", "to", "recipient", "OriginalRecipient")));

  const fromFull = payload.FromFull as { Email?: string } | undefined;
  const fromRaw = fromFull?.Email ?? str("From", "from", "sender");

  const plain = str("TextBody", "text", "body-plain", "stripped-text");
  const html = str("HtmlBody", "html", "body-html", "stripped-html");
  // HTML usually carries the itinerary tables; fall back to plain text when that's all we have.
  const text = html ? htmlToText(html) : plain;

  return {
    messageId: str("MessageID", "Message-Id", "message-id") || null,
    from: fromRaw ? extractAddress(fromRaw) : null,
    to: [...new Set(to)],
    subject: str("Subject", "subject"),
    text,
  };
}

/** Find the per-user forwarding token in an address like `trips+abc123@in.example.com`. */
export function forwardTokenFromAddresses(addresses: string[], inboundDomain: string): string | null {
  for (const address of addresses) {
    const [local, domain] = address.split("@");
    if (!domain || domain.toLowerCase() !== inboundDomain.toLowerCase()) continue;
    const plus = local.indexOf("+");
    const token = plus >= 0 ? local.slice(plus + 1) : local;
    if (/^[a-f0-9]{10}$/i.test(token)) return token.toLowerCase();
  }
  return null;
}
