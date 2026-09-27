// Conservative, content-free usage-evidence detection for AGY error paths.
//
// ReviewLoop may treat only a mechanically proven pre-send auth rejection as
// zero-token. Any explicit usage-shaped field is evidence of possible spend;
// any opaque non-empty stdout that cannot be parsed safely is UNKNOWN, never
// proof of zero.

export const AGY_USAGE_CONTAINER_KEYS = new Set([
  'usage', 'token_usage', 'tokenUsage', 'metadata', 'meta',
]);

export const AGY_TOKEN_COUNT_KEY_RE =
  /^(?:input|output|prompt|completion|total|thinking|cached?|cache[_ -]?(?:read|write|creation))[_ -]?tokens?$/i;

export function agyObjectCarriesUsageEvidence(value, depth = 0) {
  if (depth > 8 || value == null) return false;
  if (Array.isArray(value)) {
    return value.some((item) => agyObjectCarriesUsageEvidence(item, depth + 1));
  }
  if (typeof value !== 'object') return false;

  for (const [key, child] of Object.entries(value)) {
    if (AGY_USAGE_CONTAINER_KEYS.has(key) || AGY_TOKEN_COUNT_KEY_RE.test(key)) return true;
    if (agyObjectCarriesUsageEvidence(child, depth + 1)) return true;
  }
  return false;
}

function stderrJsonCarriesUsageEvidence(text) {
  const candidates = new Set();
  const chunks = [
    String(text ?? '').trim(),
    ...String(text ?? '').split(/\r?\n/).map((s) => s.trim()),
  ].filter(Boolean);

  for (const chunk of chunks) {
    candidates.add(chunk);
    const objectStart = chunk.indexOf('{');
    const objectEnd = chunk.lastIndexOf('}');
    if (objectStart >= 0 && objectEnd > objectStart) {
      candidates.add(chunk.slice(objectStart, objectEnd + 1));
    }
    const arrayStart = chunk.indexOf('[');
    const arrayEnd = chunk.lastIndexOf(']');
    if (arrayStart >= 0 && arrayEnd > arrayStart) {
      candidates.add(chunk.slice(arrayStart, arrayEnd + 1));
    }
  }

  for (const candidate of candidates) {
    try {
      if (agyObjectCarriesUsageEvidence(JSON.parse(candidate))) return true;
    } catch {
      // Mixed prose + JSON or malformed diagnostics fall through to the
      // field-label detector below.
    }
  }
  return false;
}

export function agyStderrCarriesUsageEvidence(stderr) {
  const text = String(stderr ?? '');
  const normalized = text.replace(/\\(["'])/g, '$1');

  // Do not match the canonical phrase "OAuth 2 access token". Require an
  // explicit usage/token-count FIELD label with a separator. Its value may be
  // numeric or unresolved: UNKNOWN != ZERO.
  const tokenCountField =
    /(?:^|[\s,{[(])["']?(?:input|output|prompt|completion|total|thinking|cached?|cache[_ -]?(?:read|write|creation))[_ -]?tokens?["']?\s*[:=]/i;
  const usageField =
    /(?:^|[\s,{[(])["']?(?:token[_ -]?usage|usage(?:[_ -]?(?:tokens?|count|volume))?)["']?\s*[:=]/i;

  return tokenCountField.test(normalized)
    || usageField.test(normalized)
    || stderrJsonCarriesUsageEvidence(normalized);
}
