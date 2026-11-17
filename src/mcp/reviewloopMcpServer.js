// ReviewLoop LOCAL MCP server. Exactly two Worker-facing tools:
// reviewloop_begin freezes the pre-edit local task / Git baseline;
// reviewloop_review runs Gate / independent Reviewer / Supervisor.
// GitHub PR review belongs to claude-review-bot.

import path from 'node:path';
import os from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { createReviewLoopController } from '../reviewloop/controller.js';
import {
  createProductionReviewLoopProviders,
  createAgyZeroTokenHealthRevalidator,
  detectAgyCustomAgentSupport,
  narrowAgyGeminiDir,
} from '../reviewloop/providerWiring.js';
import { RouteAuditLog, QuotaPoolRegistry } from '../orchestrator/roleRouting.js';
import { probeAgyModelCatalog } from '../agy/agyModelCatalog.js';
import { createAgyQuotaPreflight } from '../agy/agyQuotaProbe.js';
import { probeReviewTransportRuntime } from '../reviewloop/adapters/cliReviewTransports.js';
import { beginStatusLine } from '../reviewloop/statusLine.js';
import { applySettingsFile } from '../reviewloop/settingsFile.js';

// The statusLine is its own first text block, so the person sees it in the
// tool-call preview even when the Worker does not repeat it. The JSON block
// after it is unchanged for clients that read `content` instead of
// `structuredContent`.
export function toolResultContent(result) {
  const json = { type: 'text', text: JSON.stringify(result, null, 2) };
  if (!(typeof result?.statusLine === 'string' && result.statusLine)) return [json];
  const blocks = [{ type: 'text', text: result.statusLine }, json];
  // Appended AFTER the JSON block so index 0 (statusLine) and index 1 (JSON)
  // stay exactly as older clients/tests expect.
  if (typeof result.reviewRecord === 'string' && result.reviewRecord) {
    blocks.push({ type: 'text', text: result.reviewRecord });
  }
  return blocks;
}

// MCP progress may only use the token the client sent with this request
// (a made-up token is dropped by the client) and must increase every time.
// Without a token the client did not ask for progress, so nothing is sent.
export function progressNotifier(extra, loopId) {
  const progressToken = extra?._meta?.progressToken;
  if (progressToken === undefined || typeof extra?.sendNotification !== 'function') return undefined;
  let progress = 0;
  return async (msg) => {
    progress += 1;
    try {
      await extra.sendNotification({
        method: 'notifications/progress',
        params: { progressToken, progress, message: msg ?? `ReviewLoop ${loopId}: waiting (0 model tokens)` },
      });
    } catch { /* best effort */ }
  };
}

