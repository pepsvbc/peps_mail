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
