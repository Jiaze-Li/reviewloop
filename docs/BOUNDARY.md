# ReviewLoop 职责边界

**定位：活在本地干，结果在 GitHub 上发布和审计。**

| 阶段 | 发生地 | 负责 | 用户看到 |
|---|---|---|---|
| Plan | ChatGPT + PR 评论 | Lead | PR 里的 Plan |
| Design | 本地 | Worker 写，ReviewLoop 审 | PR 里的 Design 与审查结论 |
| Code | 本地 | Worker 写，ReviewLoop 审 | 推送后的 PR |
| PR 审查 | GitHub | PR bot 审，Worker 修 | PR 里的审查线程与状态评论 |

## ReviewLoop 管什么
- 本地确定性关卡（Gate）、独立 Reviewer、不收敛检测、预算与例外式 Supervisor 指引。
- 工程方法文档（`engineering/`）、Worker 规则（`agent-policy/COMMON.md`）、`reviewloop spec` 读取入口与一致性检查。
- 向 PR 发布任务合同（Plan/Design 评论归档、索引、恢复校验）；只读查询 PR bot 状态评论。

## ReviewLoop 不管什么
- 不写应用代码、不 commit/push/merge/部署、不替用户授权。
- 不监视 GitHub PR、不轮询、不唤醒已退出的 Agent、不在本地另存 PR 审查状态（PR 任务类型已移除，见 DECISIONS D44）。
- 不做 PR 审查——PR bot 独占，并在 PR 上维护唯一的审查状态；PR bot 不自动修代码，Worker 修完推送后评论一次 `@gemini review`，Resolve 由人点。
- 不管非工程 Skills（留在 `personal-skills`）。

## 新增功能对照清单
新功能先问：(1) 是本地审查/规范/读取入口吗？否则不属于本仓。(2) 会向 GitHub 写除合同归档外的内容、或常驻轮询吗？是则拒绝或回到产品决定。(3) 会在本地复制 PR bot 已有的状态吗？是则拒绝。(4) 改了工具接口，是否同一 PR 更新 `engineering/` 与 `COMMON.md`，并通过 `npm run doctor` 的一致性检查？
