/** Split address lists without splitting quoted display names or angle addresses. */
export function splitRecipientTokens(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let angle = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (quoted && char === "\\") { i++; continue; }
    if (char === '"') quoted = !quoted;
    if (!quoted) {
      if (char === "<") angle = true;
      if (char === ">") angle = false;
      if (!angle && (char === "," || char === ";")) {
        parts.push(value.slice(start, i).trim());
        start = i + 1;
      }
    }
  }
  parts.push(value.slice(start).trimStart());
  return parts;
}


export function parseRecipients(value: string): string[] {
  return splitRecipientTokens(value).map((part) => part.trim()).filter(Boolean);
}

export function formatRecipient(email: string, name?: string | null): string {
  if (!name) return email;
  const displayName = /[,;"\\]/.test(name) ? `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : name;
  return `${displayName} <${email}>`;
}

/** Bare address of a recipient token ("Name <a@b.c>" → "a@b.c"). */
export function recipientEmail(token: string): string {
  const match = /<([^<>]*)>\s*$/.exec(token);
  return (match ? match[1] : token).trim();
}

const EMAIL_PATTERN = /^[^\s@<>(),;:"[\]\\]+@[^\s@<>(),;:"[\]\\]+\.[^\s@<>(),;:"[\]\\]+$/;

/** Basic client-side email check; the server performs the authoritative validation. */
export function isValidEmail(email: string): boolean {
  return EMAIL_PATTERN.test(email);
}

export interface ParsedMailbox {
  email: string;
  name: string;
}

/**
 * Parse many addresses separated by commas, semicolons or newlines, accepting
 * `email`, `Name <email>` and `"Name" <email>`. Invalid entries are returned
 * verbatim so the caller can show them.
 */
export function parseMailboxList(text: string): { valid: ParsedMailbox[]; invalid: string[] } {
  const valid: ParsedMailbox[] = [];
  const invalid: string[] = [];
  for (const raw of splitRecipientTokens(text.replace(/\r?\n/g, ","))) {
    const token = raw.trim();
    if (!token) continue;
    const angle = /^(.*)<([^<>]*)>\s*$/.exec(token);
    const email = (angle ? angle[2] : token).trim();
    let name = angle ? angle[1].trim() : "";
    if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) {
      name = name.slice(1, -1).replace(/\\(.)/g, "$1");
    }
    if (isValidEmail(email)) valid.push({ email, name });
    else invalid.push(token);
  }
  return { valid, invalid };
}

/** A distribution list inserted into a recipient field as one chip. */
export interface ListRecipient {
  /** Server id of the list (the member snapshot below is what gets sent). */
  id: string;
  name: string;
  members: ParsedMailbox[];
}

// Starts with "@" so it can never be mistaken for a typed address. The payload is
// URI-encoded, so it contains no separators, quotes or angle brackets.
const LIST_TOKEN_PREFIX = "@list:";

/** Encode a list chip, with a snapshot of its members, as a recipient token. */
export function encodeListRecipient(list: ListRecipient): string {
  const payload = { id: list.id, name: list.name, members: list.members.map((m) => ({ email: m.email, name: m.name })) };
  return LIST_TOKEN_PREFIX + encodeURIComponent(JSON.stringify(payload));
}

export function isListRecipientToken(token: string): boolean {
  return token.trim().startsWith(LIST_TOKEN_PREFIX);
}

export function decodeListRecipient(token: string): ListRecipient | null {
  const trimmed = token.trim();
  if (!trimmed.startsWith(LIST_TOKEN_PREFIX)) return null;
  try {
    const data = JSON.parse(decodeURIComponent(trimmed.slice(LIST_TOKEN_PREFIX.length))) as Partial<ListRecipient>;
    if (typeof data.id !== "string" || typeof data.name !== "string" || !Array.isArray(data.members)) return null;
    const members = data.members
      .filter((m): m is ParsedMailbox => !!m && typeof m.email === "string")
      .map((m) => ({ email: m.email, name: typeof m.name === "string" ? m.name : "" }));
    return { id: data.id, name: data.name, members };
  } catch {
    return null;
  }
}

/**
 * Recipient tokens ready to send or save: list chips are replaced by their
 * member addresses and duplicates (case-insensitive) within the field are dropped.
 * A token that looks like a list but cannot be decoded is dropped rather than
 * sent as a literal.
 */
export function expandRecipients(value: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const add = (formatted: string, email: string) => {
    const key = email.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    result.push(formatted);
  };
  for (const token of parseRecipients(value)) {
    if (isListRecipientToken(token)) {
      const list = decodeListRecipient(token);
      for (const member of list?.members ?? []) add(formatRecipient(member.email, member.name), member.email);
    } else {
      add(token, recipientEmail(token));
    }
  }
  return result;
}

/** A recipient field as a plain address string (for drafts), with list chips expanded. */
export function serializeRecipientField(value: string): string {
  return expandRecipients(value).join(", ");
}
