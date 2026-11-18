# Design — ReviewLoop PR Task 生产集成修复与真实闭环验收

- **Task:** `RL-PR-TASK-20261118-INTEGRATION-REPAIR-01`
- **Design Version:** v1.0（对应 Plan: `Integration Repair Plan v1.0`，`tasks/pr-task-20261118/integration-repair/Plan.md`）
- **Code LoopId (Design):** `rl-20261118055356-f6eebb5b`
- **冻结工程政策：** `policy_sha = 7f01e5a3ff53ed13ba763d684a098c0989425ec4`
- **核查仓库基线：** `Jiaze-Li/reviewloop` @ `a5f7d2a424c7ae569517b658a767bba6a6f35eff`（基于 `main` `3caa01407f62baa4e6b9c455bfcad455c6717650` + Plan commit）；只读依赖 `Jiaze-Li/pr-bot` @ `523eb01c4b6eec36ef9243e2c16a50db00519569`

## 1. 目标、范围与非目标

- **目标：** 在现有 ReviewLoop `taskType: "pr"` 架构内，打通与生产 `pr-bot` 的真实会话契约（I1）、授权 Push 后的受控 HEAD 推进（I2）、`@gemini review` 三次触发账本的统一生产入口（I3）、Claude/Codex 真实会话身份绑定与唤醒（I4）、Watcher 容错与可用性交接（I5），并在受控测试 PR 上完成真实 Fix 与 Verified Dismiss 闭环验证（AC-01～AC-09）。
- **范围：** 仅修改 `Jiaze-Li/reviewloop`（`objective.js`、`state.js`、`prTaskEngine.js`、`prWakeAdapter.js`、`prWatcher.js`、`prCli.js`、`controller.js`、`taskBegin.js`、`bin/reviewloop.js`、`src/mcp/reviewloopMcpServer.js` 及对应测试与用户文档）。
- **非目标：** 不修改 `Jiaze-Li/pr-bot`；不重做原 PR #51 全部代码与历史 `rl-20261118045441-e8d00340` loop；不引入第三个 MCP 工具或常驻系统守护进程；不自动 merge、force-push 或绕过用户逐项授权。

## 2. 已核实事实（代码与真实生产证据）

1. **Bot 登录名与状态格式不匹配（I1）：**
   - `src/reviewloop/objective.js:146`：`export const DEFAULT_TRUSTED_BOT_LOGINS = Object.freeze(['claude-review-bot[bot]']);`
   - `src/reviewloop/prTaskEngine.js:58-60`：`parseJsonSessionPayload` 匹配 `<!-- jiaze-review-session:v1 ({...}) -->`；`prTaskEngine.js:69-89` 用正则从 Markdown 提取 `status`/`lastReviewedHead`/`findings`。
   - PR #51 真实 Bot 评论 `issuecomment-6969829315`：作者为 `jiaze-claude-review-bot[bot]`，首行为 `<!-- jiaze-review-session:v1 -->`，末尾为 `<!-- jiaze-review-state:<base64url> -->`，解码后包含 `version: 1`, `sessionId`, `lastReviewedHead`, `status: "READY"`, `auditCompleted: true`, `findings: [...]`, `fullAuditHead`, `dismissed`。
   - `src/reviewloop/prTaskEngine.js:151`：`const openFindings = findings.filter((f) => f.status !== 'DISMISSED' && f.status !== 'RESOLVED' && f.status !== 'DOWNGRADED_NON_BLOCKING');`
   - `pr-bot` `scripts/review-session-core.mjs:5-6,46`：`isBlockingFinding` 为 `P0/P1/P2` 或 `!finding.downgradedFrom` 的 `P3`；`CLOSED_FINDING_STATUSES = new Set(['FIXED', 'DISMISSED', 'WAIVED', 'DEFERRED'])`；`READY` 需 `auditCompleted === true && openMaterialFindings.length === 0 && unresolvedMaterialFindings.length === 0`（`scripts/review-session-core.mjs:103-107`）。
2. **HEAD 冻结与缺少受控推进入口（I2）：**
   - `src/reviewloop/objective.js:455-456`：冻结 `objective.prContext` 不可变；`src/reviewloop/state.js:72`：`boundHeadSha: ctx.boundHeadSha ?? null`。
   - `src/reviewloop/prTaskEngine.js:187-197`：`evaluatePrStatus` 在 `liveHeadSha !== boundHeadSha` 时直接返回 `HUMAN_REQUIRED (HEAD_DRIFT)`。仓库中无更新 `prTask.boundHeadSha` 的生产入口。
