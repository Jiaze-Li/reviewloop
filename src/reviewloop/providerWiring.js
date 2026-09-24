// Production wiring for the ReviewLoop controller.
//
// Builds the internal Reviewer / Supervisor pool (RoleRouter -> capability ->
// quota -> health -> selected family -> caller crosses ModelSpendAuthority ->
// selected transport) and the PR backend. Nothing here performs a model call
// or a GitHub trigger at construction time.
//
// Active roles are exactly reviewer + supervisor. No Planner, no Executor.
//
// Malformed / unparseable / schema-invalid provider output NEVER becomes an
// empty finding list — it is surfaced as { malformed: true, ... } so the
// normalizer fails it closed (FAILED -> HUMAN_REQUIRED).

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { callAgy as defaultCallAgy, AgyError } from '../agy/agyClient.js';
import {
  DEFAULT_ROLE_POLICY,
  PRODUCTION_ROLE_CAPABILITIES,
  RoleRouter,
  QuotaPoolRegistry,
  ProviderHealthRegistry,
  EffortPolicy,
  RouteAuditLog,
} from '../orchestrator/roleRouting.js';
import { resolveModelFamily, MODEL_FAMILY_REGISTRY } from '../orchestrator/modelFamilyResolver.js';
import { narrowReviewTransportCwd, narrowAgyGeminiDir } from './adapters/scratchCwd.js';
import { makeCodexReviewTransport, makeClaudeReviewTransport } from './adapters/cliReviewTransports.js';
import { provisionMinimalAgyAgent, MINIMAL_AGY_AGENT_NAME } from './adapters/minimalAgyAgent.js';
import {
  detectAgyCustomAgentSupport,
  verifyEffectiveAgyAgent,
} from './adapters/agyCustomAgentCapability.js';
import { createGithubReviewBackend } from './githubBackend.js';
import { evidencePromptLines, normalizeContractText } from './contractEvidence.js';

export const ACTIVE_ROLE_POOLS = Object.freeze(Object.keys(DEFAULT_ROLE_POLICY));

/**
 * ReviewLoop-specific wall-clock bound for AGY-backed Reviewer/Supervisor calls.
 *
 * The generic callAgy() client intentionally keeps its historical 120s default,
 * but ReviewLoop's primary Reviewer is agy:opus -> Claude Opus Thinking. Real
 * complex diff reviews can legitimately exceed 120s, so the controller needs a
 * wider bound without making provider calls unbounded.
 */
export const DEFAULT_AGY_REVIEW_TIMEOUT_MS = 240_000;
export const MAX_AGY_REVIEW_TIMEOUT_MS = 600_000;
export const AGY_REVIEW_TIMEOUT_ENV = 'REVIEWLOOP_AGY_TIMEOUT_MS';

export function resolveAgyReviewTimeoutMs(env = process.env) {
  const raw = env?.[AGY_REVIEW_TIMEOUT_ENV];
  const override = raw == null ? NaN : Number(raw);
  if (Number.isFinite(override) && override > 0) {
    return Math.min(override, MAX_AGY_REVIEW_TIMEOUT_MS);
  }
  return DEFAULT_AGY_REVIEW_TIMEOUT_MS;
}
export { narrowReviewTransportCwd, narrowAgyGeminiDir, detectAgyCustomAgentSupport };

// Each pool family is one of exactly two things (no "looks like fallback,
// always skipped" phantoms):
//   - a WIRED transport that can actually be selected and called, or
//   - explicitly UNAVAILABLE (adapter present but runtime unavailable, or no
//     adapter at all) — the RoleRouter skips it and the reason is recorded.
const CLI_TRANSPORT_FACTORY = Object.freeze({
  'codex:default': makeCodexReviewTransport,
  'claude:opus': makeClaudeReviewTransport,
});

// Every ReviewLoop-owned AGY family (agy:gemini-reviewer, agy:gemini-supervisor,
// agy:opus, agy:gpt-oss, agy:sonnet, ...):
// derived from the registry so a newly-registered agy:* family is wired through
// the same isolated `reviewloop-minimal` path automatically — never left as an
// unwired policy entry, and never silently falling back to AGY's ambient agent.
const REVIEWLOOP_AGY_FAMILIES = Object.freeze(
  Object.keys(MODEL_FAMILY_REGISTRY).filter((f) => f.startsWith('agy:')),
);

