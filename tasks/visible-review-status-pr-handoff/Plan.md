# Plan：ReviewLoop 审查状态可见性与 PR 交接可靠性

- **任务**：RL-STATUS-HANDOFF-01
- **Plan 版本**：v1.0（2026-11-17）
- **阶段**：Plan（尚未进入 Design / Code）
- **仓库**：`Jiaze-Li/reviewloop`
- **任务起点**：`main@d0abf39c74f92c309c3f118756929082655b1b46`
- **工程规范 `policy_sha`**：`7f01e5a3ff53ed13ba763d684a098c0989425ec4`（`Jiaze-Li/personal-skills`）
- **规范**：`engineering-lead/skill.md` 与 `engineering-workflow/README.md`，均按上述 `policy_sha` 读取。后续阶段沿用此 SHA。

## 1. 要解决的真实问题

用户使用 Worker（如 Claude）执行 ReviewLoop 审查时，审查可能已经真实执行，但 `taskType`、轮次和结果仅出现在被客户端折叠的工具输出中，普通聊天界面没有显示。用户因此无法直接确认当前审查类型、轮次与结果。推送代码后，Worker 也可能忘记同步更新 PR 描述，使 PR 仍显示旧阶段、旧验收状态或旧风险。

**目标**：使用户能够在正常对话中看到每轮实际审查状态，并在任务结束时核对可追溯的审查历史；代码推送后的 PR 描述必须与最新实际交接状态一致，不能把过期描述当成已完成交接。此任务修复的是「状态展示与交接闭环」，不是重新运行或加强独立审查算法。

## 2. 使用者与失败代价

- **直接使用者**：使用 Claude Desktop、Claude Code 或其他受支持 Worker 客户端的用户。
- **后续使用者**：依据 Draft PR、审查记录和阶段结论继续 Design / Code / 验收的人。
- **失败代价**：用户无法辨别审查是否发生或处于第几轮；PR 交接信息过时，导致错误验收、重复工作或误判下一步是否可执行。
- **影响范围**：本地 ReviewLoop 的状态展示/追溯、Worker 推送后的 PR 交接；不扩大为 PR bot 代码审查改造。

## 3. 已核实的基线与待解决缺口

以下为本任务起点的只读静态核查，不代表在实际用户客户端做过端到端测试：

1. `src/reviewloop/statusLine.js` 已格式化启动/审查状态行，能标出 `design` / `code` 和轮次/结果。
2. `src/mcp/reviewloopMcpServer.js` 已在 MCP 工具结果中提供 `statusLine`，并把它置于文本结果第一块。
3. `tests/mcpStatusVisibility.test.js` 目前证明客户端收到了第一块文本，**没有证明用户无需展开工具调用即可在聊天界面看到状态**。
4. `agent-policy/COMMON.md`（Contract v14）已经要求 Worker 每轮原样转达 `statusLine`，以及推送后更新 PR 描述。仅靠 Worker 记住规则，实际仍可能漏报。
5. 根目录已有上一任务的 `Plan.md`，本任务使用独立的任务目录保存完整 Plan，避免覆盖历史合同。

因此不能把「MCP 返回成功」写成「用户 UI 展示已验证」，也不能把某个 Worker 的自述当成历史审查的独立证据。

## 4. 硬性边界

1. **少改动、少机制**：优先复用已有状态行、审查记录、Worker Policy 与 PR 交接；不为展示状态新建一套审查系统、后台服务或额外模型角色。
2. **真实、可核对**：状态与轮次来自实际 ReviewLoop 返回或已有可信持久记录，不由 Worker 猜测、补写或虚构。区分 Gate 修复与真正的独立 Reviewer 轮次。
3. **用户可见**：目标是普通对话中的可读状态，而不只是隐藏/折叠的 MCP 原始输出；如某宿主无法保证展示，应清楚界定支持范围并报告限制，不能宣称所有客户端 100% 可见。
4. **职责不变**：ReviewLoop 仍负责本地审查；Worker 负责对话展示与 PR 交接；PR bot/CI 保持各自权威，不因展示缺失改写审查结论。
5. **不增加审查成本**：不得为了「补展示」额外触发独立 Reviewer / Supervisor、重置预算或新建 loop；保留现有安全停机条件和审查状态机。
6. **阶段与授权**：Plan → 停 → 用户明确说「Design」→ 设计及独立审查 → 停 → 用户明确说「Code」→ 实施与独立审查。不同操作分别授权。

## 5. 不做什么

- 不修改审查算法、P1/P2/P3 阻塞策略、Token Sentinel、花费/预算、历史 loop 的冻结合同。
- 不将 ReviewLoop 改成 GitHub PR 审查机器人，不让 ReviewLoop 为更新 PR 描述直接持有新的 GitHub 写权限。
- 不为所有 Claude / Codex / Gemini 客户端开发统一图形界面，也不承诺无法控制的宿主必然自动展开工具输出。
- 不用 PR 描述是否更新替代本地 `PASS` 或 PR bot `READY`；交接完整性与审查结果必须分别表达。
- 本次 Plan 提交不修改程序、测试、正式数据或现有 PR；不开始设计和实现。

