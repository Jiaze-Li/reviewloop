# Plan：设计审查改为"两方独立出方案，裁判裁决"（ReviewLoop）

> `policy_sha`: `7f01e5a3ff53ed13ba763d684a098c0989425ec4`（`Jiaze-Li/personal-skills` `main`）

## 目标
现在的设计审查只核对"方案有没有矛盾、结构是否齐全"，不检查"是不是最好的方案"；同时 `design` 与 `code` 的部分判断分散穿插在通用流程里。要改成：
1. Worker 与 Reviewer 各自独立想方案，Supervisor 作裁判比较并裁决，让审查真正质疑方案本身；
2. 清理架构分层：抽清公共设施与按 `taskType` 隔离的工作逻辑，并与 `engineering-workflow`（`Plan → Design → Code`）完整衔接。

## 已确认决定（产品负责人 Jack 已确认，不得改动）
D1 只改设计任务（`taskType=design`）。代码任务（`code`）的行为、提示词、模型池一律不变。
D2 设计任务中，Reviewer 的职责改为：屏蔽 Worker 的设计文件（`reviewTarget`），允许读取代码库上下文；基于 Plan 与代码库独立写出"如果我来做，会怎么做"，最多两条，并说明各自的代价。
D3 设计任务中，Supervisor 成为裁判：拿到 Plan、Reviewer 的独立方案、Worker 的设计，以**分栏结构化格式**分别完成：（a）比较两者并给出比较结论；（b）逐条承担原有的设计阻塞项检查（是否违背 Plan/非目标、是否漏掉验收、内部是否自洽、`Options`/`Assumptions` 是否齐全、是否过度设计）。
D4 比较结果分两档：一致或差异小 → Supervisor 总结并判定，设计通过；差异大 → 统一进入"互换想法重来一轮"（把 Worker 与 Reviewer 的想法互相给对方，进入下一轮），不留由模型二选一的分支。
D5 互换想法最多做 2 次；第 2 次互换后差异仍大 → `HUMAN_REQUIRED` 停下来问用户，不再自动循环。
D6 Supervisor 在任何一轮（含第一轮）都可以判定"差异过大、需要人工决策或缺信息"，直接停下并向用户提问，写清需要用户决定或补充什么。
D7 如果 Supervisor 认为"按 Plan 这么做本身就不对"，不拦截，把这个判断单独写进结构化结果交给用户，由用户决定。
D8 设计 `PASS` 时，由 Supervisor 直接生成**格式化、简短清晰**的用户可读评论（包含：要建什么、需确认的 `Assumptions`、方案比较结论、如有对 Plan 的判断、`designSha256`；不限制 5 行上限），由 Worker 原样发布到 PR 并转达用户，不让 Worker 自行总结或改写。
D9 Supervisor 沿用现有 Supervisor 模型池与顺序（当前主力为 AGY Gemini 4 Hydrogen 中档），不新增角色，不新增模型池。
D10 架构分层清理：模型池、底层调用与容错、预算/配额/记账、状态持久化与防篡改、MCP 入口作为公共设施；`code` 与 `design` 各自独立规定自己的审查工作逻辑，并通过显式模式字段区分历史旧版 Design、新版两阶段 Design 与 Code，不靠字段组合隐式猜测，不把 `design` 逻辑挤进通用流程。
D11 已在运行的旧设计 loop 行为不变。
D12 配合 `engineering-workflow`（`Plan → Design → Code`）搭建完整工作流，并同步更新仓库内文档与 Worker Policy（含将设计通过评论规范从“不超过 5 行”调整为“由 Supervisor 生成、格式化且简短清晰”）。
D13 可观察状态输出：`reviewloop_begin` 与 `reviewloop_review` 返回固定格式的单行 `statusLine`（明确标出 `design` / `code`、`启动` / `第 N 轮 → 状态`），运行中复用 MCP `notifications/progress` 发送阶段提示，并在 Worker Policy 中要求回复用户时带出该状态行，方便用户确认 ReviewLoop 已运行且 `taskType` 正确。

## 非目标
不改代码审查行为；不新增角色或模型池；不让 Supervisor 写代码或 PASS 代码；不让本地 `reviewloop` 直接拥有 GitHub PR 写权限（仍由 Worker 原样发布）；不改变 Plan 的验收标准；不放松现有的费用、配额、记账和 fail-closed 规则。

## 全局验收（可观察）
A1 设计任务里，Reviewer 的"独立出方案"那次调用，输入中不含 Worker 设计文件内容，只含 Plan 与允许的只读代码库上下文；输出最多两条方案，每条带代价。
A2 设计任务每轮由 Supervisor 裁决，输出必须分栏结构化：同时包含"方案比较结论"（一致/差异小/差异大、理由、如有对 Plan 本身的判断）与"原有设计检查项逐条核对"。
A3 一致或差异小 → 通过；原有设计检查的阻塞项仍然阻塞通过。
A4 差异大 → 下一轮 Worker 与 Reviewer 各自收到对方的方案，互换想法最多 2 次；第 2 次互换后仍差异大 → `HUMAN_REQUIRED`。
A5 Supervisor 任意一轮判定需要人工 → `HUMAN_REQUIRED`，给出用户可读的问题清单。
A6 设计 `PASS` 时，`reviewloop_review` 返回由 Supervisor 直接生成的格式化、简短清晰的用户评论文本（含 `designSha256` 及如有对 Plan 的判断），供 Worker 原样发布。
A7 架构按公共设施与 `taskType` 工作逻辑清晰隔离：新增测试证明 `code` 任务不走新路径，现有全部测试通过；旧版 Design loop 经显式/兼容识别仍走原路径。
A8 Supervisor 输出格式无效、调用失败或预算/配额拒绝 → 绝不放行设计（fail-closed）。
A9 费用、配额、记账沿用现有机制；设计任务每轮模型调用次数有明确上限并写进文档。
A10 ARCHITECTURE 文档、`engineering-workflow` 衔接说明与 Worker Policy 同步更新；Worker Policy 体积不超过现有预算。
A11 `reviewloop_begin` 与 `reviewloop_review` 均输出清晰的 `statusLine`（标明 `design` / `code`、启动或第 N 轮结论），且 `reviewloop_review` 在阶段切换时发送 `notifications/progress`；Worker Policy 约定在向用户汇报时带出该状态行。

## 未知前提（需验证，不得假定）
U1 Gemini 4 Hydrogen 中档能否稳定胜任"分栏结构化裁决（比较方案 + 原有设计阻塞项逐条核对 + 生成格式化用户评论）"，需在实现后做一次真实轻量调用验证（含故意埋入漏项/矛盾的测试用例）。
U2 Reviewer 池（当前主力 AGY Opus）在"看 Plan + 代码库、屏蔽设计文件"条件下，能否稳定产出符合格式的独立方案。