const SEVERITIES = new Set(['P1', 'P2', 'P3']);

// Strict shape validation of a parsed Reviewer payload. Returns the payload
// unchanged when it is a well-formed findings list, or a malformed marker.
export function validateReviewerPayload(parsed, { raw } = {}) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { malformed: true, reason: 'reviewer output is not a JSON object', raw };
  }
  if (!Array.isArray(parsed.findings)) {
    return { malformed: true, reason: 'reviewer output has no "findings" array', raw };
  }
  for (const f of parsed.findings) {
    if (!f || typeof f !== 'object') {
      return { malformed: true, reason: 'a finding is not an object', raw };
    }
    const sev = String(f.severity ?? '').trim().toUpperCase();
    if (!SEVERITIES.has(sev)) {
      return { malformed: true, reason: `a finding has an invalid severity: ${JSON.stringify(f.severity)}`, raw };
    }
    if (!String(f.title ?? f.message ?? '').trim()) {
      return { malformed: true, reason: 'a finding has no title/message', raw };
    }
  }
  return parsed;
}

export function validateSupervisorPayload(parsed, { raw } = {}) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { malformed: true, reason: 'supervisor output is not a JSON object', raw };
  }
  const rec = String(parsed.recommendation ?? '').trim().toUpperCase();
  if (rec !== 'REWORK' && rec !== 'HUMAN_REQUIRED') {
    return { malformed: true, reason: `supervisor recommendation must be REWORK|HUMAN_REQUIRED, got ${JSON.stringify(parsed.recommendation)}`, raw };
  }
  if (!String(parsed.guidance ?? '').trim()) {
    return { malformed: true, reason: 'supervisor guidance is empty', raw };
  }
  return { guidance: String(parsed.guidance).trim(), recommendation: rec };
}

// callAgy() resolves to the TRANSPORT envelope:
//   { model, exitCode, text, json, stdout, durationMs, conversationId, usage }
// where `json` is agy's own envelope ({ result, usage, conversation_id, ... })
// and `text` is the MODEL's reply — i.e. the actual
// `{"findings":[...]}` / `{"guidance":"...","recommendation":"..."}` payload,
// possibly fenced. The reviewer/supervisor payload therefore lives in `text`,
// NOT in `json`. Parsing `json` first (the old behaviour) fed the transport
// envelope to validateReviewerPayload, which has no `findings` array, so every
// real production Reviewer call failed closed.
function stripFence(text) {
  return String(text ?? '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}

function looksLikePayload(obj) {
  return obj && typeof obj === 'object' && !Array.isArray(obj)
    && (Array.isArray(obj.findings) || 'recommendation' in obj || 'guidance' in obj);
}

// A model reply is often prose wrapped around the JSON, e.g.
//   "I reviewed the diff. ```json\n{...}\n``` Let me know."
// Pull the JSON out of it: first a ```json fenced block, then the first
// balanced {...} substring that parses AND looks like a reviewer/supervisor
// payload. Deterministic; never executes anything.
function extractEmbeddedJson(text) {
  const s = String(text ?? '');
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      const p = JSON.parse(fenced[1].trim());
      if (p && typeof p === 'object') return p;
    } catch { /* keep looking */ }
  }
  for (let i = s.indexOf('{'); i !== -1; i = s.indexOf('{', i + 1)) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < s.length; j += 1) {
      const c = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            const p = JSON.parse(s.slice(i, j + 1));
            if (looksLikePayload(p)) return p;
          } catch { /* not this one */ }
          break;
        }
      }
    }
  }
  return null;
}

