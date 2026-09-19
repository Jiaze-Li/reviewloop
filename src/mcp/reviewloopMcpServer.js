// ReviewLoop MCP Server.
//
// Deliberately TINY agent-facing surface — every exposed tool/schema is
// always-loaded Worker context. Exactly two normal Worker-facing tools:
//
//   reviewloop_begin(goal, cwd, prNumber?, phases?)
//       Register the immutable task objective + optional phase plan and capture the baseline
//       (LOCAL) or bind the exact PR snapshot: repository, prNumber, base SHA,
//       HEAD SHA (PR). Zero model calls.
//
//   reviewloop_review(loopId)
//       The one re-entrant operation: deterministic Gate -> Reviewer (if
//       justified) -> convergence policy -> Supervisor (only on non-
//       convergence). For a PR target the same engine runs over the PR
//       base -> exact HEAD diff, with a pre-PASS live-HEAD recheck. Returns
//       PHASE_PASS | PASS | REWORK | HUMAN_REQUIRED | WAITING_FOR_REVIEW |
//       NO_PROGRESS | PUSH_REQUIRED. PHASE_PASS is non-terminal; PASS is final.
//
// Status / dashboard / stop live on the human `reviewloop` CLI, not here.

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
import { RouteAuditLog } from '../orchestrator/roleRouting.js';
import { probeAgyModelCatalog } from '../agy/agyModelCatalog.js';
import { probeReviewTransportRuntime } from '../reviewloop/adapters/cliReviewTransports.js';

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
  const ctl = controller ?? createReviewLoopController(
    createProductionReviewLoopProviders({
      agyCatalog,
      transportRuntime,
      customAgentSupport,
      routeAudit: new RouteAuditLog({ filePath: path.join(os.homedir(), '.reviewloop', 'route-audit.log') }),
      healthRevalidator: createAgyZeroTokenHealthRevalidator(),
    }),
  );

  server.registerTool(
    'reviewloop_begin',
    {
      description:
        'Register one ReviewLoop session for a non-trivial coding task BEFORE your first edit so the baseline is captured. If the task contract has explicit execution phases, pass the frozen phase plan here; do not open a new loop between phases. Pass prNumber to review an open PR instead (PR base -> exact PR HEAD). ReviewLoop does not implement the task — you do, in this session. Returns a loopId. Zero model calls.',
      inputSchema: {
        goal: z.string().min(1).describe('the original user coding goal (immutable success definition)'),
        cwd: z.string().optional().describe('workspace directory (default: server cwd)'),
        prNumber: z.number().int().optional().describe('PR number — review the PR (base -> exact HEAD) instead of the local worktree'),
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
        verificationCommands: z.array(z.string().min(1)).optional().describe('global whole-task deterministic Gate commands, frozen at begin and run at every phase gate plus the final gate; phase-local commands belong in phases[].verificationCommands'),
        blockingSeverities: z.array(z.string().min(1)).min(1).optional().describe('finding severities that block this task; defaults to P1 and P2'),
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
        mode: z.enum(['LOCAL', 'PR']),
        status: z.literal('READY'),
        baseline: z.record(z.string(), z.any()).nullable(),
        prHead: z.string().nullable(),
        prBaseSha: z.string().nullable().optional(),
        repository: z.string().nullable().optional(),
        reviewer: z.string(),
        phaseCount: z.number().int().optional(),
        currentPhase: z.string().optional(),
      },
    },
    async ({
      goal,
      cwd: reqCwd,
      prNumber,
      constraints,
      contractText,
      evidenceRequirements,
      verificationCommands,
      blockingSeverities,
      maxReviewRounds,
      phases,
    }, extra) => {
      const res = await ctl.begin({
        goal,
        cwd: reqCwd ? path.resolve(reqCwd) : cwd,
        prNumber: prNumber ?? null,
        constraints: constraints ?? [],
        contractText: contractText ?? '',
        evidenceRequirements: evidenceRequirements ?? [],
        verificationCommands: verificationCommands ?? null,
        blockingSeverities,
        maxReviewRounds,
        phases: phases ?? [],
        signal: extra?.signal,
      });
      const structured = {
        loopId: res.loopId,
        mode: res.mode,
        status: 'READY',
        baseline: res.baseline ?? null,
        prHead: res.prHead ?? null,
        prBaseSha: res.prBaseSha ?? null,
        repository: res.repository ?? null,
        reviewer: res.reviewer,
        phaseCount: res.phaseCount ?? 0,
        currentPhase: res.currentPhase ?? 'task',
      };
      return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured };
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
          summary: z.string().min(1),
          artifactRef: z.string().min(1).optional(),
        })).optional().describe('non-command evidence produced for the current gate; ReviewLoop binds it to the exact current code/review scope'),
      },
      outputSchema: {
        status: z.string(),
        loopId: z.string(),
        round: z.number().optional(),
        gateRound: z.number().optional(),
        reason: z.string().nullable().optional(),
        completedPhase: z.record(z.string(), z.any()).optional(),
        nextPhase: z.record(z.string(), z.any()).nullable().optional(),
        finalGatePending: z.boolean().optional(),
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
        telemetry: z.record(z.string(), z.any()).optional(),
      },
    },
    async ({ loopId, evidence }, extra) => {
      const res = await ctl.review({
        loopId,
        evidence: evidence ?? [],
        signal: extra?.signal,
        onHeartbeat: async (msg) => {
          if (typeof extra?.sendNotification === 'function') {
            try {
              await extra.sendNotification({
                method: 'notifications/progress',
                params: {
                  progressToken: extra?._meta?.progressToken ?? loopId,
                  progress: 1,
                  message: msg ?? `ReviewLoop ${loopId}: waiting (0 model tokens)`,
                },
              });
            } catch { /* ignore */ }
          }
        },
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
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
  const { agyCatalog, transportRuntime, customAgentSupport } = await resolveMcpStartupRuntimeInputs();
  const server = createReviewLoopMcpServer({
    agyCatalog, transportRuntime, customAgentSupport, ...options,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
