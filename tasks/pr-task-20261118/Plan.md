# Plan — ReviewLoop PR Task：自动处理 PR Bot 审查问题

任务：RL-PR-TASK-20261118
合同版本：Plan v1.0
阶段：Plan（待用户明确说 Design）
目标仓库：Jiaze-Li/reviewloop
代码基线：dd8d7d8af9912a5ccb11717e20e55abdbd2cd57a
工程规范 policy_sha：7f01e5a3ff53ed13ba763d684a098c0989425ec4
依赖：Jiaze-Li/pr-bot 可信版本 523eb01c4b6eec36ef9243e2c16a50db00519569，Verified Dismiss PR #94 已合并
说明：pr-bot 的真实 Dismiss 端到端验收仍缺实证，不得视为已通过

## 1. 真实问题及目标

用户想直接对本地 coding Worker 说“PR #xxx 报了问题，你去解决一下”。Worker 应读取该 PR 的最新可信 Bot findings（含真实阻塞的 P1/P2/P3）、结合实际代码和原任务合同，自己判断修复还是提交证据反驳，完成授权范围内的修改、测试、commit、push 和 PR 评论，而不要求用户反复把 Bot 评论复制给 Worker。

随后 ReviewLoop 应让 Worker 在 PR Bot 运行期间停止消耗 LLM Token，在可信的新结果出现时恢复处理，最终向用户报告 READY 或需要人工介入的原因。用户无需保持一个 LLM 对话连续等待、也无需手动扮演消息中继。PR Bot 始终是 PR 独立审查的唯一权威。

用户的明确上限：**ReviewLoop 在同一个 PR Task 内，主动发送的 @gemini review 评论最多 3 条。** 这不是“修复最多 3 次”，不是 PR Bot 的 verification rounds，也不限制 PR Bot 自身自动执行的最终 audit / 续跑。Dismiss 不消耗这 3 次额度，但必须遵守 pr-bot 独立验证及其内部预算。

## 2. 使用者与失败代价

主要使用者是维护 GitHub PR 的本地 Claude Code / Codex / 其他 Worker 的使用者。误操作可能导致修改错误分支、覆盖其他人的提交、重复付费审查、错误地把旧 READY 当当前 READY、反复执行同一修复、触发权限越界或在无人看守时无限循环。

严格优先级：真实性与用户明确授权 > 自动化顺畅；失败应可恢复、可解释，不得伪造 PASS/READY。

## 3. 已确认的产品规则与硬性边界

1. 新增 PR 类任务入口（用户提议名称 taskType: pr），用于“PR 问题修复编排”，而不是复活历史上已退役的 ReviewLoop PR Reviewer。设计阶段核查与旧 mode=PR 持久化数据的兼容与隔离；不得将旧 PR 会话冒充新的任务。
2. Worker 负责分析与改代码，ReviewLoop 负责绑定合同、任务状态、轮次上限、等待/恢复、安全停机；pr-bot 负责 GitHub findings、独立 Dismiss 裁决、最终审查和 READY；CI 负责构建与测试。只有一个 PR 审查权威。
3. PR Task 必须绑定确切仓库身份、PR number、当前 PR HEAD、目标/源分支，以及原任务标识、已冻结 Plan / Design / Work Contract / policy_sha（存在时）。与已经完成的本地 Code loop 应保持可追溯关系，不通过新 loop 清空原任务的预算、证据或 HUMAN_REQUIRED；旧任务缺历史 policy_sha 时标为未知，不编造。
4. 在读取 Bot 结论后，核实消息确属配置中的 GitHub App，找到最新可信 Independent Review Session，读取其中的 finding ID、严重程度、状态、lastReviewedHead，并与实时 PR HEAD 比较；过期、缺失、无法解析、PR 已关闭、会话冲突或未知状态均不能当作 READY。
5. Worker 应集中读取所有当前阻塞项，核对真实失败路径并决定处理。真实 Bug：修复、项目验证、按授权 commit/push。误报：用现有 @gemini dismiss F001（附 Reason 与 Evidence）申请 pr-bot 独立验证，不自行 resolve，也不使用人工 override；被拒绝时继续处理，INCONCLUSIVE 不视为解决。普通未验证 P3 不因级别低而自动忽略；被 pr-bot 降级为非阻塞的 P3 依其正式结果处理。
6. 对完成的授权修复，ReviewLoop 可以由 Worker 在 PR 评论区主动发布 @gemini review 触发后续审查；每个 PR Task **最多 3 条实际发表成功的独立触发评论**，必须在持久化状态中记录 GitHub comment ID 和对应触发时 PR HEAD。失败重试不得重复发送；未发表成功的请求不得冒充已发表。重复 webhook、自动续跑和 Bot 内部 audit 均不新增触发计数。发送前需先判断当前会话状态，避免在未变化的 REWORK HEAD 上重复发布无效评论。
7. pr-bot 自身 MAX_VERIFICATION_ROUNDS（现行 2）、会话、provider quota、预算、HUMAN_REQUIRED、审计规则仍生效；ReviewLoop 的三次评论上限不放宽它们，也不能靠 reset/override/force-push/新会话绕过它们。
8. 等待 Bot 时 **不运行 Worker LLM 推理，不持续占用对话轮次或模型调用**。允许轻量、限频的非 LLM 事件/状态检查以避免遗漏，但不能把阻塞的工具长轮询伪装成自动唤醒。Bot 更新结果后，应在已支持的本地 Agent 环境内受控唤醒/恢复 Worker，携带冻结合同、PR 和当前可信状态；重启/断线后不能丢任务，也不能重复发布/重复修复。
9. 现有 ReviewLoop 的 LOCAL code/design、ReviewLoop Worker Policy、安装方式及历史冻结 loop 必须保持正常行为，避免为了 PR Task 把现有 ReviewLoop 改造成另一套 GitHub Reviewer。若自动唤醒需要新的本地驻留组件、额外 GitHub 权限或服务，Design 必须明确边界与部署/授权前提；不得未经许可新增公开 webhook、持久凭据或跨机器执行服务。
10. 代码修改、commit、push、发布 PR 评论、创建 PR、merge、部署、破坏性操作、GitHub 权限/凭据变更分别受用户实际授权约束。用户提出“处理 PR”不自动授予 merge/force-push/修改权限。未获授权时保留任务和建议，报告等待授权。
11. **HUMAN_REQUIRED 必须停。** 同一共享设计或事务/权威边界连续两轮修复引入新的系统性阻塞时也停止局部补丁并要求只读根因审计；不得隐藏此状态或通过开启新 task 绕过。
12. PR 当前 HEAD 上 pr-bot READY 是“PR 代码审查完成”，不是 CI 全绿、Design/Code 本地 PASS、允许 merge 或真实功能验收通过。只报告各自证据，不自动 merge。