export function parseJsonish(res) {
  if (typeof res === 'string') {
    try { return { parsed: JSON.parse(stripFence(res)), raw: res }; } catch { /* embedded */ }
    const embedded = extractEmbeddedJson(res);
    return { parsed: embedded, raw: res };
  }
  // 1. The model's own reply text — the normal channel.
  const replyText = typeof res?.text === 'string' ? res.text : null;
  if (replyText && stripFence(replyText)) {
    try {
      return { parsed: JSON.parse(stripFence(replyText)), raw: replyText };
    } catch { /* fall through */ }
    const embedded = extractEmbeddedJson(replyText);
    if (embedded) return { parsed: embedded, raw: replyText };
  }
  // 2. `agy --json-schema` can make the ENVELOPE itself the schema'd object.
  //    Only accept res.json when it already looks like a reviewer/supervisor
  //    payload — never the bare transport envelope.
  if (looksLikePayload(res?.json)) {
    return { parsed: res.json, raw: res.json };
  }
  // 3. A nested envelope field sometimes carries the JSON as a string.
  for (const cand of [res?.json?.result, res?.json?.output, res?.json?.content]) {
    if (typeof cand === 'string' && stripFence(cand)) {
      try { return { parsed: JSON.parse(stripFence(cand)), raw: cand }; } catch { /* keep trying */ }
      const embedded = extractEmbeddedJson(cand);
      if (embedded) return { parsed: embedded, raw: cand };
    }
  }
  return { parsed: null, raw: replyText ?? (res?.json ? JSON.stringify(res.json) : '') };
}

// ---- Reviewer / Supervisor pool -----------------------------------------

