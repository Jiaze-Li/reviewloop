# Design — ReviewLoop PR Task (`taskType: 'pr'`)

- **任务标识**: `RL-PR-TASK-20261118`
- **设计版本**: `Design v1.0`
- **Plan 版本**: `Plan v1.0` (`tasks/pr-task-20261118/Plan.md`)
- **工程规范 `policy_sha`**: `7f01e5a3ff53ed13ba763d684a098c0989425ec4`
- **核查仓库基线**: `dd8d7d8af9912a5ccb11717e20e55abdbd2cd57a`（当前分支 `plan/pr-task-20261118` @ `a0090cfe7cd4c9539afd979b0223e038e6ac7558`）
- **外部依赖**: `Jiaze-Li/pr-bot` `523eb01c4b6eec36ef9243e2c16a50db00519569`（PR #94 Verified Dismiss 已合并；真实线上 Dismiss E2E 仍待实证，不得预先标为 PASS）

## 1. 目标、范围与非目标

**目标：** 在 ReviewLoop 中新增 `taskType: 'pr'`（PR 问题修复编排），使本地 Worker 在用户指定 PR 后能自动绑定 PR 与原任务合同、读取可信 `claude-review-bot` session findings、在授权内完成修复或 `@gemini dismiss` 反驳、对主动发送的 `@gemini review` 持久计数（单任务上限 3 条），并在 Bot 审查期间以**零 LLM Token**方式等待与受控唤醒恢复。

**范围：**
- `reviewloop_begin` / `reviewloop_review` 支持 `taskType: 'pr'`（保持两工具 MCP 入口，D15）。
- PR/Bot 状态读取与校验（GitHub App 身份、`<!-- jiaze-review-session:v1 -->`、`lastReviewedHead === liveHeadSha`）。
- 持久化状态（`prTask` 命名空间 + `reviewTriggers` 幂等账本）与旧 `mode: 'PR'` 数据严格隔离。
- 零 LLM 本地后台 Watcher 进程与受控 Agent 唤醒适配器（`claude` / `codex` / 显式降级）。
- `bin/reviewloop.js` 增加只读状态查看与手动恢复子命令。

**非目标：** 不在 ReviewLoop 内重做代码/设计模型审查、P3 分类或 Dismiss 裁决；不修改 `pr-bot` 现有策略（如 `MAX_VERIFICATION_ROUNDS=2`）；不新增公开 HTTP webhook 或持久凭据；不自动 `merge`、`force-push`、修改权限或绕过 `HUMAN_REQUIRED`。

## 2. Options（路线比较与否决理由）

| 路线 | 核心做法 | 优点 | 否决/采用理由 |
|---|---|---|---|
| **Option A（采用）：复用 `taskType: 'pr'` 两工具契约 + 本地零 LLM Watcher 进程 + CLI 会话唤醒** | `reviewloop_begin({ taskType: 'pr' })` 冻结 PR/合同绑定；`reviewloop_review` 推进状态并在等待 Bot 时返回 `WAITING_FOR_REVIEW`，同时派生分离的零模型 Node Watcher 进程（使用本地 `gh` CLI 退避轮询）；Bot 更新可信结果后通过 `claude --resume` / `codex exec resume` 唤醒原会话，不支持时落盘等待手动 `reviewloop resume`。 | 严格遵守 D15（不扩 MCP 工具数）；等待期间 0 LLM Token；进程/终端退出不丢任务；无需公网 webhook 或新凭据；复用 `Persistence` 与 `loopLease`。 | **采用**。兼顾零空转、断线可恢复与最小权限边界。 |
| **Option B（否决）：MCP `reviewloop_review` 阻塞长轮询** | 在 `reviewloop_review` 调用内部 `while` 轮询 GitHub 直到 Bot 返回，仅靠 MCP progress 续命。 | 实现最简单，无需 Watcher 子进程或 CLI 唤醒。 | **否决**。MCP 客户端通常有工具超时；Worker 进程退出或终端关闭即断线丢任务；违反 Plan 3.8 与 AC-05（不得用阻塞工具长轮询伪装自动唤醒）。 |
| **Option C（否决）：常驻全局守护进程 + 公网 GitHub Webhook** | 启动长期后台 HTTP 服务接收 GitHub App webhook 并路由到本地会话。 | 事件延迟最低，无需轮询。 | **否决**。需暴露公网端点（隧道/域名）并管理 webhook secret/凭据，违反 Plan 3.9 与 4（不得未经许可新增公开 webhook 或持久凭据）。 |