export function createReviewLoopMcpServer({
  controller = null,
  cwd = process.cwd(),
  // Runtime resolution inputs, probed once by startReviewLoopMcpServer (async).
  // Left null here so a bare createReviewLoopMcpServer() spawns nothing.
  agyCatalog = null,
  transportRuntime = null,
  // { supported, reason } verdict that agy actually loads the isolated
  // reviewloop-minimal agent. null -> AGY per-call verification stays off.
  customAgentSupport = null,
} = {}) {
  const server = new McpServer({ name: 'reviewloop', version: '1.0.0' });

  // This IS the one real entrypoint: the only place that opts into a
  // disk-backed routing-decision audit (survives this process restarting)
  // and a zero-token stale-health revalidator for the AGY families. Every
  // deterministic test builds its own providers/pool directly and never
  // reaches this default.
  const quotaRegistry = controller ? null : new QuotaPoolRegistry({
    filePath: path.join(os.homedir(), '.reviewloop', 'quota-pools.json'),
  });
  const ctl = controller ?? createReviewLoopController(
    createProductionReviewLoopProviders({
      agyCatalog,
      transportRuntime,
      customAgentSupport,
      routeAudit: new RouteAuditLog({ filePath: path.join(os.homedir(), '.reviewloop', 'route-audit.log') }),
      // Disk-backed pool state is shared by preflight and the Reviewer router.
      quotaRegistry,
      preflightQuotaFn: createAgyQuotaPreflight({ quotaRegistry }),
      healthRevalidator: createAgyZeroTokenHealthRevalidator(),
    }),
  );

  server.registerTool(
    'reviewloop_begin',
    {
      description:
        'Register one ReviewLoop session for a non-trivial coding task BEFORE your first edit so the baseline is captured. If the task contract has explicit execution phases, pass the frozen phase plan here; do not open a new loop between phases. ReviewLoop does not implement the task — you do, in this session. Returns a loopId. Zero model calls.',
      inputSchema: {
        goal: z.string().min(1).describe('the original user coding goal (immutable success definition)'),
        cwd: z.string().optional().describe('workspace directory (default: server cwd)'),
        taskType: z.enum(['code', 'design']).optional().describe('review mode: "code" (default) or "design". A Design loop that passes reviewTarget runs two-stage review each round: the Reviewer independently proposes approaches WITHOUT seeing your design file, then the Supervisor compares them with the complete current design file and checks the design blockers (same Gate and budgets as Code). A design contract must carry an "Options" section (alternatives considered + why rejected) and an "Assumptions" section (plain-language premises the brief never stated, or "None"). Design PASS returns a Supervisor-written designPassComment: post it to the PR verbatim and relay it to the user; never rewrite it or replace it with a pointer to a document'),
        // Explicit compatibility tripwire. Without it Zod could silently drop
        // unknown prNumber and accidentally start a LOCAL review.
        prNumber: z.number().int().optional().describe('RETIRED: PR review is handled by claude-review-bot; supplying this errors'),
        constraints: z.array(z.string().min(1)).optional().describe('global task constraints that remain binding across every phase and the final gate'),
        contractText: z.string().min(1).optional().describe('complete self-contained frozen task contract, at most 65536 UTF-8 bytes; never truncate acceptance criteria or replace them with a reference to earlier conversation'),
        evidenceRequirements: z.array(z.object({
          id: z.string().min(1),
          type: z.enum(['runtime', 'artifact', 'manual', 'other']).optional(),
          description: z.string().min(1),
          gate: z.string().min(1).optional().describe('one phase id or final; defaults to final. final is the task-completion gate for phased and unphased tasks'),
          required: z.boolean().optional(),
          covers: z.array(z.string().min(1)).optional(),
        })).optional().describe('frozen non-command evidence obligations; required items mechanically block PASS until evidence is submitted'),
        reviewTarget: z.string().min(1).optional().describe('design only: ONE repository-relative path (forward slashes, no "..") of the complete design file, at most 65536 UTF-8 bytes. It must NOT exist yet: call reviewloop_begin first, THEN create the file. Requires contractText (the complete Plan) and phases=[]. Every reviewloop_review round gives the Reviewer the whole current file; PASS returns designSha256'),
        designSha256: z.string().regex(/^[0-9a-fA-F]{64}$/).optional().describe('code only, optional: the designSha256 returned by the Design PASS. reviewloop_begin refuses a contractText whose whitespace-trimmed UTF-8 content hashes differently. A content-consistency check, not proof of Design PASS or of user authorization'),
        verificationCommands: z.array(z.string().min(1)).optional().describe('global whole-task deterministic Gate commands, frozen at begin and run at every phase gate plus the final gate; phase-local commands belong in phases[].verificationCommands'),
        blockingSeverities: z.array(z.string().min(1)).min(1).optional().describe('finding severities that block this task; defaults to P1, P2 and P3 for code, P1 and P2 for design'),
        maxReviewRounds: z.number().int().positive().optional().describe('maximum fresh Reviewer rounds PER gate (each phase gate and the final gate); defaults to 3'),
        phases: z.array(z.object({
          id: z.string().min(1),
          title: z.string().min(1).optional(),
          objective: z.string().min(1),
          exitCriteria: z.array(z.string().min(1)).min(1),
          carryForwardInvariants: z.array(z.string().min(1)).optional(),
          verificationCommands: z.array(z.string().min(1)).optional(),
          verificationEvidence: z.array(z.string().min(1)).optional().describe('descriptive runtime/artifact/manual evidence expected for this phase'),
        })).optional().describe('ordered frozen phase plan from the task contract; omit for ordinary single-gate tasks'),
      },
      outputSchema: {
        loopId: z.string(),
        mode: z.literal('LOCAL'),
        taskType: z.enum(['code', 'design']).optional(),
        status: z.literal('READY'),
        statusLine: z.string().optional().describe('fixed one-line status; show it to the user verbatim'),
        baseline: z.record(z.string(), z.any()).nullable(),
        reviewer: z.string(),
        phaseCount: z.number().int().optional(),
        currentPhase: z.string().optional(),
        planWarnings: z.array(z.string()).optional(),
        reviewTarget: z.string().optional(),
        repositoryRoot: z.string().optional().describe('the repository directory this loop is bound to; edit only here'),
        branch: z.string().nullable().optional(),
      },
    },
    async ({
      goal,
      cwd: reqCwd,
      taskType,
      prNumber,
      constraints,
      contractText,
      evidenceRequirements,
      verificationCommands,
      blockingSeverities,
      maxReviewRounds,
      phases,
      reviewTarget,
      designSha256,
    }, extra) => {
      const res = await ctl.begin({
        goal,
        cwd: reqCwd ? path.resolve(reqCwd) : cwd,
        taskType,
        prNumber: prNumber ?? null,
        constraints: constraints ?? [],
        contractText: contractText ?? '',
        evidenceRequirements: evidenceRequirements ?? [],
        verificationCommands: verificationCommands ?? null,
        blockingSeverities,
        maxReviewRounds,
        phases: phases ?? [],
        reviewTarget: reviewTarget ?? null,
        designSha256: designSha256 ?? null,
        signal: extra?.signal,
      });
      const structured = {
        loopId: res.loopId,
        mode: res.mode,
        taskType: res.taskType ?? 'code',
        status: 'READY',
        statusLine: beginStatusLine({ taskType: res.taskType ?? 'code', loopId: res.loopId }),
        baseline: res.baseline ?? null,
        reviewer: res.reviewer,
        phaseCount: res.phaseCount ?? 0,
        currentPhase: res.currentPhase ?? 'task',
        ...(res.repositoryRoot ? { repositoryRoot: res.repositoryRoot, branch: res.branch ?? null } : {}),
        ...(res.reviewTarget ? { reviewTarget: res.reviewTarget } : {}),
        ...(res.planWarnings?.length ? { planWarnings: res.planWarnings } : {}),
      };
      return { content: toolResultContent(structured), structuredContent: structured };
    },
  );

  server.registerTool(
    'reviewloop_review',
    {
      description:
        'Run one ReviewLoop round for the current gate: deterministic Gate, then independent Reviewer if justified, then convergence policy. PHASE_PASS -> current phase passed; continue the next phase in THIS SAME loop and call again when ready. PASS -> the entire task passed the final gate and is done. REWORK -> fix the returned findings yourself in THIS session and call again. HUMAN_REQUIRED -> stop and surface the blocker. WAITING_FOR_REVIEW -> transient; call again once state settles. The deterministic Gate itself uses zero model tokens.',
      inputSchema: {
        loopId: z.string().min(1).describe('the loopId from reviewloop_begin'),
        evidence: z.array(z.object({
          requirementId: z.string().min(1),
          summary: z.string().min(1).describe('self-contained inline factual verification proof (e.g. metrics, command outputs, PID, test results). Reviewer has no file tools and cannot read local files or external documents; never submit a bare file pointer or "See file.md"'),
          artifactRef: z.string().min(1).optional().describe('optional file path or identifier for human disk archival only; not read by Reviewer'),
        })).optional().describe('non-command evidence produced for the current gate; ReviewLoop binds it to the exact current code/review scope'),
      },
      outputSchema: {
        status: z.string(),
        loopId: z.string(),
        statusLine: z.string().optional().describe('fixed one-line status; show it to the user verbatim'),
        reviewRecord: z.string().optional().describe('read-only record of recorded review results from persisted history; include it in the final reply when the loop ends'),
        round: z.number().optional(),
        gateRound: z.number().optional(),
        // Diagnostics the controller emits on REWORK / PASS / HUMAN_REQUIRED /
        // NOT_ACCEPTED shapes. Every key the result can carry must be declared:
        // strict MCP clients reject structuredContent with undeclared fields.
        currentPhase: z.string().nullable().optional(),
        maxRounds: z.number().optional(),
        gateRepairCount: z.number().optional(),
        convergenceEpoch: z.number().optional(),
        epochReviewRound: z.number().optional(),
        epochReviewBudget: z.number().optional(),
        supervisorEscalationCount: z.number().optional(),
        maxSupervisorEscalations: z.number().optional(),
        nonBlockingCount: z.number().optional(),
        nonBlockingOmitted: z.number().optional(),
        gate: z.record(z.string(), z.any()).nullable().optional(),
        reviewer: z.string().nullable().optional(),
        terminal: z.boolean().optional(),
        budgetExhausted: z.boolean().optional(),
        submittedCount: z.number().nullable().optional(),
        retryRequired: z.boolean().optional(),
        lastReview: z.record(z.string(), z.any()).nullable().optional(),
        safetyEvents: z.array(z.any()).optional(),
        reason: z.string().nullable().optional(),
        completedPhase: z.record(z.string(), z.any()).optional(),
        nextPhase: z.record(z.string(), z.any()).nullable().optional(),
        finalGatePending: z.boolean().optional(),
        nextDiffScope: z.enum(['phase-delta', 'cumulative']).optional(),
        blockingFindings: z.array(z.record(z.string(), z.any())).optional(),
        nonBlockingFindings: z.array(z.record(z.string(), z.any())).optional(),
        supervisorGuidance: z.string().nullable().optional(),
        head: z.string().nullable().optional(),
        nextAction: z.string().nullable().optional(),
        evidenceSubmission: z.record(z.string(), z.any()).optional().describe('explicit NOT_ACCEPTED receipt on Gate failure, code mutation or invalid input; evidence must be re-submitted'),
        missingEvidenceRequirements: z.array(z.record(z.string(), z.any())).optional(),
        resumePacket: z.record(z.string(), z.any()).nullable().optional(),
        contextRefreshSafe: z.boolean().optional(),
        evidenceRecordCount: z.number().int().nonnegative().optional(),
        designSha256: z.string().optional().describe('Design PASS only: SHA-256 of the whitespace-trimmed UTF-8 content of the design file the Reviewer actually reviewed; publish it with the design-pass comment and pass it to the Code reviewloop_begin'),
        designPassComment: z.string().optional().describe('Design PASS only: the Supervisor-written, formatted user comment (already ends with the designSha256 line); post it to the PR VERBATIM and relay it to the user, do not summarize or rewrite it'),
        planConcern: z.string().optional().describe('the Supervisor thinks following the Plan itself may be wrong; tell the user, it does not block'),
        humanQuestions: z.array(z.string()).optional().describe('HUMAN_REQUIRED: questions the user must answer'),
        reviewerProposals: z.array(z.record(z.string(), z.any())).optional().describe('REWORK exchange / HUMAN_REQUIRED: the independent Reviewer approaches to weigh against your design'),
        exchangeCount: z.number().optional(),
        comparison: z.record(z.string(), z.any()).optional(),
        reviewTarget: z.string().optional(),
        telemetry: z.record(z.string(), z.any()).optional(),
      },
    },
    async ({ loopId, evidence }, extra) => {
      const res = await ctl.review({
        loopId,
        evidence: evidence ?? [],
        signal: extra?.signal,
        onHeartbeat: progressNotifier(extra, loopId),
      });
      return {
        content: toolResultContent(res),
        structuredContent: res,
        isError: res.status === 'FAILED',
      };
    },
  );

  return server;
}