export function createReviewLoopProviderPool({
  callAgy = defaultCallAgy,
  env = process.env,
  quotaRegistry = new QuotaPoolRegistry({ filePath: null }),
  providerHealth = new ProviderHealthRegistry(),
  // `agy models` catalog (ids array / raw stdout) for runtime model-family
  // resolution. null -> the provider-default path (transport omits --model).
  // Deterministic tests leave it null; production wiring probes it once.
  agyCatalog = null,
  // { 'codex:default': { available, reason, version? }, 'claude:opus': {...} }
  // Runtime availability of the CLI-backed transports. The MCP entrypoint
  // probes it once at startup; deterministic tests inject it. Absent -> the
  // CLI families are treated as "adapter present, runtime not probed" and
  // marked UNAVAILABLE (never silently skipped as a phantom fallback).
  transportRuntime = null,
  // Per-family transport override (deterministic tests inject a fake).
  transportOverrides = null,
  // Injected into the codex/claude CLI transports (deterministic tests).
  spawn = undefined,
  // Provisions the `reviewloop-minimal` AGY custom agent into the isolated
  // gemini dir. Deterministic tests inject a fake (or a thrower to exercise the
  // fail-closed path).
  provisionMinimalAgent = provisionMinimalAgyAgent,
  // Isolated gemini dir the AGY transport points agy at (via `--gemini_dir`).
  agyGeminiDir = narrowAgyGeminiDir(),
  // Precomputed startup verdict that agy actually LOADS the reviewloop-minimal
  // agent from `agyGeminiDir` (from detectAgyCustomAgentSupport). Shape:
  //   { supported: boolean, reason: string }
  // The real entrypoints (MCP server, live-cert) compute and pass it; when it
  // is provided, per-call effective-loading verification is also enforced.
  //   null  -> "not probed": AGY families wired on provisioning alone, per-call
  //            verification skipped (deterministic tests / `doctor` inspection).
  //   { supported: false } -> AGY families fail closed, never wired.
  customAgentSupport = null,
  // Durable routing-decision audit (see RouteAuditLog). In-memory-only by
  // default, matching quotaRegistry above — deterministic tests must never
  // touch disk just by calling pool.route(). The real MCP entrypoint injects
  // a disk-backed instance.
  routeAudit = new RouteAuditLog(),
  // Zero-token, synchronous stale-health re-probe forwarded to RoleRouter.
  // null (default) -> a stale provider_health skip is trusted as-is, the
  // pre-existing behaviour. The real MCP entrypoint injects a probe that
  // re-provisions the AGY isolated agent (still zero-token: local file I/O,
  // no CLI spawn, no model call) so a transient startup-time failure does not
  // permanently sideline agy:opus / agy:gemini-reviewer for the process's
  // whole lifetime.
  healthRevalidator = null,
  staleHealthTtlMs = 10 * 60 * 1000,
} = {}) {
  const agyReviewTimeoutMs = resolveAgyReviewTimeoutMs(env);

  // Resolve every registered family to a concrete model (or null = provider
  // default) at construction. Stable family identity in, concrete version out —
  // a catalog bump changes `resolvedModel` here without any policy edit.
  const resolution = {};
  for (const family of Object.keys(MODEL_FAMILY_REGISTRY)) {
    resolution[family] = resolveModelFamily(family, { env, agyCatalog });
  }
  const modelForFamily = Object.fromEntries(
    Object.entries(resolution).map(([f, r]) => [f, r.resolvedModel]),
  );

  // Both AGY families run through a dedicated minimal agent (`--agent
  // reviewloop-minimal`, inheritCustomizations:false) provisioned into the
  // isolated gemini dir and reached with `--gemini_dir`. We FAIL CLOSED unless
  // BOTH hold:
  //   1. provisioning the agent file succeeded, and
  //   2. (when probed) agy actually LOADS that agent — agy silently falls back
  //      to its ambient default agent for an unresolvable `--agent`, which would
  //      reintroduce the inherited MCP / skills / rules / plugins / subagents
  //      context this removes.
  let minimalAgent = null;
  let minimalAgentError = null;
  try {
    minimalAgent = provisionMinimalAgent({ geminiDir: agyGeminiDir });
  } catch (err) {
    minimalAgentError = err;
  }

  // `null` customAgentSupport == "not probed" -> trust provisioning alone and
  // skip per-call verification (deterministic tests / doctor). A concrete
  // verdict turns on enforcement.
  const capabilityProbed = customAgentSupport != null;
  const capabilitySupported = !capabilityProbed || customAgentSupport.supported === true;
  const capabilityReason = capabilityProbed
    ? String(customAgentSupport.reason ?? (capabilitySupported ? 'ok' : 'agy does not load the isolated agent'))
    : null;

  const agyIsolationAvailable = Boolean(minimalAgent) && capabilitySupported;

  // Per-call effective-loading verification. Enforced only once the startup
  // capability probe has run. Any failure (agy fell back, or the log could not
  // confirm activation) raises AND marks every AGY family UNAVAILABLE so bounded
  // failover routes AWAY from AGY rather than repeating a default-agent call on
  // the next AGY family.
  const enforcePerCall = capabilityProbed && capabilitySupported;
  const markAllAgyUnavailable = (reason) => {
    for (const family of REVIEWLOOP_AGY_FAMILIES) {
      // Per-call effective-loading failure — needs a live CLI probe to
      // re-verify, NOT re-checkable by the zero-token provisioning-only
      // revalidator (see createAgyZeroTokenHealthRevalidator).
      providerHealth.record(family, 'UNAVAILABLE', reason, { reasonCode: 'AGY_EFFECTIVE_LOADING_FAILED' });
    }
  };
  const narrow = (family) => async (prompt, { signal } = {}) => {
    if (signal?.aborted) {
      throw Object.assign(new Error('review cancelled before AGY dispatch'), { code: 'REVIEW_CANCELLED' });
    }
    let logDir = null;
    let logFile = null;
    if (enforcePerCall) {
      logDir = mkdtempSync(path.join(os.tmpdir(), 'reviewloop-agy-verify-'));
      logFile = path.join(logDir, 'agy.log');
    }
    try {
      const res = await callAgy({
        prompt,
        model: modelForFamily[family] ?? null,
        cwd: narrowReviewTransportCwd(),
        geminiDir: agyGeminiDir,
        logFile: logFile ?? undefined,
        disableSlashCommands: true,
        agent: MINIMAL_AGY_AGENT_NAME,
        timeoutMs: agyReviewTimeoutMs,
        signal,
      });
      if (enforcePerCall) {
        let logText = '';
        try { logText = readFileSync(logFile, 'utf8'); } catch { logText = ''; }
        const verdict = verifyEffectiveAgyAgent({ logText, agentName: MINIMAL_AGY_AGENT_NAME });
        if (!verdict.verified) {
          const reason = `AGY isolation unverified for ${family}: ${verdict.reason}`;
          markAllAgyUnavailable(reason);
          throw new AgyError(reason, { code: 'AGY_ISOLATION_UNVERIFIED', exitCode: 65 });
        }
      }
      return { ...res, meta: { promptChars: String(prompt ?? '').length } };
    } finally {
      if (logDir) { try { rmSync(logDir, { recursive: true, force: true }); } catch { /* best effort */ } }
    }
  };
  const transports = {};
  if (agyIsolationAvailable) {
    for (const family of REVIEWLOOP_AGY_FAMILIES) transports[family] = narrow(family);
  }

  // adapterImplemented / runtimeAvailable / defaultModelResolution per family —
  // consumed by doctor and the pool-composition tests.
  const runtimeStatus = {};
  for (const family of REVIEWLOOP_AGY_FAMILIES) {
    const available = agyIsolationAvailable;
    let reason;
    if (available) {
      reason = capabilityProbed
        ? 'wired (agy CLI + reviewloop-minimal agent; effective loading probed + verified per call; ENOENT -> failover at call time)'
        : 'wired (agy CLI + reviewloop-minimal agent; effective loading NOT probed — inspection/test mode; ENOENT -> failover at call time)';
    } else if (!minimalAgent) {
      reason = `fail-closed: reviewloop-minimal agent provisioning failed: ${minimalAgentError?.message ?? 'unknown error'}`;
    } else {
      reason = `fail-closed: agy does not load the isolated reviewloop-minimal agent: ${capabilityReason ?? 'unknown'}`;
    }
    runtimeStatus[family] = {
      adapterImplemented: true,
      runtimeAvailable: available,
      reason,
      minimalAgent: minimalAgent ? { name: minimalAgent.name, path: minimalAgent.path } : null,
      effectiveLoadingVerified: available && capabilityProbed,
      defaultModelResolution: resolution[family].resolvedFrom,
      concreteVersionPinnedByDefault: resolution[family].concreteVersionPinned,
    };
    if (!available) {
      // These two sub-cases are exactly the two runtimeStatus[family].reason
      // branches above: `!minimalAgent` means provisioning itself threw (the
      // zero-token revalidator CAN legitimately re-check this); the other
      // branch means agy was provisioned but the startup probe found it does
      // not load the isolated agent (needs a live CLI probe to clear — the
      // provisioning-only revalidator must not touch it).
      providerHealth.record(family, 'UNAVAILABLE', runtimeStatus[family].reason, {
        reasonCode: !minimalAgent ? 'AGY_PROVISIONING_FAILED' : 'AGY_CAPABILITY_UNVERIFIED',
      });
    }
  }

  // CLI families: the adapter always exists. Wire the transport only when the
  // runtime is actually available; otherwise record it UNAVAILABLE with a
  // reason that distinguishes "adapter present, CLI missing" from "no adapter".
  for (const family of Object.keys(CLI_TRANSPORT_FACTORY)) {
    const rt = transportRuntime?.[family];
    const available = rt?.available === true;
    runtimeStatus[family] = {
      adapterImplemented: true,
      runtimeAvailable: available,
      reason: available ? (rt.reason ?? 'ok') : `adapter present; runtime unavailable: ${rt?.reason ?? 'not probed'}`,
      defaultModelResolution: resolution[family].resolvedFrom,
      concreteVersionPinnedByDefault: resolution[family].concreteVersionPinned,
    };
    if (available) {
      transports[family] = CLI_TRANSPORT_FACTORY[family]({ model: modelForFamily[family] ?? null, env, spawn });
    } else {
      providerHealth.record(family, 'UNAVAILABLE', runtimeStatus[family].reason, { reasonCode: 'CLI_RUNTIME_UNAVAILABLE' });
    }
  }

  if (transportOverrides) {
    for (const [family, fn] of Object.entries(transportOverrides)) {
      if (typeof fn === 'function') {
        transports[family] = fn;
        if (runtimeStatus[family]) { runtimeStatus[family].runtimeAvailable = true; runtimeStatus[family].reason = 'test override'; }
      }
    }
  }

  for (const family of Object.keys(PRODUCTION_ROLE_CAPABILITIES)) {
    if (!transports[family] && !runtimeStatus[family]) {
      runtimeStatus[family] = { adapterImplemented: false, runtimeAvailable: false, reason: 'no adapter' };
      providerHealth.record(family, 'UNAVAILABLE', 'no adapter for this family', { reasonCode: 'NO_ADAPTER' });
    }
  }

  const router = new RoleRouter({
    rolePolicy: DEFAULT_ROLE_POLICY,
    quotaRegistry,
    providerHealth,
    effortPolicy: new EffortPolicy(),
    routeAudit,
    healthRevalidator,
    staleHealthTtlMs,
    resolveFamily: (family) => {
      const r = resolution[family] ?? resolveModelFamily(family, { env, agyCatalog });
      return {
        requestedFamily: family,
        resolvedModel: r.resolvedModel,
        resolvedFrom: r.resolvedFrom,
        provider: r.provider ?? (family.startsWith('agy:') ? family.replace(':', '-') : family.split(':')[0]),
        // Read from `transports` at ROUTE time (not captured earlier) so it
        // reflects the final wired state after transportOverrides — the
        // router must never select a family this process has no dispatch
        // function for, no matter what health/quota say about it.
        transportAvailable: Boolean(transports[family]),
        capabilities: {
          roles: PRODUCTION_ROLE_CAPABILITIES[family] ?? [],
          // Effort is NOT selected at route time for these families — each AGY
          // family's concrete model (and thus its effort) is bound once at pool
          // construction from the family's own `defaultEffort`. Report that
          // fixed effort so telemetry/inspection never implies a mutable knob.
          supportsReasoningEffort: false,
          supportedEfforts: [MODEL_FAMILY_REGISTRY[family]?.defaultEffort ?? 'medium'],
        },
      };
    },
  });

  // `requestContext` is per-call audit attribution (loopId/round/operationId/
  // attempt/chunkIndex/chunkTotal) — passed straight through to the router,
  // never captured on `router` itself (see roleRouting.js route()).
  function route(role, signals = {}, requestContext = {}) {
    const sel = router.route(role, signals, requestContext);
    if (!sel) return null;
    return {
      role,
      family: sel.requestedFamily,
      provider: sel.provider,
      model: sel.resolvedModel,
      resolvedFrom: resolution[sel.requestedFamily]?.resolvedFrom ?? null,
      transport: transports[sel.requestedFamily] ?? null,
      // Which quota pool(s) this family draws from — carried through so the
      // durable PR audit can answer "which physical model, on which quota
      // pool, reviewed this SHA" (see controller.js appendAuditRecord).
      quotaPools: sel.quotaPools ?? null,
    };
  }

  function recordFailure(selection, failure) {
    router.recordFailure({ role: selection.role, requestedFamily: selection.family, provider: selection.provider }, failure);
  }

  return { router, route, recordFailure, transports, resolution, runtimeStatus };
}