## 3. Assumptions（未明说的默认前提）

1. **GitHub 访问传输**：本地运行环境中已安装并登录 `gh` CLI，具备目标仓库的读取权限；仅当用户明确授权对应操作时才通过 `gh` 执行 `push` 或 `pr comment`。ReviewLoop 不单独存储 GitHub Token 或 App 私钥。
2. **可信 Bot 识别**：可信 `pr-bot` 身份通过配置的 GitHub App 登录名（默认 `claude-review-bot[bot]`，可在 `reviewloop.settings.json` 覆盖）与评论体内的 `<!-- jiaze-review-session:v1 -->` 结构化标记共同核验；其他用户或普通账号发布的同名文本一律忽略。
3. **Agent 自动唤醒边界**：自动唤醒依赖目标 Agent CLI 支持非交互恢复（如 `claude --resume <id> -p ...` 或 `codex exec resume <id> ...`）且用户未禁用自动唤醒；若当前环境为 Antigravity（`agy`）、未提供/捕获会话 ID、或系统策略禁止拉起子进程，则必须明确报告 `autoWake: 'UNAVAILABLE'` 并给出可复制恢复命令，不得假称支持自动唤醒。
4. **MCP 入口形式**：Plan 3.1 提议 `taskType: 'pr'`，结合现有 D15（仅保留 `reviewloop_begin` 与 `reviewloop_review` 两个 Worker 工具），本设计默认将 PR Task 作为 `reviewloop_begin({ taskType: 'pr', ... })` 入口，而不新增第三个 MCP 工具。

## 4. 已核实事实（代码与依赖基线）

以下事实均来自本仓库实际只读核查（`Reviewer` 无权读仓库，均以此节摘录为准）：

1. **`src/reviewloop/objective.js:12-13,177`**：当前仅支持 `LOCAL` 与 `code` / `design`，显式拒绝旧 `PR` 模式：
   - `export const REVIEW_MODES = Object.freeze({ LOCAL: 'LOCAL' });`
   - `export const TASK_TYPES = Object.freeze({ CODE: 'code', DESIGN: 'design' });`
   - `if (prNumber != null || mode === 'PR') throw new Error('createReviewObjective: PR mode retired; use claude-review-bot');`
2. **`src/reviewloop/taskBegin.js:27`**：`reviewloop_begin` 入口同样拒绝 `prNumber`：
   - `if (prNumber != null) throw new Error('reviewloop_begin: PR mode has been retired; use claude-review-bot for GitHub PR review.');`
3. **`src/reviewloop/objective.js:341`**：持久化 objective 强依赖完整性指纹防篡改：
   - `if (!copy.fingerprint || copy.fingerprint !== expected)`
4. **`src/reviewloop/state.js:10-20,135-150`**：状态机已定义 `WAITING_FOR_REVIEW`、`REWORK`、`HUMAN_REQUIRED`、`PASS`，`ReviewLoopStore` 通过 `workflow.json` 的 `reviewLoop` 键读写：
   - `WAITING_FOR_REVIEW: 'WAITING_FOR_REVIEW'`
   - `const STATE_KEY = 'reviewLoop';`
5. **`src/orchestrator/persistence.js:53,59-67`**：`workflow.json` 采用原子替换写入与浅合并更新：
   - `await atomicReplaceUtf8(path.join(dir, 'workflow.json'), JSON.stringify(state, null, 2));`
