/**
 * Attempt to repair truncated or fence-wrapped JSON.
 * Strips markdown fences, trims whitespace, and attempts to close truncated objects.
 * Returns the repaired JSON string, or the original if repair is not possible.
 *
 * Generic JSON-repair helper — not provider-specific. Lives in core so both the
 * adapters (in @wasmagent/models) and core agents can share it.
 */
export function repairJson(raw: string): string {
  let s = raw.trim();
  s = s
    .replace(/^```(?:json)?\n?/i, "")
    .replace(/\n?```$/, "")
    .trim();
  if (!s) return raw;
  try {
    JSON.parse(s);
    return s;
  } catch {
    /* continue */
  }
  const openers: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of s) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") openers.push("}");
    else if (ch === "[") openers.push("]");
    else if (ch === "}" || ch === "]") openers.pop();
  }
  let repaired = s.replace(/,\s*$/, "");
  if (inString) repaired += '"';
  while (openers.length > 0) repaired += openers.pop();
  try {
    JSON.parse(repaired);
    return repaired;
  } catch {
    return raw;
  }
}
