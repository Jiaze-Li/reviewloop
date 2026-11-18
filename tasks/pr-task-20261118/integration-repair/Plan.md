# Plan — ReviewLoop PR Task 生产集成修复与真实闭环验收

- **Task:** `RL-PR-TASK-20261118-INTEGRATION-REPAIR-01`
- **类型：** 原 `RL-PR-TASK-20261118` 的验收缺口修复；不是新的 PR Reviewer 产品或原任务的替代合同
- **版本：** Integration Repair Plan v1.0（阶段：Plan，尚未进入 Design/Code）
- **修改目标：** `Jiaze-Li/reviewloop`；`Jiaze-Li/pr-bot` 为既有只读集成依赖
- **本次源代码基线：** `3caa01407f62baa4e6b9c455bfcad455c6717650`
- **冻结工程政策：** `policy_sha = 7f01e5a3ff53ed13ba763d684a098c0989425ec4`（与原任务 #51 一致）
- **原始任务：** [ReviewLoop PR #51](https://github.com/Jiaze-Li/reviewloop/pull/51)，原 [Plan v1.0](https://github.com/Jiaze-Li/reviewloop/blob/cf955a4b43449181e632c6ff4553b1f0338678c6/tasks/pr-task-20261118/Plan.md) 和 [Design v1.0 / Work Contract](https://github.com/Jiaze-Li/reviewloop/blob/cf955a4b43449181e632c6ff4553b1f0338678c6/tasks/pr-task-20261118/Design.md)
- **原任务 Code loop：** `rl-20261118045441-e8d00340`（#51 报告已 PASS 且合并；本任务不得改写、重新打开或重置其证据和预算）
- **pr-bot 依赖：** [PR #94](https://github.com/Jiaze-Li/pr-bot/pull/94) 已合并到 `523eb01c4b6eec36ef9243e2c16a50db00519569`；Verified Dismiss 的真实线上 E2E 尚未获得 PASS 证据

## 1. 真实问题、目标和影响

PR #51 已实现 `taskType: pr`、本地 Watcher、PR 评论触发账本与 Claude/Codex 唤醒器，已合并且有成功 CI 和 Bot READY。但原 Plan 的 AC-09（真实 Fix/Dismiss 闭环）未完成。对真实接口的只读核查还发现：ReviewLoop 使用的 Bot 评论作者及状态格式与生产中的 pr-bot 不符；正常 Worker Push 后冻结的 HEAD 缺少受控推进路径；三次触发账本与 Worker 真正发评论的调用入口未贯通；Watcher 缺乏实际会话身份的建立和保持路径。

**本任务目标不是再堆一组 helper 或 mock 测试，而是在现有 ReviewLoop 架构中修正这些消费端接口与运行生命周期，使原任务承诺的自动 PR 修复与 Dismiss 闭环在真实受控环境可用，并有实测证据。**

用户是本地 Coding Agent/PR 的维护者。失败代价包括真实缺陷未处理却误报 PASS、Worker 推送后被错误冻结、超额或重复付费审查、Watcher 无法恢复 Agent、误操作错误仓库/分支或不当扩大授权。安全性和证据真实性优先于自动化覆盖率。

## 2. 原已批准合同不变的硬边界

1. 原 `Plan v1.0`、`Design v1.0` 的可观察验收和 Work Contract 继续约束当前修复；不以新 Plan 取消、降低或替换任何旧 AC（尤其 AC-01～AC-09）。
2. **修改归 ReviewLoop**。pr-bot 是 PR 的唯一审查权威：不在 ReviewLoop 重做模型审查、P3 判定、Dismiss 审核、Thread Resolve、Final Audit 或 READY 裁决。若 Design 证实 pr-bot 必须改协议，先以跨仓库阻塞报用户审批，不在本 PR 偷改 pr-bot。
3. 复用已经实现的 `taskType: pr`、`reviewloop_begin/review`、持久化/跨进程 lease、PR Trigger 账本、本地 Watcher/唤醒器；修正缺失的对接点，不另建一套 Loop、远端任务队列、HTTP webhook 或 Reviewer。
4. ReviewLoop **最多主动发表 3 条** `@gemini review` 评论/PR Task。是评论次数上限，不是修复轮数，也不是 pr-bot verification（当前 2 轮）或自动 Audit 次数；Dismiss 不计入，原有 `HUMAN_REQUIRED` 必须立即停止，不自动 reset/override。
5. 用户操作授权分开记录：`edit`、`commit`、`push`、`comment`、`autoWake`，且仅对明确指定的 repo/PR/分支有效；不能因“处理 PR”默认允许 merge、部署、force-push、扩权限/改凭据或破坏性动作。
6. 原 Code/Design 和旧 `mode=PR` 历史 loop 必须兼容。不能为了完成本任务重置原 `loopId` 的冻结合同、审查状态或用新 Task 隐藏已有 `HUMAN_REQUIRED`。
7. 无法确认外部事实、权限、Bot 会话或模型实际使用时，结果必须标 `NOT_VERIFIED` / `BLOCKED`，不得记录为 PASS/READY。

## 3. 已确认的集成缺口（事实与推断分开）

**I1 — pr-bot 正式审查会话无法被当前默认消费者正确识别（源码与真实证据已核实）。**
- `src/reviewloop/objective.js:146` 默认作者 `claude-review-bot[bot]`；真实 PR #51 的 Bot 作者为 `jiaze-claude-review-bot[bot]`。
- `src/reviewloop/prTaskEngine.js:58-160` 从特殊内联 JSON 和摘要正则解析 session；真实 [#51 Bot 会话](https://github.com/Jiaze-Li/reviewloop/pull/51#issuecomment-6969829315) 的权威内容位于 `<!-- jiaze-review-state:<base64url> -->`，可见部分为 `Status: **READY**`，没有该消费者期待的内联 JSON/明文 `lastReviewedHead`。现有 `tests/prTaskBotAndTriggers.test.js` 是另一种合成格式。**不得简单按可见的 READY 一词放行**，必须解析权威字段并核对真实 HEAD/审计条件。

**I2 — 正常授权 Push 后 HEAD 生命周期尚未贯通（静态实现缺口，待 E2E 复现）。**
- `prTask.boundHeadSha` 由初始 `prContext` 写入，`evaluatePrStatus` 将后续 PR HEAD 与之不同视作 `HEAD_DRIFT`；当前仓库未找到 Worker Push 成功后受控更新这个可变任务进度的生产入口。
- 必须区分“同一个 Worker 正常授权提交并推送”的受控推进与“别人 push/rebase/force-push”的外部漂移，后者不能静默接受。不得直接改写原冻结 `objective.prContext` 来掩盖差异。

**I3 — 触发账本与 Worker 发布评论的生产入口尚未贯通（静态实现缺口，待 E2E 复现）。**
- `src/reviewloop/prTaskEngine.js:321` 已有 `triggerGeminiReview`、PENDING/POSTED 与并发限额，但现有 MCP 只有 `reviewloop_begin`、`reviewloop_review`，CLI 只有 `reviewloop pr status|resume|stop`。未找到真正 Worker 发布 `@gemini review` 时必经该账本的调用路径。
- 修复必须确保正常使用路径真正执行 3 次上限、幂等/权限/HEAD 校验；不能把“helper 的单测 PASS”作为集成 PASS。对于 GitHub POST 结果未知、崩溃后的 PENDING/POSTED 必须保守对账，防止重复发帖。

**I4 — 自动唤醒缺少真实会话身份注入路径（静态实现缺口，待 E2E 复现）。**
- `src/reviewloop/prWakeAdapter.js` 仅在 `prTask.watcher.agentType` 和 `agentSessionId` 可用且 `autoWake` 授权时才能自动恢复；初始 `prContext`、`initialPrTaskState` 未建立或记录这两个值；测试则直接构造了假会话 ID 与模拟的 `spawn`。
- 必须在真实受支持的 Claude/Codex 环境安全建立、持久化和验证会话身份；不支持 AGY、无授权或不可恢复时明确 `MANUAL_REQUIRED`，不能宣称“已自动恢复”。

**I5 — Watcher 运行和安装可用性缺少真实证据（待实测）。**
- 现有 Watcher 以零模型轮询 GitHub，存在进程退出、网络错误、超时/重启场景；`npm test` 无法证明真实 CLI 会话可被拉起。需要在支持环境里验证恢复、失败退让、停止和安装生效，并避免错误操作其他 PID 或覆盖较新的状态。

以上“源码已核实”是静态事实；标记为 E2E 缺口的事项尚不能在没有真实运行证据时宣称已经在现场复现。

## 4. 不做什么

- 不改 pr-bot 的 review/dismiss/override 命令语法、模型预算、状态机或 GitHub App 名称；不再为本任务开 pr-bot PR。
- 不要求重做原 PR #51 已覆盖的全部实现和独立审查；仅对接口、贯通边界、受影响代码和回归做集中修复与完整复审。
- 不引入第三个 Worker 接口/额外守护服务作为默认前提；若 Design 发现必须扩大 API 或新增本地服务/权限，明确列为方案比较和需用户确认的决定。
- 不重写原任务的冻结 Plan、Design、Design PASS/hash、原 Code loop；不让 E2E 验证成为静默的自动合并/正式部署许可。
- 不依靠合成评论、mock CLI 或仅有 Actions 绿灯替代真实生产会话与端到端验证。

## 5. 可观察验收标准

**AC-01 真实 Bot 契约。** 用来自真实 `Jiaze-Li/pr-bot` 的 Bot 评论（保留正式 `jiaze-review-state`、实际 Bot 身份、状态与 finding 语义的可核查 fixture）做消费端测试。正确解析 READY/REWORK/AUDIT_PENDING/PARTIAL/HUMAN_REQUIRED、OPEN/UNCERTAIN、真实阻塞 P3/降级 P3；错误作者、伪造/畸形状态、旧 HEAD、冲突会话、缺少完整审计条件一律 fail closed。

**AC-02 HEAD 受控推进。** Worker 在授权分支完成真实修复、commit、push 后，PR Task 能安全绑定新的 HEAD 继续同一任务和 3 次评论账本；Push 前后核实实际 PR/branch/old/new SHA，其他人 push、rebase、force-push、关闭 PR 或无权限均不自动重绑定，必须报告。原冻结身份与历史证据不被改写。

**AC-03 有界评论入口。** Worker 实际发 `@gemini review` 必须走统一受控入口；1 次发布应生成可追溯的评论 ID、HEAD 和持久状态。多 Worker、并发、重复事件、崩溃/未知 POST 结果、同 HEAD 反复触发等条件下，总实际发布数始终 <= 3。Dismiss 不计次数，Bot 自动审查不计次数，不允许以裸评论绕开该任务授权和计数而宣称合规。

**AC-04 Worker 恢复入口。** 能以真实授权的 Agent 类型和会话身份恢复至少一种本地 CLI（Claude 或 Codex）的原任务，保持同一 loopId 与合同；Worker 在等待 Bot 时没有 LLM 空转。无权限、会话不可恢复、不支持平台时显式 MANUAL_REQUIRED，提供实际可执行恢复命令，绝不虚报 WOKEN。

**AC-05 状态与恢复安全。** Bot REWORK 恢复 Worker，当前 HEAD 的 READY 才结束；AUDIT_PENDING/PARTIAL/REVIEW_IN_PROGRESS 等待，HUMAN_REQUIRED 立即停止。Watcher 断网、查询临时故障、退出/系统重启、Stop 竞态及超时能保留可信状态和明确恢复出口，不能误杀无关进程、重复唤醒或重复评论。

**AC-06 原功能回归。** 本次修复不能破坏 ReviewLoop `code`/`design`、旧 `mode=PR` 的只读隔离、已合并的并发/lease/预算边界、当前 `MAX_REVIEW_TRIGGERS=3` 及原 `HUMAN_REQUIRED` 规则。完整 `npm test`、安装/doctor 和必要的独立审查结果应绑定确切 HEAD。

**AC-07 真实 Fix E2E。** 在有明确授权的测试 PR 上执行 Worker 修复 → commit/push → 经 ReviewLoop 受控触发 `@gemini review` → pr-bot 审查 REWORK/READY → Watcher 检测并按授权自动恢复或明确降级；核对 comment IDs、HEAD、Bot 原始会话、Worker 是否实际恢复、消耗及停止行为。不把人为直接发表评论算作受控链路 PASS。

**AC-08 真实 Dismiss E2E。** 同一测试安排覆盖 Worker `@gemini dismiss Fxxx` → pr-bot 真实独立模型验证 → 接受/拒绝/无法判断 → ReviewLoop 读取可信后续状态；记录原 Thread 回复/Resolve 或真实失败。为 pr-bot #94 补齐线上证据，但不修改 pr-bot 代码。若外部模型/权限不足，标清 BLOCKED/NOT_RUN。

**AC-09 可用性交接。** 给出可复制的安装/更新、启动 PR Task、查看状态、停止/恢复和授权边界操作示例；区分本地单测、GitHub CI、Bot READY、真实 E2E、自动唤醒和部署/安装完成状态。全合同未达成时不得宣告“已上线可用”。

## 6. 前提与依赖状态

- 已验证：#51 已合并，ReviewLoop 最新 `main` 含 PR Task；已有 Watcher/Trigger 等模块；原 PR 审查 READY、CI 通过。这不等于 AC-09 已通过。
- 已验证：pr-bot #94 的独立验证代码已合并；正式 Bot 评论采用现有 HTML 隐藏状态标记及特定 App 作者。
- 未验证：用户本机是否已安装最新 ReviewLoop、`gh auth`、Claude/Codex 实际会话恢复能力、GitHub App 线程回复权限、真实模型配额和受控测试 PR。
- 对权限不足、数据不符或基础设施故障，必须真实报告，不得假定可补救后直接继续。
- Design 必须明确最小复用线路、失败/重试/并发路径、真实生产者/消费者数据流与旧状态兼容，包含 Options、Assumptions，末尾交付唯一 Work Contract；经独立 ReviewLoop 设计审查后再等用户说 Code。

## 7. 授权边界与阶段停止点

| 操作 | 当前授权 |
| --- | --- |
| 核查公开仓库/PR 和制作此修复 Plan | 已授权 |
| 在 ReviewLoop 创建任务分支、提交/推送 Plan、建立 Draft PR | 已授权（仅文档） |
| 开始 Design，生成或修改 Design 并运行 ReviewLoop 独立 Design 审查 | 等用户明确说「Design」 |
| 开始 Code，修改生产代码/测试、commit/push | 等用户明确说「Code」及对应操作许可 |
| 在别的业务仓库创建测试 PR、修改/推送真实代码、发表评论/启动付费审查 | 单独授权；此文档不授权执行 |
| Merge、正式安装/部署到用户设备、改变权限/凭据、破坏性/force-push 操作 | 未授权 |

结束 Plan 后停止。设计通过后停止，不能自动开始 Code。最终合并由用户决定。原 #51 的未验收事项仍记为未完成；修复 PR 的通过不能替代原真实 E2E 义务。

## 8. 交付与后续工作

本 Draft PR 仅引入该目录中的完整 Plan；PR 描述仅放 Brief 与其精确链接。下一阶段在同一个 Draft PR 下由 Worker 按冻结 `policy_sha` 生成 Design，独立 ReviewLoop 审查（必须给出真实状态、loopId、`designSha256`）。Code 阶段使用被审查的完整 Work Contract，不借机重开旧 loop 或吞掉既有预算。

最终报告需列出：源原任务合同版本、实际评审基线、功能与真实 E2E 的 AC 对照、生产 Bot 状态/已审 HEAD、真实评论 ID、Worker 运行/恢复证据、尚未满足的部署或权限前提以及用户下一步操作。