6. **`src/reviewloop/loopLease.js:93-105`**：已有跨进程互斥锁 `<runtimeRoot>/<loopId>/reviewloop.lock`（含同主机 PID 存活检查与异机 TTL 续租）。
7. **`src/reviewloop/runtimeDir.js:12-17`**：运行时根目录由 `REVIEWLOOP_RUNTIME_DIR` 或 `~/.reviewloop` 决定。
8. **`src/reviewloop/resumeGuide.js:7-14`**：`retiredPr = (loop) => loop?.objective?.mode === 'PR'`，历史 `mode === 'PR'` 会话被 `isResumable` 永久排除。
9. **`src/mcp/reviewloopMcpServer.js:102-105,133-134`**：MCP Zod schema 当前限制 `taskType: z.enum(['code', 'design']).optional()`、`mode: z.literal('LOCAL')` 且拒绝 `prNumber`。
10. **`bin/reviewloop.js:47` & `bin/install-plugin.js:217-221`**：CLI `status` 将旧 `mode === 'PR'` 标为 `[RETIRED_PR]`；安装器检测 `claude`、`codex`、`agy` 三种前端。
11. **`docs/DECISIONS.md:21,42`**：D15 规定 MCP 仅两个工具；D37 规定退役 PR loop 不得恢复或转为 LOCAL。
12. **`scripts/check-pr-handoff.js:9,26-42`**：仓库已有 `<!-- reviewloop-handoff head=<40-hex> stage=<stage> loop=<id> -->` 与 `gh pr view --json headRefOid,body` 核对模式。
13. **外部依赖（`Jiaze-Li/pr-bot`）**：`523eb01c...` 已合并 PR #94（`@gemini dismiss <id>` 单 finding 独立模型裁决），但真实线上 Dismiss E2E 尚缺实证；`pr-bot` 内部 `MAX_VERIFICATION_ROUNDS=2` 为独立预算。

## 5. 架构、唯一权威与数据流

### 5.1 身份、隔离与唯一权威

- **旧数据隔离**：历史 `mode === 'PR'` 记录保持原样只读，继续被 `retiredPr()` 拦截。新建 PR Task 使用 `mode: 'LOCAL'`、`taskType: 'pr'`，并将其专属状态存放在 `workflow.json` 的 `prTask` 字段（与 `reviewLoop` 共享原子快照与 `loopLease`，互不覆盖）。
- **PR Task 绑定身份（冻结写入 `objective.prContext` 并纳入 `fingerprint`）**：
  - `repoFullName`（`owner/repo`）、`repoRoot`、`prNumber`、`baseBranch`、`headBranch`、`boundHeadSha`（当前工作 HEAD）。
  - 可追溯来源：`originLoopId`（关联本地 code loop，如存在）、`originPolicySha`（不存在则显式记为 `'unknown'`，绝不编造）、`originContractText` / `originDesignSha256`（存在时冻结引用）。创建 PR Task **不**清空或修改 `originLoopId` 的预算、证据或 `HUMAN_REQUIRED`。
- **唯一审查权威**：`claude-review-bot`（经 `trustedBotLogins` 校验 + `<!-- jiaze-review-session:v1 -->` 解析）是 PR 代码审查唯一权威。ReviewLoop 仅负责状态编排、授权检查、计数上限与零模型等待。

### 5.2 `@gemini review` 触发账本（单任务上限 3 条）

在 `prTask.reviewTriggers` 中维护持久数组，每条记录：
`{ idempotencyKey, headSha, status: 'PENDING' | 'POSTED' | 'FAILED', commentId, commentUrl, createdAt, postedAt, error }`

1. **发送前前置门禁（全部满足才允许发）**：
   - `postedCount = reviewTriggers.filter(t => t.status === 'POSTED').length < 3`；
   - 用户已授予 `comment` 权限；
   - PR 实时状态为 `OPEN` 且 `liveHeadSha === boundHeadSha`；
   - 最新可信 Bot 会话不是 `READY`（在当前 HEAD）、不是 `REVIEW_IN_PROGRESS` / `AUDIT_PENDING` / `PARTIAL`、也不是同一 `lastReviewedHead === liveHeadSha` 上未提交新代码前的重复 `REWORK`；
   - 不存在同 `headSha` 的 `PENDING` 或 `POSTED` 记录。
2. **两阶段幂等写入**：先在 `loopLease` 内写入 `PENDING`（含唯一 `idempotencyKey` 标记）并落盘 `workflow.json`，再调用 `gh pr comment`；成功后更新为 `POSTED` 与真实 `commentId`；失败记 `FAILED`（不计入 3 次上限）。崩溃恢复时先按 `idempotencyKey` 检索 PR 评论，已存在则直接补记 `POSTED`，绝不重复发表。
3. **不计入上限的操作**：`@gemini dismiss <Fxxx>`、Bot 内部 verification/audit/续跑、人类用户评论、重复 webhook 均不写入 `reviewTriggers`。

