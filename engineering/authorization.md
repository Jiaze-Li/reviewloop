# Engineering Authorization Policy — v1.3.1

**本文件是工程授权规则的唯一权威。** 所有阶段与角色规范（`README.md`、`lead.md`、`architect.md`、`task-spec.md`、`reviewer.md`、`chatgpt.md`、`handoff.md`、`agent-policy/COMMON.md`）均引用本文件语义，不再另行定义互相竞争的授权清单。

## 1. 核心原则：区分“阶段关口”与“阶段内常规动作”

用户负责决定**任务目标、阶段推进、重大取舍与高影响动作**；Agent 在**已获授权的当前阶段与本任务专属资源范围内**自动完成常规、可检查、可回滚的执行动作，不再对每一步编辑、测试、正常 `commit`、`push`、Draft PR 初始化、合同归档或同任务返工逐项请示。

- **规则文本不等于工具权限：** 宿主工具审批、GitHub 权限与仓库保护规则继续有效；遇工具拒绝或权限缺口立即停止并报告，不绕过限制。
- **事实互不替代：** 阶段授权、Design PASS、Code 本地 PASS、PR bot `READY`、CI 通过与 `merge`/部署是不同事实，不得互相替代。

## 2. 任务授权记录（Brief 与交接必备）

每个正式任务在 PR 描述 Brief 与跨会话交接中记录同一份简洁授权边界，无需用户自行拼接多份规则：
- **目标仓库与专属资源：** 允许写入的唯一仓库、任务专属分支与关联 PR。
- **当前已授权阶段：** `Plan` / `Design` / `Code` / `PR 修复`（未到达的阶段默认未授权）。
- **显式收紧或例外：** 用户明确禁止或额外放行的动作（例如“只改代码不 push”或特定仓库已确认的预览环境例外）。
- **外部副作用核查：** 确认常规 `push` / Draft PR 更新是否会触发生产部署或不可逆外部通知。

## 3. 各阶段默认放行边界与停止点

一旦用户授权进入某阶段且无显式收紧指令，Worker 在**本任务指定仓库、专属分支与关联 PR** 内可自动执行下列常规动作，直到阶段停止点：

| 阶段 | 进入前提 | 阶段内默认放行（不逐项请示） | 必须停止点 |
|---|---|---|---|
| **Plan** | 用户确认规划目标并允许开设正式任务 / Draft PR | 创建任务专属分支、必要零文件引导提交、创建 Draft PR、发布 Plan 归档评论与更新 PR 合同索引 | Plan 归档校验完成后停下，等用户明确说 **Design** |
| **Design** | 用户明确说 **Design**，且已按 `contracts.md` 核对恢复 Plan | `reviewloop_begin(taskType="design")`、创建并修改根目录单个未跟踪设计文件、同 loop 内 `REWORK` 返工；`送审前发布设计草稿评论、发布每轮审查记录与外部审查转贴评论、更新“设计过程”区块（均见 `contracts.md` §5，不构成授权），`PASS` 后发布设计归档评论、更新索引、校验哈希 = `designSha256`、清理该未跟踪临时文件并发布 `designPassComment` | 归档校验失败保留文件并停下；完成后停下，等用户明确说 **Code** |
| **Code** | 用户明确说 **Code**，且已按 `contracts.md` 恢复核对 Design 原文与 `designSha256` | 在任务允许范围内修改文件、运行测试与检查、同 loop 内 `REWORK` / `PHASE_PASS` 返工、正常 `commit`、正常 `push` 至本任务分支、更新 PR 描述交接块并运行 `check-pr-handoff.js` | Code 本地 PASS 并完成已授权交付后停下（不得 `merge`；本地 PASS 不等于 PR bot `READY`） |
| **PR 修复** | 用户明确说 **处理 PR \<n\>**，且已核对原合同/loop、当前 `HEAD` 与最新 `<!-- jiaze-review-session:v1 -->` | 当状态为 `REWORK` 且 `lastReviewedHead` 匹配 `HEAD` 时：在同任务分支修复、运行验证、正常 `commit`/`push`、在当前 `HEAD` 之后未重复发过时评论一次 `@gemini review` | 状态为 `HUMAN_REQUIRED`、`AUDIT_PENDING`、`PARTIAL`、缺失或过期时停止；修复推送并评论后停止；**绝不点 Resolve** |

## 4. 永不自动放行的操作（Hard Stops）

无论处于哪个阶段，以下动作**永远不会**因阶段授权而自动放行，必须停止并获得用户明确单独授权（或按阻塞处理）：
1. **高影响发布与破坏性操作：** `merge`、生产部署、`force push`、正式数据或非本任务受控临时文件的删除、权限/凭据/仓库保护规则变更。
2. **越权与污染：** 跨仓库写入、向非本任务分支（尤其是 `main`/`master`）写入、覆盖或清理工作区内来源不明的他人改动。
3. **外部副作用：** 目标仓库在 `push` 或 Draft PR 更新时若会触发生产部署、外部客户通知或其他不可逆副作用（或情况未知），不得凭动作名称自动推送。
4. **敏感信息外发：** 向公开 PR 评论或提交中写入密钥、凭据、私人数据或未脱敏敏感材料。
5. **绕过安全关卡：** 在 `HUMAN_REQUIRED`、重大产品/科研/共享架构决定、权限缺口或真实工具阻断下继续执行；新开 loop、修改冻结 AC 或弱化验证以绕过预算/bot 状态。Design 审查工具故障时的人工授权例外（`reviewloop accept-design-exception`，见 `contracts.md` §3）只能由用户本人运行，Worker 不得代为运行；它只放行该设计的归档清理与进入 Code，不是 Design PASS，也不放行本节任何其他动作。

## 5. 旧任务兼容

裸 40 位 `policy_sha`（`personal-skills` 时期）及本规范生效前已冻结的任务合同，仍按其原冻结合同与原授权记录执行；本规范不追溯扩大既有冻结任务的默认权限。
