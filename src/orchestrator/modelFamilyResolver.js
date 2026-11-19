// Deterministic, zero-token model-FAMILY resolution.
//
// ReviewLoop's stable configuration binds a role to a stable FAMILY IDENTITY
// (provider + model family + role intent) — never to a concrete released model
// version. Concrete versions move (Gemini 3.7 -> 3.8, GPT-OSS revisions, Codex
// / Claude defaults) and ReviewLoop source must not need editing when they do.
//
//   CONFIGURATION = stable family identity        (this repo, in source)
//   RUNTIME       = resolve the current provider/agent default or the latest
//                   eligible concrete model / stable provider alias
//   TELEMETRY     = persist the concrete resolved model actually used
//                   (reviewSpend.js durable spend records + reservation ledger)
//
// Resolution order for a family:
//   1. explicit env override (pins a concrete model — for tests / benchmark /
//      reproducibility only; NEVER a long-term production default)
//   2. runtime catalog resolution (agy families: pick the newest catalog entry
//      for the family, honouring the family's default reasoning effort)
//   3. stable provider alias when the FAMILY semantics require one
//      (`claude:opus` -> `opus`, which tracks the provider's current Opus)
//   4. provider default — resolvedModel stays null and the transport omits the
//      `--model` flag entirely so the CLI/provider picks its own current
//      default. The concrete model is then recovered from the provider's own
//      reply envelope and persisted by the telemetry layer.
//
// This module NEVER makes a model call. The agy catalog probe (`agy models`)
// is a metadata listing, is fully injectable, is only run lazily at real
// route time in production wiring, and on any failure degrades to the
// provider-default path — it never throws.