### 5.3 核心数据流与状态转换

1. **启动（`reviewloop_begin({ taskType: 'pr', goal, cwd, prContext, permissions, ... })`）**：
   - 核验本地仓库 `origin` 与 `prNumber` 对应仓库、当前分支/HEAD 一致，PR 为 `OPEN`。
   - 读取最新可信 Bot session，解析 `sessionStatus`、`lastReviewedHead`、open findings（含 P1/P2/P3 与已降级项），返回给 Worker。
2. **Worker 处理与审查触发**：
   - Worker 集中处理所有阻塞项：真实缺陷修复并跑项目测试；误报则用 `@gemini dismiss <ID>` 附 `Reason` 与 `Evidence` 请求 `pr-bot` 独立验证（`DISMISSED` 才算解决；`REJECTED` 保持 `OPEN`；`INCONCLUSIVE` 按正式状态等待或停机）。
   - 若连续两轮修复在同一个共享设计/权威边界引入新的系统性阻塞，强制转入 `HUMAN_REQUIRED` 并要求只读根因审计。
   - 获得 `commit` / `push` / `comment` 各自授权后推送并触发 `@gemini review`（更新 `boundHeadSha` 为新推送 SHA）。未获授权时停在 `READY_FOR_WORK` / `WAITING_AUTHORIZATION` 并报告待授权动作。
3. **零 LLM 等待与受控唤醒（`reviewloop_review({ loopId })`）**：
   - 当最新可信 Bot 状态为等待中（`REVIEW_IN_PROGRESS` / `AUDIT_PENDING` / `PARTIAL`）或刚触发新审查时，状态转为 `WAITING_FOR_REVIEW`，记录 `watcher` 元数据并派生独立零模型进程 `node src/reviewloop/prWatcher.js --loop <loopId>`（受 `watcher.pid` 单例锁保护）。
   - Watcher 使用 `gh` 退避轮询（15s → 30s → 60s），**全程 0 LLM 调用**。检测到以下任一事件即停止轮询并更新持久状态：
     - `READY` 且 `lastReviewedHead === boundHeadSha` → 转 `PASS`（仅代表 PR 审查 READY，仍需分别报告 CI 与合并授权）；
     - `REWORK`（含新/未决 findings）→ 转 `REWORK` 并尝试唤醒 Worker；
     - `HUMAN_REQUIRED` / PR 关闭 / `liveHeadSha !== boundHeadSha`（外部 push/rebase）→ 转 `HUMAN_REQUIRED` 或 `STOPPED` 并唤醒/通知用户；
     - 达到最大等待时长 → 退出 Watcher 并保留 `WAITING_FOR_REVIEW`（可通过 `reviewloop pr resume` 无损续接）。
   - **唤醒执行**：若 `agentType`（`claude` / `codex`）与 `agentSessionId` 有效且用户授权 `autoWake`，在原 `repoRoot` 执行受控恢复命令并注入紧凑上下文（`loopId`、`prNumber`、`boundHeadSha`、最新 findings、剩余 trigger 额度）；否则写明 `wakeStatus: 'MANUAL_REQUIRED'`，由用户执行 `reviewloop pr resume --loop <loopId>`。

## 6. 核心不变量

- **INV-1（权威唯一）**：`claude-review-bot` 是 PR 审查唯一权威；旧 HEAD 上的 `READY`、缺失/不可信/不可解析 session 一律不得判为 `READY`。
- **INV-2（触发严格有界）**：同一 `prTask` 内 `status === 'POSTED'` 的 `@gemini review` 评论数恒 `<= 3`；崩溃重试、失败请求、Dismiss、Bot audit 均不虚增或漏记。
- **INV-3（零空转等待）**：进入 `WAITING_FOR_REVIEW` 后，Worker LLM 立即结束当前轮次；Watcher 进程严禁加载或调用任何模型 Provider。
- **INV-4（权限与工作区安全）**：`edit`、`commit`、`push`、`comment`、`autoWake` 权限各自独立检查；`liveHeadSha !== boundHeadSha` 或仓库/分支不匹配时立即阻断写入。
- **INV-5（历史兼容与隔离）**：`mode === 'PR'` 历史记录不可被读取或转为 `taskType: 'pr'`；`code` 与 `design` 既有行为与指纹校验保持 100% 向后兼容。