// ---- convenience Reviewer / Supervisor callables ------------------------
// Used when the controller does not itself drive routing (kept simple for the
// default path and for wiring inspection). The controller's production path
// prefers routeReviewerFn/routeSupervisorFn so it can bind the real selected
// family into the CallIntent and drive bounded failover.

function reviewScopePromptLines(reviewScope) {
  if (!reviewScope || reviewScope.type === 'task') return [];
  if (reviewScope.type === 'phase') {
    const lines = [
      `CURRENT REVIEW SCOPE: PHASE ${reviewScope.id}${reviewScope.title ? ` — ${reviewScope.title}` : ''}`,
      `PHASE OBJECTIVE: ${reviewScope.objective}`,
      'PHASE EXIT CRITERIA:',
      ...(reviewScope.exitCriteria ?? []).map((v) => `- ${v}`),
    ];
    if ((reviewScope.verificationEvidence ?? []).length) {
      lines.push('PHASE VERIFICATION EVIDENCE EXPECTED:');
      lines.push(...reviewScope.verificationEvidence.map((v) => `- ${v}`));
    }
    if ((reviewScope.preserveInvariants ?? []).length) {
      lines.push('INVARIANTS FROM COMPLETED PHASES THAT MUST REMAIN TRUE:');
      lines.push(...reviewScope.preserveInvariants.map((v) => `- ${v}`));
    }
    if ((reviewScope.carryForwardInvariants ?? []).length) {
      lines.push('INVARIANTS THIS PHASE MUST ESTABLISH FOR LATER PHASES:');
      lines.push(...reviewScope.carryForwardInvariants.map((v) => `- ${v}`));
    }
    lines.push(
      'Judge this phase only. Do NOT block it merely because work explicitly assigned to a later phase is not implemented yet.',
      'Global task constraints still apply, and already-passed phase invariants must not regress.',
    );
    return lines;
  }
  if (reviewScope.type === 'final') {
    const lines = [
      'CURRENT REVIEW SCOPE: FINAL WHOLE-TASK GATE',
      'All implementation phases have individually passed. Now judge the cumulative diff against the complete original task.',
    ];
    if ((reviewScope.completedPhaseSummaries ?? []).length) {
      lines.push('PHASE CONTRACTS THAT MUST ALL STILL HOLD:');
      for (const p of reviewScope.completedPhaseSummaries) {
        lines.push(`- ${p.id}${p.title ? ` (${p.title})` : ''}: ${p.objective}`);
        lines.push(...(p.exitCriteria ?? []).map((v) => `  - ${v}`));
        lines.push(...(p.carryForwardInvariants ?? []).map((v) => `  - invariant: ${v}`));
      }
    }
    return lines;
  }
  return [];
}