## 4. 不做什么

- 不在 ReviewLoop 内重新实现 pr-bot 的独立模型审查、P3 分类、Dismiss 判断、Thread Resolve、final audit 或远端会话存储。
- 不修改 pr-bot 现有两轮 verification / review policy；不做第二个独立 review bot。
- 不自动 merge、force-push、reset review、override review、修改仓库权限、泄露 GitHub 或模型凭据。
- 不让 LLM 空转等待、不以反复 @gemini review 评论代替修复、不新建默认长期运行的付费模型守护进程。
- 不要求用户手工来回搬运 findings、恢复材料或逐轮审查结论；不凭空声称本地 Agent 支持自动唤醒。
- 不把 ReviewLoop PR Task 的运行轮次改成“最多 3 次修复”或“pr-bot 最多 3 次 verification”。只对 ReviewLoop 主动发布 @gemini review 做独立计数。

## 5. 可观察验收标准

**AC-01 一句话启动。** 在有访问权限的真实本地工作区，用户指定 repo/PR 后，Worker 能在未手工复制 finding 的情况下读取当前可信 review session、源代码和适用合同；并能说明要修复什么、属于哪个 HEAD/分支。

**AC-02 修复分支。** 有真实缺陷时，Worker 仅修改正确 repo/PR HEAD 对应的授权分支，运行适用检查；在分别获得 commit、push、评论授权时正确提交并触发 pr-bot。未授权、PR 关闭、HEAD 被其他人更新或工作区不一致时阻止写入并报告。

**AC-03 Dismiss 分支。** 对无须修改代码的问题，Worker 用 pr-bot 已有 verified-dismiss 命令附证据请求独立判断；DISMISSED 才算该项已解决；REJECTED 保持 OPEN 并让 Worker 重新处理；INCONCLUSIVE、外部事实无法核验、模型不可用时按 pr-bot 正式状态等待或停机。不得以人工 override 冒充独立验证。

**AC-04 三条上限。** 在一个持久 PR Task 内实际发布的 @gemini review 最多 3 条，并有 comment ID、HEAD、发布结果可追踪。机器人自行重试/audit/续跑、用户自己评论、dismiss、事件重送不计入上限；崩溃恢复不得重复发布同一意图。上限耗尽且未 READY 时停止并向用户报告。

**AC-05 低成本等待与自动恢复。** 发起审查后 Worker LLM 调用停止；不在后台持续让模型查询 GitHub。受控 pr-bot 会话更新后，支持的本地 Agent 能被自动唤醒继续原任务，包含必要上下文而无需用户手动转译。断网、进程/机器重启、漏事件有可靠的无模型恢复路径；如果目标 Agent 无法安全自动唤醒，应明确标记不可用，不得宣称该 AC 已通过。

**AC-06 可信完成状态。** pr-bot 最新可信 session 的 READY 必须绑定当前实时 PR HEAD；REWORK 则保留 open finding 并继续，AUDIT_PENDING / PARTIAL / REVIEW_IN_PROGRESS 则继续等待，HUMAN_REQUIRED 必须停止。审查 READY 与 CI、授权合并、外部验收分别报告。