## 7. 验证与证据矩阵

| 声明 | 潜在失效方式 | 检出证据（测试/命令） |
|---|---|---|
| 旧 `mode: 'PR'` 隔离且 `code`/`design` 无回归 | 新 `taskType: 'pr'` 破坏既有指纹或唤醒退役 PR 会话 | 单元测试 + 全量 `npm test` 回归，验证 `retiredPr()` 仍拦截旧记录且旧 `code`/`design` 测试全绿。 |
| `@gemini review` 最多 3 条且崩溃幂等 | 并发/崩溃重复发评论，或把失败/Dismiss 计入额度 | 模拟并发 `loopLease`、发送中崩溃恢复、`gh` 失败与 `@gemini dismiss` 混合场景的单元测试，核对 `reviewTriggers` 与实际调用次数。 |
| 不可信/旧 HEAD/缺失 session 绝不判 READY | 伪造评论、stale `lastReviewedHead` 或 `AUDIT_PENDING` 被误判通过 | 构造非 App 作者评论、旧 SHA `READY`、`AUDIT_PENDING`、`PARTIAL`、`HUMAN_REQUIRED` 夹具测试，断言状态机精确阻断/等待。 |
| 零 LLM 等待与断线/重启恢复 | Watcher 意外调用模型或重启后丢失 `boundHeadSha`/额度 | Watcher 进程无 Provider 依赖断言 + 杀进程重启后状态重水合（rehydrate）与无重复触发测试。 |
| 真实 PR 闭环与 `pr-bot` #94 Dismiss 实证 | Mock 通过但真实 GitHub/Agent 唤醒或 Dismiss 失败 | 在真实支持自动唤醒的环境中执行：Fix→push→`@gemini review`→`REWORK`→READY，及真实 `@gemini dismiss` 闭环，记录 comment ID 与日志；依赖不可用时诚实标为未验证。 |

## 8. 最小实现顺序与授权草案

1. **阶段 1（核心状态与隔离）**：扩展 `objective.js` / `taskBegin.js` / `reviewloopMcpServer.js` 支持 `taskType: 'pr'`、`prContext` 冻结、旧 `mode: 'PR'` 隔离及 `prTask` 持久结构。
2. **阶段 2（GitHub 读取、Session 解析与 Trigger 账本）**：实现可信 Bot 评论解析、`liveHeadSha` 校验、两阶段幂等 `@gemini review` 计数（<=3）与 `HUMAN_REQUIRED`/共享边界两轮审计升级。
3. **阶段 3（零 LLM Watcher、唤醒适配器与 CLI）**：实现 `prWatcher.js` 退避轮询、`claude`/`codex` 唤醒适配器（及不支持环境显式降级）、`bin/reviewloop.js` `pr status` / `pr resume` / `pr stop`。
4. **阶段 4（集成回归与真实 E2E 证据）**：运行全量 `npm test` 与 `npm run doctor`，在授权范围内完成真实 PR Fix + Dismiss 闭环并补齐 `pr-bot` #94 线上证据。

**Code 阶段需用户确认的授权草案（Design PASS 不自动授权以下任何项）：**
- 修改 ReviewLoop 代码与测试；
- 本地 `git commit` 与 `push` 到任务分支；
- 更新当前 Draft PR；
- 执行真实 PR 闭环测试（仅在指定测试 PR 上发表 `@gemini review` / `@gemini dismiss`）；
- 本机 `npm run install-global`（如需要测试真实 MCP/CLI 唤醒）。`merge`、修改 GitHub 权限/凭据、公网 webhook 保持未授权。

## 9. Work Contract（Code 阶段唯一权威执行合同）

### 目标与范围
在 `/Users/jack/Downloads/scripts/ReviewLoop`（`plan/pr-task-20261118` 基线）实现 `taskType: 'pr'` PR 问题修复编排能力，使本地 Worker 能绑定 PR 与原任务合同、读取可信 `claude-review-bot` session、在各自授权内修复或 `@gemini dismiss`、对主动 `@gemini review` 持久限额 3 条，并在等待 Bot 期间以零 LLM Token 后台 Watcher 挂起并在可信结果到达后受控唤醒/恢复。