export function buildReviewerInvoke() {
  return async ({
    objective, diff, changedFiles, gate, reviewScope = null, evidence = null, transport, model, signal,
  }) => {
    const prompt = [
      'You are an INDEPENDENT code reviewer.',
      `ORIGINAL TASK GOAL (always binding): ${objective.goal}`,
      objective.contractText
        ? `FROZEN TASK CONTRACT (also binding; self-contained; must not weaken the goal):\n${normalizeContractText(objective.contractText)}`
        : '',
      objective.constraints?.length ? `GLOBAL CONSTRAINTS:\n- ${objective.constraints.join('\n- ')}` : '',
      ...reviewScopePromptLines(reviewScope),
      `CHANGED FILES: ${(changedFiles ?? []).join(', ') || '(none)'}`,
      `DETERMINISTIC GATE: ${gate?.verdict ?? 'n/a'}`,
      ...evidencePromptLines(evidence),
      'GIT DIFF (primary evidence):',
      String(diff ?? ''),
      '',
      'Return JSON: {"findings":[{"severity":"P1|P2|P3","file":"","line":0,"title":""}]}.',
      'P1/P2 block the CURRENT review scope. P3 does not.',
    ].filter(Boolean).join('\n');
    const res = await transport(prompt, { signal });
    const { parsed, raw } = parseJsonish(res);
    const value = validateReviewerPayload(parsed, { raw });
    return {
      value,
      usage: res?.usage ?? null,
      model: res?.model ?? model,
      meta: {
        promptChars: prompt.length,
        diffChars: String(diff ?? '').length,
        reviewPayloadChars: prompt.length,
        ...(res?.meta ?? {}),
      },
    };
  };
}