3. **触发账本未接通 CLI/Worker 入口且未知 POST 结果过早标记 FAILED（I3）：**
   - `src/reviewloop/prTaskEngine.js:321-468` 已实现 `triggerGeminiReview`（`MAX_REVIEW_TRIGGERS = 3`、`PENDING` -> `POSTED` 幂等标记与崩溃对账）。
   - `src/mcp/reviewloopMcpServer.js:96-230` 仅注册 `reviewloop_begin`、`reviewloop_review`；`bin/reviewloop.js:243-302` 仅提供 `reviewloop pr <status|resume|stop>`，无调用 `triggerGeminiReview` 的入口。
   - `src/reviewloop/prTaskEngine.js:453-458`：当 `postCommentFn` 抛错（含超时/网络中断但 GitHub 实际已接收 POST）时直接将记录置为 `FAILED`，若重试会分配新 `attemptIndex` 和新 `idempotencyKey`，存在重复发帖风险。
4. **自动唤醒缺少会话身份注入（I4）：**
   - `src/reviewloop/prWakeAdapter.js:123-125` 读取 `prTask?.watcher?.agentType` 与 `prTask?.watcher?.agentSessionId`，缺失时返回 `MANUAL_REQUIRED (MISSING_AGENT_SESSION_ID)`；`agy` 返回 `AGY_AUTO_WAKE_UNSUPPORTED`。
   - `src/reviewloop/state.js:82` 初始化 `watcher: null`；`src/reviewloop/objective.js:148-188` 的 `normalizePrContext` 与 `src/mcp/reviewloopMcpServer.js:108-127` 均未接收或传递 `agentType` / `agentSessionId`。
5. **Watcher 缺少网络容错（I5）：**
   - `src/reviewloop/prWatcher.js:215-226`：仅捕获 `LEASE_HELD`，`fetchPrSnapshotFn` 抛错会直接中止 Watcher 进程，未记录可恢复错误状态或退让重试。

## 3. Options（方案比较与否决理由）

### 决策 A：Worker 执行 Push 推进 HEAD 与触发 `@gemini review` 的生产入口
- **方案 A1（推荐 — 复用 `reviewloop pr` CLI 子命令）：** 保持 MCP 工具仍为 `reviewloop_begin` 和 `reviewloop_review`，在 `bin/reviewloop.js` 增加 `reviewloop pr push --loop <loopId>`（核验 `permissions.push`、分支、祖先关系、远端未漂移后执行非强制 `git push` 并更新 `prTask.boundHeadSha`）与 `reviewloop pr trigger-review --loop <loopId>`（在 lease 下调用 `triggerGeminiReview`）。
  - *优点：* 不引入第 3 个 MCP 工具（契合 Plan 第 4 节），不改 MCP 客户端协议，所有写操作复用 `acquireLoopFileLease` 原子持久化。
- **方案 A2（否决 — 新增第 3 个 MCP 工具 `reviewloop_pr_action`）：** 违反 Plan “不引入第三个 Worker 接口作为默认前提”约束，且需要所有客户端重载 MCP schema。
- **方案 A3（否决 — 在 `reviewloop_review` 内隐式自动重绑 HEAD）：** 无法区分“Worker 授权 push”与“外部 push/rebase 后本地 pull”，会破坏 `HEAD_DRIFT` fail-closed 安全边界。

### 决策 B：会话身份（`agentType` / `agentSessionId`）注入路径
- **方案 B1（推荐 — `prContext` 可选声明 + `reviewloop pr bind-agent` CLI）：** 在 `prContext` 允许可选 `agentType` / `agentSessionId`（写入 `initialPrTaskState.watcher`），同时提供 `reviewloop pr bind-agent --loop <loopId> --agent <claude|codex|agy> [--session <id>]` 在 lease 下更新；不伪造或猜测 session ID。
  - *优点：* 兼容 MCP 启动时绑定与 CLI 运行期补绑，显式可审计。
- **方案 B2（否决 — 仅靠环境变量或进程树启发式猜测）：** 多会话并行时极易绑错 `agentSessionId`，导致唤醒错会话。