### 必须遵守的不变量与硬性边界
1. 保持 MCP 仅暴露 `reviewloop_begin` 与 `reviewloop_review`（D15）；不得复活 `mode: 'PR'` 历史会话；不得破坏现有 `code` / `design` 状态、指纹与测试。
2. `claude-review-bot`（校验 App 登录名 + `<!-- jiaze-review-session:v1 -->`）为唯一 PR 审查权威；必须核对 `lastReviewedHead === liveHeadSha`，旧 HEAD / 缺失 / `AUDIT_PENDING` / `PARTIAL` / 不可解析均不得判为 `PASS`/`READY`。
3. 同一 `prTask` 主动发布的 `@gemini review` 严格 `<= 3` 条，写入 `PENDING` 幂等记录后再调用 `gh`，成功记 `commentId` 与 `headSha`，失败与 `@gemini dismiss` 不计入额度。
4. `WAITING_FOR_REVIEW` 期间严禁任何 LLM/模型调用；Watcher 仅做限频只读 GitHub 状态检查；不支持自动唤醒的 Agent/环境必须显式标为 `MANUAL_REQUIRED`，不得伪造通过。
5. `HUMAN_REQUIRED` 必须立即停机；同一共享设计/权威边界连续两轮修复引入新系统性阻塞时强制停机要求根因审计。
6. `edit`、`commit`、`push`、`comment`、`autoWake` 各自校验授权；严禁自动 `merge`、`force-push`、override review 或修改仓库权限。

### 全局验收标准（对应 Plan AC-01 ~ AC-09）
- **AC-01 ~ AC-03**：能绑定 repo/PR/HEAD/原合同并解析 findings；授权内修复测试或通过 `@gemini dismiss` 请求独立验证（`DISMISSED` 才算解决）；HEAD 漂移/PR 关闭/未授权时阻断写入。
- **AC-04 ~ AC-06**：主动 `@gemini review` 严格 `<= 3` 且崩溃不重发；等待期间 0 LLM Token；支持环境可自动唤醒且断线/重启可恢复；`READY`/`REWORK`/`AUDIT_PENDING`/`PARTIAL`/`HUMAN_REQUIRED` 状态映射准确。
- **AC-07 ~ AC-09**：覆盖并发锁、stale HEAD、rebase、并行 push、旧 `mode: 'PR'` 隔离、控制面可见性（`0-3` 计数/HEAD/findings/授权/停机理由），全量 `npm test` 通过，并在真实环境完成 Fix 与 Dismiss（含 `pr-bot` #94）端到端验证或诚实报告外部阻塞。

### 分阶段计划（供 Code `reviewloop_begin` 使用）
- **Phase 1 (`pr-core-state`)**：`objective.js`、`taskBegin.js`、`state.js`、`reviewloopMcpServer.js` 支持 `taskType: 'pr'`、`prContext` 冻结与旧 `mode: 'PR'` 隔离；单测与全量 `npm test` 通过。
- **Phase 2 (`pr-bot-and-triggers`)**：可信 Bot session 解析、`liveHeadSha` 校验、两阶段幂等 `@gemini review` 账本（<=3）、两轮共享边界 `HUMAN_REQUIRED` 升级；单测与并发/崩溃测试通过。
- **Phase 3 (`pr-watcher-and-wake`)**：零 LLM `prWatcher.js`、Agent 唤醒适配器（及显式降级）、`bin/reviewloop.js` CLI 子命令；Watcher/重启/零模型调用测试通过。
- **Phase 4 (`pr-e2e-verification`)**：全量 `npm test`、`npm run doctor` 及真实 PR Fix + Dismiss 端到端实证（或诚实标记外部阻塞）。

### 停止条件
- 任一阶段出现 `HUMAN_REQUIRED`、外部权限/凭据缺口或无法核实的外部依赖阻塞时立即停止并报告。
- 本地 Code `PASS` 后停止，等待用户明确授权 `commit` / `push` / 真实 PR E2E 测试。
