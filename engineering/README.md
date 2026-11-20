# AI Engineering Workflow v1.3.0

方法的唯一权威（Worker 规则归 `agent-policy/COMMON.md`，授权规则归 `authorization.md`，工具接口归 MCP schema；边界见 [docs/BOUNDARY.md](../docs/BOUNDARY.md)）。

## 结论
所有新工程任务走同一条流程：**Plan → Design → Code**，每个阶段结束都停下，等你明确说下一步。设计和代码由本地 Agent 经 ReviewLoop 独立审查；PR 审查归 PR bot。

## 唯一流程

```text
Plan（ChatGPT 或本地 Agent）──停──你说“Design”──▶ Design（本地 Agent + ReviewLoop）──停──你说“Code”──▶ Code（本地 Agent + ReviewLoop）──停──▶ PR bot/CI → 你验收、决定合并
```

| 阶段 | 谁做 | 产物 | 到哪里停 |
|---|---|---|---|
| **Plan** | ChatGPT 或本地 Agent（Lead） | 一份**完整的 Plan**（目标、非目标、约束、可观察验收、已确认决定、未知前提）；Brief 是它的摘要，放在 PR 描述顶部 | Plan 写完就停，你说“Design”才继续 |
| **Design** | 本地 Agent + ReviewLoop `design` | 一份**完整的设计文件**，含 `Options`、`Assumptions`、已核实事实，末尾是可直接用于 Code 的 Work Contract | 设计 PASS 后在 PR 发不超过五句的评论并停，你说“Code”才继续 |
| **Code** | 本地 Agent + ReviewLoop `code` | 代码、测试、本地审查通过 | 本地 PASS 后停；按 `authorization.md` 在本任务范围自动完成常规修改、验证与正常 `commit`/`push`；PR bot、CI、你的验收、合并各自独立 |

- **不按风险等级跳过任何阶段。** 小任务写短 Plan、短设计，同样走完。
- **阶段内的普通返工自动继续**（`REWORK`、`PHASE_PASS`）；`HUMAN_REQUIRED`、新增重大决定、权限缺口才停下来找你。
- **授权语义见 `authorization.md`。** 阶段切换与高影响操作（`merge`、部署、权限变更等）必须人工明确授权；已授权阶段内本任务范围的常规修改、验证、`commit`/`push` 与合同归档按 `authorization.md` 自动完成。


## 阶段必读文件（`reviewloop spec <阶段>` 读取本表，不另存清单）
| 阶段 | 必读文件 |
|---|---|
| plan | README.md, authorization.md, lead.md, handoff.md |
| design | README.md, authorization.md, architect.md, contracts.md, handoff.md |
| code | README.md, authorization.md, task-spec.md |
| review | README.md, authorization.md, reviewer.md, handoff.md |
| pr | README.md, authorization.md |

`chatgpt.md`（ChatGPT 设置与启动语）和 `evals.md`（评测）只在配置/评测时读。新任务的 `policy_sha` 写作 `reviewloop@<40 位 SHA>`（取自 `reviewloop spec` 输出的 `policy_ref`），任务内固定；开工回复以 `已读规范：<文件> @<sha7>` 起头。
ReviewLoop 的 PR 合并后，Worker 把本地更新到最新 main 并提醒用户开新会话。

## 旧任务
**不带 `reviewloop@` 前缀的 40 位 `policy_sha` 是 `Jiaze-Li/personal-skills` 的 SHA**：按其原冻结合同和该 SHA 在 personal-skills 的文件执行，不得改读本目录；`reviewloop spec --at <旧 SHA>` 会拒绝并提示这一点。旧证据不删不改。

## PR 修复阶段（阶段 `pr`）
用户说“处理 PR <n>”：读该 PR 最新的 `<!-- jiaze-review-session:v1 -->` 状态评论（唯一权威）→ `HUMAN_REQUIRED` 则停下报告 → 否则修复、测试、推送 → 推送后在该 PR 评论一次 `@gemini review`（发之前确认当前 HEAD 之后没有已发过的同一评论）→ 报告并停止。**Worker 不点 Resolve**；复核结果出现前不得宣布 READY；`AUDIT_PENDING`/`PARTIAL`/缺失/过期 = 等待或查 bot，不批准。ReviewLoop 不监视 PR、不唤醒会话。

## 对用户的回复（所有 Agent、所有阶段）

用户是产品负责人，不是技术监督。每个 Agent（Claude、Codex、Gemini/AGY 等）面向用户的回复遵守 `handoff.md` 的**最小充分信息原则**：

1. **讲结果，不讲实现。** 用用户能理解的功能语言说明发生了什么、边界与下一步；不堆砌文件名、函数名、变量名、内部字段、哈希或常规技术参数。只有用户明确追问细节或审计材料时才精确提供，答完回到功能语言。
2. **不强套固定模板：** 取消固定三段顺序与每步固定三行结尾；有决策或待办才列，没有就不硬凑。
3. **开工凭据例外：** 阶段开头的 `已读规范：<文件> @<sha7>` 凭据行照常保留。


## 跨角色接口规则
- **Plan 与 Design：** Design 可提出更好路线、补充前提，但不得暗改验收标准；需求矛盾回到你。Brief 和五句话不是审查合同。
- **一份设计直接执行：** 设计末尾的 Work Contract 就是 Code 的合同；Code 逐字交给 ReviewLoop 并带 `designSha256`，对不上就停。该值只是内容一致性检查，不证明 PASS，也不替代授权。
- **版本各管各的：** `policy_sha` 固定方法；Plan 版本固定需求；`designSha256` 固定设计；提交固定被审代码；不得互相替代。
- **授权与禁区：** 所有阶段与角色的授权边界统一遵循 `authorization.md`，未获阶段授权或触及高影响禁区时不得执行。
- **Reviewer 不绕过 Worker Policy：** 下发可执行修复 Prompt 前核实原 loop 状态与 PR HEAD/bot 证据；`HUMAN_REQUIRED` 停止；预算与 bot 关卡不能靠新任务或改 AC 绕过。输出格式遵循 handoff.md。