## 4. Assumptions

1. 生产 `pr-bot` 持续使用 `<!-- jiaze-review-session:v1 -->` 与 `<!-- jiaze-review-state:<base64url> -->`（`version: 1`），且仅当 `status === "READY"` 且 `auditCompleted === true` 且无未关闭阻塞 finding 时才代表可结束。
2. Worker 在支持自动唤醒的环境（Claude Code / Codex CLI）中，可通过 `--resume <sessionId>` / `exec resume <sessionId>` 恢复；AGY 或无 `sessionId` 环境降级为 `MANUAL_REQUIRED` 并给出 `reviewloop pr resume --loop <loopId>`。
3. 真实 E2E（AC-07/AC-08）将在用户单独授权的测试 PR 上运行，且本机已具备有效 `gh auth` 与目标 CLI 凭证；若任一外部前提缺失，必须如实报告 `BLOCKED` / `NOT_VERIFIED`。

## 5. 核心设计与不变量

### 5.1 真实 Bot 会话解析（I1 / AC-01）
- `DEFAULT_TRUSTED_BOT_LOGINS` 更新为 `['jiaze-claude-review-bot[bot]', 'claude-review-bot[bot]']`（保留向后兼容，可由 `prContext.trustedBotLogins` 覆盖）。
- `parseTrustedBotSession` 优先级与 fail-closed 规则：
  1. 仅接受 `author` 在 `allowedLogins` 中且包含 `jiaze-review-session:v1` 的评论；若存在多条同时间戳或不同 sessionId 的活跃会话无法唯一确定最新评论，标 `parseable: false`。
  2. 若存在 `<!-- jiaze-review-state:([A-Za-z0-9_-]+) -->`，必须以 base64url + JSON 解析为唯一权威；解析失败或 `version !== 1` 时立即返回 `parseable: false, sessionStatus: UNKNOWN`（**禁止回退到可见 Markdown 的 `Status: **READY**`**）。
  3. 仅当不存在 `jiaze-review-state:` 时，兼容旧测试/历史内联 JSON 与 Markdown 解析。
  4. Finding 阻塞判定对齐 `pr-bot`：非关闭状态（非 `FIXED`/`DISMISSED`/`WAIVED`/`DEFERRED`/`RESOLVED`/`DOWNGRADED_NON_BLOCKING`）且（`P0`/`P1`/`P2` 或 `P3 && !downgradedFrom`）计入 `openFindings`（阻塞）；降级 P3（`downgradedFrom` 存在）保留在 `findings` 但不阻塞。
  5. `evaluatePrStatus` 对 `READY` 增加硬校验：必须 `lastReviewedHead === liveHeadSha`、`auditCompleted === true`（当字段存在时）、`staleFor !== liveHeadSha` 且 `openFindings.length === 0`；若 `status === 'READY'` 但 `openFindings.length > 0` 或 `auditCompleted === false`（且无 `AUDIT_PENDING`），判 `HUMAN_REQUIRED (INCONSISTENT_BOT_READY)`。

### 5.2 受控 HEAD 推进（I2 / AC-02）
- 保持 `objective.prContext.boundHeadSha` 永久冻结不改；仅推进可变状态 `prTask.boundHeadSha`，并追加 `prTask.headHistory[]`（`{ fromSha, toSha, pushedAt, actor: 'worker' }`）。
- `pushPrHead({ loopId, store, execFn, fetchPrSnapshotFn, withLeaseFn })`（CLI `reviewloop pr push --loop <loopId>`）：
  1. 在 lease 外/前检查：`prTask.permissions.push === true`、`prState.state === 'OPEN'`、`prState.headRefName === prTask.headBranch`、`prState.headRefOid === prTask.boundHeadSha`（确保远端无外部漂移）。
  2. 校验本地 `prTask.repoRoot` 当前分支为 `prTask.headBranch`，`localHead = git rev-parse HEAD` 与 `boundHeadSha` 不同，且 `git merge-base --is-ancestor <boundHeadSha> <localHead>` 为真（禁止 rebase/amend/force-push 历史重写）。
  3. 执行 `git push origin HEAD:<headBranch>`（无 `--force`），随后再拉取 `fetchPrSnapshotFn` 确认远端 `headRefOid === localHead`。
  4. 在 lease 下再次校验 `prTask.boundHeadSha === oldSha` 后更新 `prTask.boundHeadSha = localHead` 并保存。任何一步不满足均 fail closed，不修改 `boundHeadSha`。

