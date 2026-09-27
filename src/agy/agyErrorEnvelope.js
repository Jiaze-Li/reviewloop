import { agyObjectCarriesUsageEvidence } from './agyUsageEvidence.js';

// Safe, content-free inspection of an `agy --output-format json` reply when
// the CLI exits non-zero.
//
// Why this exists: src/agy/agyClient.js already DISCARDS stdout on a non-zero
// exit (it throws AgyExitError carrying only stderr, which is operational
// diagnostics — auth / quota / rate-limit — never prompt or reply text). That
// is the correct default. But when diagnosing a reproducible non-zero exit we
// still want to know *why* agy failed, and agy sometimes prints a structured
// error envelope to stdout before exiting non-zero. This helper lets a
// diagnostic caller pull ONLY the documented envelope/error metadata out of
// that stdout — never the model's generated text.
//
// Envelope keys that are known to carry operational metadata (not model
// output). Anything not on this list is dropped rather than echoed.
const SAFE_SCALAR_KEYS = [
  'status',
  'state',
  'error_code',
  'errorCode',
  'code',
  'error_type',
  'errorType',
  'type',
  'reason',
  'model',
  'finish_reason',
  'finishReason',
  'stop_reason',
  'stopReason',
];

// Usage / context-limit sub-objects: numeric only. String values inside a
// "usage"-shaped object are refused, since a model could smuggle text there.
const USAGE_KEYS = ['usage', 'token_usage', 'tokenUsage', 'metadata', 'meta'];

function pickSafeScalars(obj) {
  const out = {};
  for (const key of SAFE_SCALAR_KEYS) {
    if (!(key in obj)) continue;
    const v = obj[key];
    if (typeof v === 'string') {
      // Bound the length hard — an error string is short; anything long is
      // suspect and gets truncated so it can never carry a full reply.
      out[key] = v.length > 200 ? `${v.slice(0, 200)}…` : v;
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out[key] = v;
    }
  }
  return out;
}

function pickNumericTree(value, depth = 0) {
  if (depth > 3) return undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const picked = pickNumericTree(v, depth + 1);
      if (picked !== undefined) out[k] = picked;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return undefined;
}

/**
 * @param {string} stdout  raw stdout captured from a non-zero `agy` exit
 * @returns {{ parsed: boolean, jsonObject: boolean, fields: object,
 *             usageEvidenceState: 'absent'|'present'|'unknown',
 *             note?: string }}
 *   `fields` contains only whitelisted operational metadata. The generated
 *   response text is never included, even if present in the envelope.
 */
export function extractSafeAgyEnvelopeMetadata(stdout) {
  if (typeof stdout !== 'string' || stdout.trim() === '') {
    return {
      parsed: false,
      jsonObject: false,
      fields: {},
      usageEvidenceState: 'absent',
      note: 'no stdout captured',
    };
  }

  let json;
  try {
    json = JSON.parse(stdout.trim());
  } catch {
    return {
      parsed: false,
      jsonObject: false,
      fields: {},
      usageEvidenceState: 'unknown',
      note: 'stdout was not valid JSON — not echoed (may contain model text)',
    };
  }

  const usageEvidenceState = agyObjectCarriesUsageEvidence(json) ? 'present' : 'absent';

  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return {
      parsed: true,
      jsonObject: false,
      fields: {},
      usageEvidenceState,
      note: 'stdout JSON was not an object',
    };
  }

  const fields = pickSafeScalars(json);

  // A nested "error" object is common; take safe scalars from it too.
  if (json.error && typeof json.error === 'object' && !Array.isArray(json.error)) {
    Object.assign(fields, pickSafeScalars(json.error));
  }

  for (const key of USAGE_KEYS) {
    if (key in json) {
      const numeric = pickNumericTree(json[key]);
      if (numeric !== undefined) fields[key] = numeric;
    }
  }

  return { parsed: true, jsonObject: true, fields, usageEvidenceState };
}
