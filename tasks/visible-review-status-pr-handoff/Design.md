# Design：审查状态可见性与 PR 交接可靠性（RL-STATUS-HANDOFF-01）

- 版本 v1.0（2026-11-17）｜`policy_sha=7f01e5a3ff53ed13ba763d684a098c0989425ec4`｜Plan v1.0｜仓库基线 `main@d0abf39`（PR 分支 `2ebf6c2`）
- 目标：每轮审查状态能在对话里被看到；任务结束能核对真实审查历史；push 后 PR 描述不再停在旧状态。
- 非目标：不改审查算法/预算/PR bot；不给 ReviewLoop 新增 GitHub 写权限；不新增第三个 MCP 工具；不为各客户端做界面。

## 已核实事实（文件:行 + 摘录）

1. `src/reviewloop/statusLine.js:4-10`：`beginStatusLine` 返回 `[ReviewLoop | ${taskType} | 启动] loopId=…`；`reviewStatusLine` 返回 `… | 第 ${r} 轮 → ${status}] loopId=…`。纯格式化，无模型调用。
2. `src/mcp/reviewloopMcpServer.js:29-33`：`toolResultContent` 在有 `statusLine` 时返回 `[{type:'text',text:result.statusLine}, json]`，即状态行是第一个文本块。`:177` begin 附加状态行；`:264` review 使用同一函数。工具只注册两个（`:88`、`:190`）。
3. `src/reviewloop/controller.js:438` 以 `withStatusLine(...)` 包住每次 review；`:467-477` 注释写明"Best effort … must never change or fail the review result"。
4. `src/reviewloop/state.js:116-132`：`recordTransition` 向 `loopState.history` 追加 `{from,to,reason,round,at}`；`:110` 初始化 `history: []`。真实样本（本机 `~/.reviewloop/rl-20260906…/workflow.json`）里历史为 READY_FOR_WORK→REVIEWING(round 0)→HUMAN_REQUIRED(1)→REVIEWING(1)→PASS(2)。即**每轮结果已被持久化**，只是没有人读得出来的汇总。
5. `tests/mcpStatusVisibility.test.js:11-24` 只断言 `begin.content[0].text`、`review.content[0].text` 匹配状态行正则，即证明"MCP 第一块是状态行"，**不证明宿主 UI 展示**。
6. `agent-policy/COMMON.md:2` `Contract version: 14`；`:30` "Show the user each result's `statusLine` verbatim"；`:42-44` 推送后 PR 描述要有 built / 验收清单 / verified / 风险。现状只靠 Worker 自觉，没有任何检查。

## Options

- **A 只改 Worker 规则文字。** 最省，但规则 v14 已经有同样要求，漏报仍发生；否决。
- **B（采用）小型确定性补强：** ① review 结果新增 `reviewRecord`（由持久化 `history` 生成的累计一行/多行文本）；② 新增只读检查脚本核对 PR 描述是否与最新 HEAD 一致；③ 规则升级 v15，要求 Worker 把状态行与记录转述给用户，并在 push 后运行检查。复用既有状态行、持久化与 `gh`，不新建机制。
- **C 新增第三个 MCP 工具（status/history）或让 ReviewLoop 直接写 PR。** 破坏两工具合同、扩大 GitHub 写权限；否决。
- **D 宿主层强制展开工具输出（Hook/客户端设置）。** 属协议元改动且不可跨宿主；本设计不做，只在限制中说明。

## Assumptions

- 用户日常的 Worker 宿主是 **Claude Code**（Plan 把 Desktop/Code 列为优先），验收只在它上做；其他宿主一律标"未验证"。
- 宿主是否展开工具输出不受 ReviewLoop 控制。最可靠的可见路径是 **Worker 自己把状态行写进对话**；本设计让它更难漏、更容易核对，但不能保证 100%。
- Worker 有 `gh` 读 PR 的权限；检查脚本只读，描述的修改仍由 Worker 用既有权限完成。

## 设计