### 5.3 有界 `@gemini review` 触发与不确定 POST 对账（I3 / AC-03）
- CLI `reviewloop pr trigger-review --loop <loopId>` 在 `acquireLoopFileLease` 下调用 `triggerGeminiReview`。
- 修正 `triggerGeminiReview` 未知 POST 失败路径：当 `postCommentFn` 抛错时，先保留 `PENDING`（记录 `lastError`），或再次拉取 PR comments 检查 `triggerMarker(idempotencyKey)` 是否已落地；仅当确认未落地且超过 `pendingTtlMs` 时才转为 `FAILED`，防止网络超时导致重复发帖。

### 5.4 会话身份绑定与 Watcher 容错（I4, I5 / AC-04, AC-05）
- `normalizePrContext` 支持可选 `agentType`、`agentSessionId`；`initialPrTaskState` 将其写入 `watcher: { agentType, agentSessionId }`；新增 `reviewloop pr bind-agent --loop <loopId> --agent <type> [--session <id>]`。
- `runPrWatcher` 捕获 `fetchPrSnapshotFn` 瞬时网络/CLI 异常：记录 `watcher.lastError`、`watcher.consecutiveErrors` 并按 `backoffMs` 重试直至 `maxWaitMs`；超时或退出时在 lease 下清除 `watcher.pid = null` 并置 `wakeStatus = 'MANUAL_REQUIRED'`。

### 5.5 核心不变量
- **INV-1（冻结边界）：** `objective.prContext` 与原 #51 `rl-20261118045441-e8d00340` 状态永不改写。
- **INV-2（触发上限）：** 同一 `loopId` 的 `POSTED + PENDING` `@gemini review` 触发数严格 `<= 3`；Dismiss 不计入。
- **INV-3（权威单一）：** 所有状态与 finding 裁决以 `jiaze-review-state`（及 `pr-bot`）为准，不以可见文本放行，不自建审查器。
- **INV-4（诚实降级）：** 无 `autoWake`、不支持平台（如 AGY）或缺失真实 `agentSessionId` 时一律 `MANUAL_REQUIRED`，绝不虚报 `WOKEN`。

## 6. 验证矩阵与实现顺序

| 声明 | 失效方式 | 检出证据 |
|---|---|---|
| I1 真实 Bot 契约 | 仅认旧内联 JSON 或盲信可见 READY | 使用 PR #51 `issuecomment-6969829315` 真实 `jiaze-review-state` fixture 跑正向/畸形/旧 HEAD/缺 `auditCompleted`/P3 降级/伪造作者单测（AC-01） |
| I2 受控 HEAD 推进 | 外部 push/rebase 被静默重绑 | `pr push` 单测覆盖正常快进 push、外部 drift 拒绝、non-ancestor rebase 拒绝、关闭 PR 拒绝（AC-02） |
| I3 触发上限与对账 | POST 超时后重复发帖超 3 条 | 并发 + POST 抛错但评论已落地对账单测；上限 3 次阻塞验证（AC-03） |
| I4/I5 唤醒与 Watcher | 假 sessionId / 断网进程崩溃 | `bind-agent` + Claude/Codex 命令构造 + AGY 降级 + 断网退让恢复单测（AC-04/AC-05） |
| 全量回归 | 破坏 `code`/`design`/旧 `mode=PR` | `npm test`、`reviewloop doctor` 全绿绑定 HEAD（AC-06） |
| 真实 E2E | 单测全绿但线上协议/权限不通 | 在用户授权测试 PR 实测 Fix（AC-07）与 Verified Dismiss（AC-08），记录 comment IDs/HEAD/Bot 会话/实际唤醒结果；缺权限则标 `BLOCKED` |

**实现顺序：** (1) `objective.js` + `state.js` + `prTaskEngine.js`（I1 & 未知 POST 对账）；(2) `prTaskEngine.js` + `prCli.js` + `bin/reviewloop.js`（I2 `pr push` & I3 `pr trigger-review`）；(3) `prWatcher.js` + `prCli.js` + `bin/reviewloop.js` + `src/mcp/reviewloopMcpServer.js`（I4 `bind-agent` & I5 Watcher 容错）；(4) 补齐回归测试与用户操作文档（AC-09）；(5) 在用户单独授权后执行真实测试 PR E2E（AC-07/AC-08）。