export const MODEL_FAMILY_REGISTRY = Object.freeze({
  // Gemini is split into two ROLE-SPECIFIC stable family identities, each with a
  // FIXED reasoning effort. They deliberately do NOT share one family: the
  // concrete model is resolved and bound at provider-pool construction from the
  // family's own `defaultEffort`, so a single `agy:gemini` family could only
  // ever carry one effort. Both resolve from the same `gemini-` catalog prefix
  // and share the one `agy-gemini` quota pool (see roleRouting.js
  // DEFAULT_QUOTA_TOPOLOGY) — the split is purely effort + role intent.
  //
  //   agy:gemini-reviewer   -> newest `gemini-*-low`     (Reviewer Gemini head)
  //   agy:gemini-supervisor -> newest `gemini-*-medium`  (Supervisor head)
  //
  // TELEMETRY stays honest: the concrete `-low` / `-medium` id is what the AGY
  // transport passes as `--model` and what the durable spend record persists —
  // a `-low` family can never silently dispatch a `-medium` model.
  'agy:gemini-reviewer': Object.freeze({
    family: 'agy:gemini-reviewer',
    provider: 'agy-gemini',
    cli: 'agy',
    catalogPrefix: 'gemini-',
    envKeys: Object.freeze(['REVIEWLOOP_GEMINI_REVIEWER_MODEL', 'AGY_GEMINI_REVIEWER_MODEL', 'AGY_MODEL']),
    // Fixed Reviewer effort. `low` is deliberate: catalog resolution
    // (pickCatalogModel) selects the newest `gemini-*-low` variant.
    defaultEffort: 'low',
    stableAlias: null,
  }),
  'agy:gemini-supervisor': Object.freeze({
    family: 'agy:gemini-supervisor',
    provider: 'agy-gemini',
    cli: 'agy',
    catalogPrefix: 'gemini-',
    envKeys: Object.freeze(['REVIEWLOOP_GEMINI_SUPERVISOR_MODEL', 'AGY_GEMINI_SUPERVISOR_MODEL', 'AGY_MODEL']),
    // Fixed Supervisor effort. `medium` is deliberate: catalog resolution
    // selects the newest `gemini-*-medium` variant.
    defaultEffort: 'medium',
    stableAlias: null,
  }),
  'agy:gpt-oss': Object.freeze({
    family: 'agy:gpt-oss',
    provider: 'agy-claude-gpt',
    cli: 'agy',
    catalogPrefix: 'gpt-oss-',
    envKeys: Object.freeze(['REVIEWLOOP_REVIEWER_MODEL', 'AGY_REVIEWER_MODEL', 'AGY_MODEL']),
    defaultEffort: 'medium',
    stableAlias: null,
  }),
  // AGY-hosted Claude Opus — Reviewer head only (see roleRouting.js
  // PRODUCTION_ROLE_CAPABILITIES). Shares the AGY "Claude & GPT" quota pool
  // (`agy-claude-gpt`) with agy:sonnet + agy:gpt-oss, so a quota cooldown on
  // that pool takes all three out of routing without a wasted probe.
  // `catalogPrefix: 'claude-opus-'` resolves the newest Opus in the live
  // `agy models` catalog at pool-construction time (e.g. `claude-opus-5-5-medium`)
  // — deliberately NOT a long-term concrete version pin, so ReviewLoop source
  // needs no edit when AGY advances its Opus release. Prefer `-medium` when
  // reasoning-effort suffix variants exist, matching the Reviewer policy.
  // Same isolated `reviewloop-minimal` AGY transport / token accounting /
  // ModelSpendAuthority / sentinel / bounded-failover path as the other AGY
  // families.
  'agy:opus': Object.freeze({
    family: 'agy:opus',
    provider: 'agy-claude-gpt',
    cli: 'agy',
    catalogPrefix: 'claude-opus-',
    envKeys: Object.freeze(['REVIEWLOOP_AGY_OPUS_MODEL', 'AGY_OPUS_MODEL', 'AGY_MODEL']),
    defaultEffort: 'medium',
    stableAlias: null,
  }),
  // AGY-hosted Claude Sonnet. Shares the AGY "Claude & GPT" quota pool with
  // agy:gpt-oss + agy:opus (provider === 'agy-claude-gpt'); agy:gemini is a
  // SEPARATE pool. `catalogPrefix: 'claude-sonnet-'` selects the newest Sonnet
  // in the live `agy models` catalog (currently `claude-sonnet-4-6`); no
  // reasoning-effort suffix variants exist for it, so `defaultEffort` is null.
  'agy:sonnet': Object.freeze({
    family: 'agy:sonnet',
    provider: 'agy-claude-gpt',
    cli: 'agy',
    catalogPrefix: 'claude-sonnet-',
    envKeys: Object.freeze(['REVIEWLOOP_SONNET_MODEL', 'AGY_SONNET_MODEL', 'AGY_MODEL']),
    defaultEffort: null,
    stableAlias: null,
  }),
  'codex:default': Object.freeze({
    family: 'codex:default',
    provider: 'codex',
    cli: 'codex',
    catalogPrefix: null,
    envKeys: Object.freeze(['REVIEWLOOP_CODEX_MODEL']),
    defaultEffort: null,
    stableAlias: null,
  }),
  'claude:opus': Object.freeze({
    family: 'claude:opus',
    provider: 'claude',
    cli: 'claude',
    catalogPrefix: null,
    envKeys: Object.freeze(['REVIEWLOOP_CLAUDE_MODEL']),
    defaultEffort: null,
    // Stable provider alias, not a concrete release pin. The Claude CLI keeps
    // `--model opus` pointed at the current Opus release, preserving the family
    // identity while still upgrading automatically.
    stableAlias: 'opus',
  }),
});

export const RESOLUTION_SOURCE = Object.freeze({
  ENV_OVERRIDE: 'env_override',
  RUNTIME_CATALOG: 'runtime_catalog',
  STABLE_PROVIDER_ALIAS: 'stable_provider_alias',
  PROVIDER_DEFAULT: 'provider_default',
  UNKNOWN_FAMILY: 'unknown_family',
});

const CONCRETE_VERSION_RE = /\d+\.\d+|\d{2,}b|-\d+-\d+/i;

export function looksLikeConcreteVersion(model) {
  return typeof model === 'string' && CONCRETE_VERSION_RE.test(model);
}

function envValue(env, key) {
  const v = env ? env[key] : undefined;
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

export function parseAgyModelCatalog(text) {
  return String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split(/\s+/)[0].trim())
    .filter((id) => /^[a-z][a-z0-9]*(-[a-z0-9.]+)+$/i.test(id));
}