## 6. 可观察验收条件

**AC1 — 每轮状态可见。** 在 Design 明确的目标 Worker 客户端上，实际调用 `reviewloop_begin`、`reviewloop_review` 后，用户无需打开折叠的工具详情即可直接看到对应状态行，包含任务类型、启动/轮次、实际结果；状态文本与工具返回的 `statusLine` 一致。至少覆盖 `code` 与 `design` 的正常路径和连续 `REWORK → PASS` 场景。

**AC2 — 异常状态不被掩盖。** `HUMAN_REQUIRED`、Gate 失败/无进展以及暂未完成的结果不得被展示为通过；如果宿主无法满足 AC1，必须说明哪个客户端、哪条路径未验证或不支持，不得用纯 MCP 返回测试冒充真实 UI 验证。

**AC3 — 结束时可核对。** 任务结束的交接信息应列出可从 ReviewLoop 真实状态核实的 `loopId`、`taskType`、审查轮次/已发生结果与最终状态，或提供可直接读取的准确引用；不允许仅凭 Worker 的自然语言回忆声称「三轮都跑了」。明确哪些历史信息已核实，哪些无法恢复。

**AC4 — PR 描述是最新交接。** 对已有权限且发生 push 的任务，交接完成前应核对同一 PR 的最新 HEAD 与描述顶部：做了什么、从 Brief 来的验收清单、实际完成的自动验证、未完成项和风险/偏离；Brief 全文只放链接。Plan / Design / Code 阶段不得误标为已经完成下一阶段。

**AC5 — 漏更新可发现。** 对「已推送但 PR 描述仍停留在 Plan 阶段」或「描述对应旧 HEAD」的回归用例，流程应明确报告交接未完成，不能静默返回「全部结束」；修复元数据不应额外调用 Reviewer，也不应修改已有审查 `PASS`。

**AC6 — 回归安全。** 既有 `code` / `design` 审查、两工具 MCP 合同、预算与持久化能力保持兼容；对状态传输、用户展示边界、PR 交接遗漏分别有与其保证范围相符的验证。运行相关自动化测试并记录实际结果，不宣称没运行过的测试已通过。

**AC7 — 真实宿主验收。** 至少在一款用户实际采用、且 Design 阶段明确选定的 Worker 客户端做真实多轮 UI 验收（优先核查 Claude Desktop / Claude Code）。保留可复核的测试步骤与观察结果。其他客户端如未实测，应明确标注为未验证，而不是推导出「通用保证」。

## 7. 已确认决定与未知前提

**已确认**
- 优先做小型可靠性修复，不重构 ReviewLoop 审查引擎，不增加复杂新机制。
- 用户希望每轮状态在正常对话可见、最终能核对真实审查、push 后 PR 描述不过期。
- 保持本地审查结论与用户界面/PR 交接的独立性。
- 本轮仅授权创建 Draft PR 并提交完整 Plan。

**待 Design 核实，不在 Plan 里擅自假定**
- 用户实际运行 ReviewLoop 的目标宿主、版本及其 UI 是否支持可靠展示；不同客户端是否需要不同程度的适配。
- 现有持久化资料能否完整、准确地重建每轮结果；不够时应说明缺口，不虚构历史。
- 在不赋予 ReviewLoop 新 GitHub 写权限、不制造新权威来源的前提下，怎样可靠发现 PR 描述落后于最新 push。
- 在上述边界内是否能严格实现 AC1/AC7；如宿主限制使硬验收无法满足，必须向用户呈交现实限制和取舍，不能默默降级。

## 8. 授权与阶段停点

| 操作 | 本次授权 |
|---|---|
| 仅新建任务分支并写入本 Plan | **允许** |
| 为本 Plan 创建 commit / push | **允许** |
| 创建同一任务的 Draft PR | **允许** |
| 修改 ReviewLoop 程序或测试 | **未授权** |
| Design 编写/评审 | **等待用户明确指示「Design」**；具体写入授权另核对 |
| Code 实施、测试改动、实施提交与 push | **未授权**；等待「Code」及对应明确写入授权 |
| PR merge、发布部署、破坏性操作、权限/凭据变更 | **未授权** |

本 Plan 是后续 Design 的完整需求合同；PR 顶部 Brief 只是摘要。Design 负责比较 Options、记录 Assumptions 与验证实现可行性，审查通过后依规范停下。若验收要求或授权范围需实质改变，先回到用户确认，不以技术困难静默修改 Plan。

## 9. 交接引用

- Engineering method：`Jiaze-Li/personal-skills@7f01e5a3ff53ed13ba763d684a098c0989425ec4`
- ReviewLoop Worker Contract：以实际执行环境安装版本为准；本 Plan 核查基线为 `Jiaze-Li/reviewloop@d0abf39c74f92c309c3f118756929082655b1b46` 的 `agent-policy/COMMON.md`。
- **下一步**：用户明确说「Design」后，本地 Agent 在同一任务/PR 上读取本完整 Plan 和上述冻结 Engineering Skill，进行 Design + ReviewLoop 独立审查，完成后停止；本 Plan 不构成自动开工授权。