**人工关口与待确认授权：** Design PASS 后停止，等待用户明确说「Code」及分别确认：(a) ReviewLoop 仓库 `edit`/`commit`/`push`；(b) 本机安装更新（如需要）；(c) 真实测试 PR 的 `edit`/`commit`/`push`/`comment`/`autoWake` 单独授权。

---

## 7. Work Contract（Code 阶段唯一权威合同）

1. **任务标识：** `RL-PR-TASK-20261118-INTEGRATION-REPAIR-01`；基于 `Integration Repair Plan v1.0` 与本 Design v1.0 实施；冻结 `policy_sha = 7f01e5a3ff53ed13ba763d684a098c0989425ec4`。
2. **必须保持的不变量：**
   - 不修改 `Jiaze-Li/pr-bot`；不修改原 #51 `Plan.md`/`Design.md` 或历史 `rl-20261118045441-e8d00340` 状态；不破坏 `code`/`design` 及旧 `mode=PR` 隔离。
   - 不新增第 3 个 MCP 工具或后台守护服务；通过 `reviewloop pr` CLI 与现有 `reviewloop_begin`/`reviewloop_review` 贯通。
   - `MAX_REVIEW_TRIGGERS = 3`、`HEAD_DRIFT` fail-closed、`HUMAN_REQUIRED` 立即停止、分项授权（`edit`/`commit`/`push`/`comment`/`autoWake`）全部强制执行。
3. **全局验收标准（AC-01～AC-09）：**
   - **AC-01：** 真实 `jiaze-claude-review-bot[bot]` 与 `<!-- jiaze-review-state:<base64url> -->` 解析及 fail-closed 校验（含 `auditCompleted`、`staleFor`、阻塞/降级 P3、闭环 finding 状态）通过可核查 fixture 测试。
   - **AC-02：** `reviewloop pr push --loop <id>` 验证授权、分支、祖先关系与远端未漂移后推进 `prTask.boundHeadSha`，不改写 `objective.prContext`。
   - **AC-03：** `reviewloop pr trigger-review --loop <id>` 统一走 `triggerGeminiReview` 账本，未知 POST 错误保守对账不重复发帖，总有效触发严格 `<= 3`。
   - **AC-04/AC-05：** 支持 `prContext` 与 `reviewloop pr bind-agent` 绑定真实 Claude/Codex 会话，AGY/无授权降级 `MANUAL_REQUIRED`；Watcher 捕获瞬时网络/GH 错误并安全退让恢复。
   - **AC-06：** 完整 `npm test` 与 `node bin/reviewloop.js doctor` 在最终 HEAD 通过。
   - **AC-07/AC-08：** 在用户明确授权测试 PR 与动作权限后，完成真实 Fix 与 Verified Dismiss 线上 E2E 并记录真实 comment IDs、HEAD 与 Bot 会话；未获外部测试 PR 授权或遇环境/配额不足时，如实标 `BLOCKED`/`NOT_VERIFIED`，禁止以 mock 冒充 PASS。
   - **AC-09：** 提供可直接复制的安装、启动、状态查看、停止/恢复与授权边界操作说明，明确区分本地单测与真实 E2E 状态。
4. **阶段划分建议（Code 阶段执行）：**
   - **Phase 1（Bot 契约与触发/HEAD 引擎）：** 完成 I1 解析校验、I2 `pushPrHead`、I3 保守 POST 对账与对应单测。
   - **Phase 2（CLI/MCP 贯通、会话绑定、Watcher 容错与文档）：** 完成 `pr push`/`pr trigger-review`/`pr bind-agent`、`prWatcher` 网络容错、回归测试、`npm test` + `doctor`、用户操作文档（AC-09）。
   - **Phase 3（受控真实 E2E，需用户单独授权测试 PR 后执行）：** 执行 AC-07 Fix E2E 与 AC-08 Verified Dismiss E2E，提交可核查线上证据（或记录明确 `BLOCKED` 原因）。
5. **停止条件：** Code 本地 PASS 后停止并报告，未获明确授权不得 commit/push/部署/merge；任何阶段遇到 `HUMAN_REQUIRED` 或权限/外部协议阻塞立即停止并向用户报告。