**AC-07 身份、并发与兼容。** 模拟并真实验证 stale HEAD、rebase、force-push、用户并行 push、重复 webhook、改写评论、同 PR 多 worker、错误仓库/worktree、历史旧 PR mode 数据、持久化重启等情形；任务不能错误读取结论、重置预算或覆盖他人修改。原有 code/design 路径与已冻结的 loop 行为回归通过。

**AC-08 控制与可见性。** 用户能看到当前 PR、最后确认的 HEAD、待解决 finding、已发送的 @gemini review 次数（0-3）、最后一次 Bot 状态、Worker 是否运行/等待/停止、剩余权限和停止理由；不把未运行测试或模拟结果记为 PASS。

**AC-09 部署与真实端到端。** 在已连接且支持自动恢复的至少一种真实 Worker 运行环境完成带证据的 Fix→push→@gemini review→REWORK→再次修复/READY；Dismiss→Bot 实际模型验证→接受/拒绝→Worker 后续处理；审查等待期间验证没有 Worker 模型空转；真实触发数与持久化计数相符。同时补齐 pr-bot #94 尚未证实的线上 Dismiss E2E。若 pr-bot 外部依赖不可用，诚实标记集成未通过，不靠 mock 或评论声明替代。

## 6. 已核实事实及未知前提

**已核实源码事实（2026-11-18，只读）：**

- reviewloop 的 `src/reviewloop/objective.js` 只有 `code` / `design`，旧 `PR` mode 被显式拒绝。持久化与旧状态兼容需独立设计，不允许把退役 PR session 强行复活。
- reviewloop 的 `docs/DECISIONS.md` D1/D11/D37 表明 Worker 自己执行代码、ReviewLoop 目前不会唤醒已退出的 Worker、GitHub PR 审查归 pr-bot；当前 PR Task 是**新增编排职责**而非旧 Reviewer 回归。
- reviewloop 已支持持久 loop 状态、跨会话 resume、Worker 侧安装和 MCP；`agent-policy/COMMON.md` 当前为 v15，并有 PR handoff/HEAD 一致性要求。
- `Jiaze-Li/pr-bot` PR #94 已合并入 main `523eb01c...`，新增单 finding 独立模型裁决、拒绝说明、预算/重送约束；相关 CI 和 PR Bot READY 已在 PR #94 上核实；其真实线上 Dismiss E2E 尚无可信完成证据。
- pr-bot 的普通 push 不自动开始新模型 review；`@gemini review` 是现行触发之一。pr-bot 内部 verification 次数是独立预算（当前上限 2），与本 Plan 的最多 3 条 ReviewLoop 主动评论不同。

**未知/需要 Design 核实：** 本地 Claude Code 等 Agent 如何被可靠、最小权限地唤醒/继续同一个任务；是否需要常驻本地进程及其安全退出/重启机制；GitHub Auth 与 App 事件的访问边界；如何将原冻结 code loop 合同、PR Task 新持久状态和评论计数安全关联；大量/无原 Thread 的 finding 如何处理；真实环境是否允许自动启动 Worker。未知不能被默认成“已经验证”。

## 7. 用户已确认与授权记录

已确认：唯一 PR Reviewer 为 pr-bot；Worker 自己修复/测试并在授权范围内 commit、push、评论；误报使用现成 verified dismiss；等待不烧 LLM Token；收到 pr-bot 的最新结果后自动恢复；最多 3 次 ReviewLoop 主动 @gemini review；HUMAN_REQUIRED 停机；READY 需精确 HEAD 匹配；不自动 merge。

本任务各操作授权状态：
- 只读分析、编写完整 Plan：已授权；
- 新建 Plan 任务分支、提交/推送 Plan、创建 Draft PR：已授权（仅 Plan 阶段）；
- 进入 Design、创建设计文件及运行其独立审查：等待用户明确说 Design；
- 进入 Code、修改 ReviewLoop 代码/测试、commit/push：等待用户明确说 Code 及对应具体授权；
- merge、部署/安装到用户本机、执行真实破坏性验证、变更权限/凭据/公开 webhook：未授权；
- 将来 PR Task 操作别的目标仓库：必须按该次任务单独核实权限，不由本 Plan 授权。

Design PASS 不自动授权 Code。PR Bot 的审核结果也不自动授权 merge。

## 8. 交付与阶段停止点

同一个 ReviewLoop Draft PR 记录正式 Plan、经独立 ReviewLoop 通过的 Design（包含 Options、Assumptions 和末尾 Work Contract），以及后续 Code/验证证据。当前阶段只交付本完整 Plan（Brief 只用于 PR 描述）；Plan 结束后停止，等待 Design；Design PASS 后停止，等待 Code。必要新的产品决定集中交用户确认，不在 Design 中暗改本 Plan 验收标准。

阶段报告保留 `policy_sha`、Plan version、Design `designSha256`（届时存在）、确切仓库/PR/head、现行最可信 pr-bot 状态、已验证/未验证的证据与需用户操作的下一步。