export function buildSupervisorInvoke() {
  return async ({
    objective, blockingFindings, reviewScope = null, evidence = null, transport, model, signal,
  }) => {
    const prompt = [
      'You are a repair STRATEGIST, not an implementer. You cannot edit code or declare PASS.',
      `ORIGINAL TASK GOAL (always binding): ${objective.goal}`,
      objective.contractText
        ? `FROZEN TASK CONTRACT (also binding; self-contained; must not weaken the goal):\n${normalizeContractText(objective.contractText)}`
        : '',
      ...reviewScopePromptLines(reviewScope),
      ...evidencePromptLines(evidence),
      `PERSISTENT BLOCKING FINDINGS:\n${JSON.stringify(blockingFindings, null, 2)}`,
      'Give concise repair guidance for the Worker within the CURRENT review scope, or recommend HUMAN_REQUIRED.',
      'Do not broaden the task or redesign later phases unless a current blocking finding requires it.',
      'Return JSON: {"guidance":"","recommendation":"REWORK|HUMAN_REQUIRED"}.',
    ].filter(Boolean).join('\n');
    const res = await transport(prompt, { signal });
    const { parsed, raw } = parseJsonish(res);
    const value = validateSupervisorPayload(parsed, { raw });
    return {
      value,
      usage: res?.usage ?? null,
      model: res?.model ?? model,
      meta: {
        promptChars: prompt.length,
        diffChars: 0,
        reviewPayloadChars: prompt.length,
        ...(res?.meta ?? {}),
      },
    };
  };
}