**1. `reviewRecord`（AC1/AC3）。** 新增纯函数，输入已加载的 `loopState`（含 `history`、`objective.taskType`），输出：
`[ReviewLoop 记录 | design | loopId=… | 第1轮 REWORK → 第2轮 PASS | 终态 PASS]`，只由 `history` 中 `to ∈ {REWORK, PASS, PHASE 通过, HUMAN_REQUIRED, FAILED, STOPPED}` 的条目及其 `round` 生成。`withStatusLine` 之外的同一"尽力而为"位置附加到每次 review 结果，作为独立字段 `reviewRecord` 和第二个文本块（状态行保持第一块、格式不变，旧客户端/旧测试不受影响）。history 不完整或读取失败时输出 `记录不完整`（不补写、不当成 PASS）；Gate 失败的修复循环若不在 history 中，则在记录里注明"Gate 修复循环未逐条列出"。它**只读、不调用模型、不改变结果与预算**。
**2. PR 交接检查（AC4/AC5）。** 新增 `scripts/check-pr-handoff.js`：`node scripts/check-pr-handoff.js <PR号> [--stage plan|design|code]`，只用 `gh pr view --json headRefOid,body` 读取。PR 描述顶部需带标记 `<!-- reviewloop-handoff head=<40位SHA> stage=<…> loop=<loopId> -->` 且含四块文字（做了什么 / 验收清单 / 已验证 / 风险）。以下任一情况退出码非 0 并输出"交接未完成：原因"：无标记；标记 SHA ≠ PR 当前 HEAD；`--stage` 与标记不符；缺四块之一。通过时只输出"交接核对通过（只代表描述与 HEAD 一致，不代表审查 PASS / bot READY）"。脚本不写 GitHub、不调 Reviewer。
**3. 规则 v15（`agent-policy/COMMON.md`）。** Contract version 14→15；三处小改：每轮 Worker 在自己的回复里原样写出状态行；终态（PASS/HUMAN_REQUIRED 等）回复附上 `reviewRecord`；push 后运行检查脚本，非 0 视为"交接未完成"，更新描述后重跑，再宣布结束。

## 不变量

- I1 状态行首块与格式不变；`reviewRecord` 只增不改。
- I2 `reviewRecord` 与检查脚本不触发 Reviewer/Supervisor、不改 loop 状态、不改预算。
- I3 记录只来自持久化 `history`；缺失就显示"记录不完整"，不由 Worker 补写。
- I4 检查通过 ≠ 审查通过；二者分开表达。
- I5 两工具 MCP 合同、现有测试保持通过。

## 声明 → 失效方式 → 证据

- 记录忠实 → history 缺项或字段变化 → 单测：REWORK→REWORK→PASS、HUMAN_REQUIRED→重审→PASS（对应真实样本）、history 缺失/损坏输出"记录不完整"，且结果其余字段与预算不变。
- 不被误读为通过 → HUMAN_REQUIRED/FAILED 被显示成 PASS → 单测断言终态文字。
- 旧客户端兼容 → 内容块顺序变化 → 既有 `mcpStatusVisibility` 测试原样通过 + 新测试断言第二块。
- PR 漏更新可发现 → 描述停在 Plan / 旧 HEAD → 用假 `gh` 输出的单测：无标记、HEAD 不符、stage 不符、缺块均非 0；正常样本为 0。
- 宿主真实展示 → **只能人工验证**：在 Claude Code 里实际跑一次 design 与一次 code 的多轮（含 REWORK→PASS），记录每轮对话里用户看到的文字；通过标准是对话正文（非展开的工具详情）出现状态行与终态记录。结果如实写入 PR，其他宿主标"未验证"。

## 最小实施顺序

1. `reviewRecord` 纯函数 + 单测；2. 接入 review 结果与文本块 + 兼容测试；3. 检查脚本 + 单测；4. 规则 v15 与 `npm test` / `npm run doctor`；5. Claude Code 人工验收并记录。回滚：每步都是增量文件/字段，撤销对应提交即可，无数据迁移。

## 需用户确认

- **取舍（产品层）**：宿主是否展开工具输出无法由 ReviewLoop 强制。采用本设计意味着"能不能每轮看到"最终取决于 Worker 是否把状态行写进对话，ReviewLoop 保证每次都给出可核对的记录、PR 漏更新会被检查报错。若你要求"硬强制"，需要另做宿主级设置（协议元改动），不在本任务内。
- 授权草案：修改程序/测试（Code 阶段需你说"Code"）；commit/push 到本 PR 分支；PR 描述更新。merge、部署、权限变更：不授权。

## Work Contract（自包含）

**结果：** (a) 每次 `reviewloop_review` 结果带 `reviewRecord`，并作为第二个文本块；终态不被误标为 PASS。(b) `scripts/check-pr-handoff.js` 能对四类漏更新报错。(c) `COMMON.md` 升到 v15 并写入三处要求。
**不变量：** I1–I5。不改审查算法、预算、Sentinel、历史 loop 合同；不新增 MCP 工具；不给 ReviewLoop 新增 GitHub 写权限。
**全局 AC：** 对应 Plan AC1–AC7；其中 AC1/AC7 以 Claude Code 人工验收为准，其余宿主标"未验证"；AC2 由终态文字单测与限制说明覆盖。
**验证与证据：** 新增单测与既有测试全部通过（附 `npm test`、`npm run doctor` 实际输出）；脚本四类失败用例；人工验收步骤与观察逐轮记录；未运行的检查不得声称通过。
**停止条件：** history 无法重建每轮结果、或 `gh` 无法读取 PR 时，输出"无法核实"并报告，不补写；验收标准需实质改变时回到用户；任一环节需要新增 GitHub 写权限则停下。