// Extracted as its own seam (injectable probes) so the isolation boundary —
// both AGY probes MUST use the same isolated ReviewLoop gemini dir, never
// ambient AGY config — can be asserted mechanically in tests without
// spinning up a real MCP stdio transport. When the MCP host process is
// itself AGY, an ambient `agy` invocation here would load the ambient AGY
// MCP config (which includes this very ReviewLoop server), spawning a child
// AGY/ReviewLoop process chain. Isolation, not Worker-identity detection, is
// what closes that loop.
export async function resolveMcpStartupRuntimeInputs({
  probeAgyModelCatalog: probeCatalog = probeAgyModelCatalog,
  detectAgyCustomAgentSupport: detectCustomAgentSupport = detectAgyCustomAgentSupport,
  narrowAgyGeminiDir: resolveAgyGeminiDir = narrowAgyGeminiDir,
} = {}) {
  // Probe runtime resolution inputs once at startup: the `agy models` catalog
  // (metadata listing, not a model call) and the CLI-transport availability
  // (`codex --version` / `claude --version`). Both degrade safely on failure.
  const agyGeminiDir = resolveAgyGeminiDir();
  const [agyCatalog, transportRuntime, customAgentSupport] = await Promise.all([
    Promise.resolve().then(() => probeCatalog({ geminiDir: agyGeminiDir })),
    probeReviewTransportRuntime(),
    // Zero-model-turn probe: does this agy build load the isolated
    // reviewloop-minimal agent from the redirected gemini dir? Unsupported ->
    // the AGY families fail closed instead of silently running the default agent.
    detectCustomAgentSupport({ geminiDir: agyGeminiDir }).catch((err) => ({
      supported: false, reason: `capability probe threw: ${err?.message ?? err}`,
    })),
  ]);
  return { agyCatalog, transportRuntime, customAgentSupport };
}

export async function startReviewLoopMcpServer(options = {}) {
  // Shared settings file: discards legacy managed env vars with a warning and
  // populates limits/timeouts from reviewloop.settings.json before anything
  // resolves them, so every client gets the same values.
  applySettingsFile(process.env);
  const { agyCatalog, transportRuntime, customAgentSupport } = await resolveMcpStartupRuntimeInputs();
  const server = createReviewLoopMcpServer({
    agyCatalog, transportRuntime, customAgentSupport, ...options,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