// Zero-token stale-health revalidator for the AGY families: re-runs the
// local, synchronous, no-CLI-spawn provisioning check that startup wiring
// already performs once (see agyIsolationAvailable above). It re-verifies
// ONLY that one specific failure class — reasonCode AGY_PROVISIONING_FAILED,
// meaning provisionMinimalAgent() itself threw at startup. Every other
// reasonCode is refused, even for an AGY family:
//   - AGY_CAPABILITY_UNVERIFIED / AGY_EFFECTIVE_LOADING_FAILED — "agy
//     actually LOADS the isolated agent" needs a real CLI probe, which is
//     async and NOT zero-token; a provisioning-only re-check proves nothing
//     about it. Worse: when the startup gate failed for either of these
//     reasons, `transports[family]` was never wired at all in this process —
//     no amount of health revalidation changes that (the router's separate
//     NO_TRANSPORT check is what actually blocks selection in that case;
//     this refusal is about never claiming a false "recovered" verdict in
//     the durable audit). Recovery requires an MCP server restart.
//   - a post-dispatch PROVIDER_* reasonCode (see RoleRouter#recordFailure) —
//     unrelated to local provisioning; this revalidator has no zero-token
//     way to re-check a live provider condition.
//   - no reasonCode at all (legacy/unclassified record) — conservatively
//     refused rather than guessed at.
// Non-AGY families get no opinion (null) unconditionally.
export function createAgyZeroTokenHealthRevalidator({
  agyGeminiDir = narrowAgyGeminiDir(),
  provisionMinimalAgent = provisionMinimalAgyAgent,
} = {}) {
  return (family, _provider, entry) => {
    if (!family.startsWith('agy:')) return null;
    if (entry?.reasonCode !== 'AGY_PROVISIONING_FAILED') {
      return {
        available: false,
        reason: `zero-token revalidation declined: reasonCode "${entry?.reasonCode ?? 'unknown'}" is not a provisioning failure — this needs an MCP server restart to clear, not a re-probe`,
      };
    }
    try {
      provisionMinimalAgent({ geminiDir: agyGeminiDir });
      return { available: true, reason: 'zero-token re-provisioning of the reviewloop-minimal agent succeeded' };
    } catch (err) {
      return { available: false, reason: `zero-token re-provisioning failed: ${err?.message ?? String(err)}` };
    }
  };
}

export function createProductionReviewLoopProviders({
  env = process.env, callAgy, github, agyCatalog = null, transportRuntime = null,
  customAgentSupport = null, agyGeminiDir = undefined,
  // Left undefined by default so createReviewLoopProviderPool's own inert,
  // in-memory-only defaults apply — this factory is exercised directly by
  // several deterministic tests and must not touch disk on its own. The real
  // MCP entrypoint (reviewloopMcpServer.js) is the one place that passes a
  // disk-backed routeAudit and the AGY zero-token revalidator explicitly.
  routeAudit = undefined,
  healthRevalidator = undefined,
  staleHealthTtlMs = undefined,
} = {}) {
  // `agyCatalog` + `transportRuntime` + `customAgentSupport` are supplied by the
  // MCP entrypoint, which probes them once at startup; left null here so nothing
  // is spawned in tests (resolution falls back to the provider-default path, the
  // CLI families report "adapter present, runtime not probed", and AGY per-call
  // effective-loading verification is skipped).
  const pool = createReviewLoopProviderPool({
    callAgy, env, agyCatalog, transportRuntime, customAgentSupport,
    ...(agyGeminiDir ? { agyGeminiDir } : {}),
    ...(routeAudit !== undefined ? { routeAudit } : {}),
    ...(healthRevalidator !== undefined ? { healthRevalidator } : {}),
    ...(staleHealthTtlMs !== undefined ? { staleHealthTtlMs } : {}),
  });
  const reviewerInvoke = buildReviewerInvoke();
  const supervisorInvoke = buildSupervisorInvoke();

  return {
    env,
    pool,
    runtimeStatus: pool.runtimeStatus,
    routeReviewerFn: (signals, requestContext) => pool.route('reviewer', signals, requestContext),
    routeSupervisorFn: (signals, requestContext) => pool.route('supervisor', signals, requestContext),
    recordProviderFailure: pool.recordFailure,
    reviewerFn: async (args) => {
      const sel = args.selection ?? pool.route('reviewer');
      if (!sel?.transport) throw Object.assign(new Error('no eligible Reviewer provider'), { code: 'PROVIDER_UNAVAILABLE' });
      return reviewerInvoke({ ...args, transport: sel.transport, model: sel.model });
    },
    supervisorFn: async (args) => {
      const sel = args.selection ?? pool.route('supervisor');
      if (!sel?.transport) throw Object.assign(new Error('no eligible Supervisor provider'), { code: 'PROVIDER_UNAVAILABLE' });
      return supervisorInvoke({ ...args, transport: sel.transport, model: sel.model });
    },
    reviewerInvoke,
    supervisorInvoke,
    prBackend: createGithubReviewBackend({ github, env }),
  };
}