function versionTuple(id) {
  return (String(id).match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
}
function cmpVersion(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

// Higher = preferred on a version tie when the exact defaultEffort variant is
// absent from the catalog. Keeps the fallback deterministic and sensible
// (never silently drops to `-low` just because it sorts first lexically).
const EFFORT_RANK = Object.freeze({ high: 3, medium: 2, low: 1 });
function effortRank(id) {
  const suffix = String(id).split('-').pop();
  return EFFORT_RANK[suffix] ?? 0;
}

export function pickCatalogModel(catalog, { catalogPrefix, defaultEffort } = {}) {
  const ids = (Array.isArray(catalog) ? catalog : parseAgyModelCatalog(catalog))
    .filter((id) => catalogPrefix && id.startsWith(catalogPrefix));
  if (ids.length === 0) return null;
  const preferred = defaultEffort ? ids.filter((id) => id.endsWith(`-${defaultEffort}`)) : [];
  const pool = preferred.length ? preferred : ids;
  return [...pool].sort((x, y) => (
    cmpVersion(versionTuple(y), versionTuple(x))
    || (effortRank(y) - effortRank(x))
    || (x < y ? 1 : -1)
  ))[0];
}

/**
 * Resolve a stable family identity to a concrete model / stable alias to call.
 */
export function resolveModelFamily(family, { env = process.env, agyCatalog = null } = {}) {
  const reg = MODEL_FAMILY_REGISTRY[family];
  if (!reg) {
    return {
      requestedFamily: family,
      provider: typeof family === 'string' && family.includes(':') ? family.split(':')[0] : String(family),
      cli: null,
      resolvedModel: null,
      resolvedFrom: RESOLUTION_SOURCE.UNKNOWN_FAMILY,
      pinnedByEnv: false,
      envKey: null,
      concreteVersionPinned: false,
      known: false,
    };
  }

  for (const key of reg.envKeys) {
    const val = envValue(env, key);
    if (val) {
      return {
        requestedFamily: family,
        provider: reg.provider,
        cli: reg.cli,
        resolvedModel: val,
        resolvedFrom: RESOLUTION_SOURCE.ENV_OVERRIDE,
        pinnedByEnv: true,
        envKey: key,
        concreteVersionPinned: true,
        known: true,
      };
    }
  }

  if (reg.catalogPrefix && agyCatalog != null) {
    const picked = pickCatalogModel(agyCatalog, reg);
    if (picked) {
      return {
        requestedFamily: family,
        provider: reg.provider,
        cli: reg.cli,
        resolvedModel: picked,
        resolvedFrom: RESOLUTION_SOURCE.RUNTIME_CATALOG,
        pinnedByEnv: false,
        envKey: null,
        concreteVersionPinned: false,
        known: true,
      };
    }
  }

  if (typeof reg.stableAlias === 'string' && reg.stableAlias.trim() !== '') {
    return {
      requestedFamily: family,
      provider: reg.provider,
      cli: reg.cli,
      resolvedModel: reg.stableAlias,
      resolvedFrom: RESOLUTION_SOURCE.STABLE_PROVIDER_ALIAS,
      pinnedByEnv: false,
      envKey: null,
      concreteVersionPinned: false,
      known: true,
    };
  }

  return {
    requestedFamily: family,
    provider: reg.provider,
    cli: reg.cli,
    resolvedModel: null,
    resolvedFrom: RESOLUTION_SOURCE.PROVIDER_DEFAULT,
    pinnedByEnv: false,
    envKey: null,
    concreteVersionPinned: false,
    known: true,
  };
}

export function defaultConfigHasConcreteVersionPin(env = {}) {
  for (const family of Object.keys(MODEL_FAMILY_REGISTRY)) {
    const r = resolveModelFamily(family, { env, agyCatalog: null });
    if (r.resolvedModel && looksLikeConcreteVersion(r.resolvedModel) && r.concreteVersionPinned) {
      return true;
    }
  }
  return false;
}
