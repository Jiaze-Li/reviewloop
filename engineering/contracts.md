# 任务合同归档与恢复（PR 评论模式）— v1.3.1

**唯一详细规范；Lead 与 Architect 只引用本文件。** 目的：任务级 Plan/Design 全文只存在于该任务的 PR，main 只收正式项目资产。

**适用与默认：** 所有新任务默认且只允许使用本文件的 PR 评论模式（无需用户再单独指定 `contract_storage: pr-comment`）。**旧任务（裸 40 位 `policy_sha`、已冻结合同或现存 `Plan.md`/`Design.md`）**照旧按原合同与原文件路径恢复，不被本文件重判或清理。
**强制状态：** ReviewLoop 本地 CLI 与 `check-pr-handoff.js --check-diff` 提供本地恢复校验与最终差异检查；远端分支保护 / 目标仓库 CI 若未配置仍为 `NOT_ENFORCED`，不得标成已强制。

**1. 权威与格式**
- 唯一权威 = PR 里被索引登记的那条评论，不是聊天、摘要、Brief 或五句话。公开仓库的评论公开可读：合同里不得有凭据或私人数据；涉密任务停下问用户。
- 评论格式：首行写任务 ID、类型、版本；然后 `<!-- reviewloop-<plan|design>:<任务ID>:<版本>:begin -->`、`<details>`、`<summary>…</summary>`、正文（以 `# Plan` 或 `# Design` 标题起始）、`</details>`、对应 `end` 标记。
- **哈希范围：** 以**真正的折叠块**为准——begin 标记之后的 `<details>` 内、`</summary>` 之后到 `</details>` 之前的正文，去首尾空白后的 UTF-8 SHA-256。评论头部说明文字里若出现字面的标记文本，不算折叠块边界，须取 begin 标记之后的那一对。**范围终点以 `end` 标记为准：** 正文可能引用字面的 `</details>`，取 `end` 标记之前最后一个 `</details>`，不得在正文里第一个 `</details>` 处截断。Plan 与 Design 用同一算法；Design 的值必须等于 ReviewLoop PASS 返回的 `designSha256`（评论末行 `designSha256:`）。其他空白处理会得到不同值，禁止自行换算法。
- PR 描述保留面向人的 Brief 与“合同索引”表：`任务ID · 类型 · 版本 · 评论编号(databaseId) · sha256 · 分段数 · 状态(current/superseded)`。
- 超过 60000 字符必须分段：每段带序号和总数，全文哈希另记。仅仓库所有者账号发布的评论可采用。
- **版本：** 冻结后修改 = 发新评论（v1.1…），索引把旧版标 `superseded`；评论被原地编辑不是正当修改。Design 内容变化使旧 PASS 与 `designSha256` 作废。

**2. 恢复程序（新会话或不同 Agent；任何一步失败即停止并报告，不得用聊天记忆、Brief 或摘要继续）**
1. 读 PR 描述索引取当前版本；交接包写的版本与哈希必须与索引一致。
2. 按评论编号直接取（不翻页、不搜索）；作者必须是所有者账号。
3. 取全部分段，标记齐全、序号连续、无重复无多出。
4. 拼接 → 去首尾空白 → SHA-256，与索引（Design 还要与 `designSha256`）比对，不等即停。
5. 评论有编辑记录：哈希一致可用并注明；不一致即停。
6. **信任锚的限度：** 索引与评论同在 PR 内，写权限者可同时改两处。Design 以 ReviewLoop PASS 返回的 `designSha256`（PR 之外的来源）为独立锚点；Plan 无独立锚点，高风险合同须所有者确认。

失败处理：评论缺失/被删/作者不符、哈希不符、多个 current、读取不全 → 停止并回到用户，不重建、不截断；可读但无法验证编辑历史 → 以哈希为准并标注“编辑历史未核验”。

**3. 阶段顺序**
- **Plan：** 零文件引导（与 main 同树的空提交）→ Draft PR → Plan 评论 + 描述索引；到此停。
- **Design：** 先按第 2 节核对 Plan；`begin(design)` 以恢复出的 Plan 全文为合同；在仓库根目录创建尚不存在的未跟踪设计文件；**每次送审前先按第 5 节把该版本全文作为“未审查草稿”发布并读回**，再审查至 PASS；不提交、不加忽略规则。
- **PASS 后：** 发设计归档评论和 ReviewLoop 返回的五句评论（逐字）；重新取回归档评论，哈希 = `designSha256` 才算归档成功，随后登记索引并**才**删除未跟踪的工作文件；校验失败则保留文件并停下。删除发生在 Code 开始前。
- **Code：** 按第 2 节恢复设计全文 → `begin(code, 全文, designSha256)`（由 ReviewLoop 再核对）。
- **人工授权例外（审查工具自身故障时）：** 新式 Design loop 因审查工具无法完成（如关键源码超出读取上限）停在 `HUMAN_REQUIRED` 时，只有**用户本人**可运行 `reviewloop accept-design-exception`，把一份精确的设计内容、冻结 Plan 与结构化外部独立审查报告绑定成一条人工裁决记录；原 loop 状态、预算与账本不变，**不产生 Design PASS**。归档时设计评论用 `contract format --exception`（尾行写明“非 ReviewLoop PASS”，不得用 PASS 同款 `designSha256:` 尾行），裁决记录以类型 `exception`、同一版本号归档并登记索引；`verify-archive` 在找不到 PASS 时才接受有效例外，并核对 Plan、例外归档、PR/任务/版本绑定，输出标明 `HUMAN_EXCEPTION`。外部报告有未关闭的 P1/P2 即拒绝；未核实风险须用户另行用 `--accept-risk` 明确承担。

**4. 什么进 PR，什么进 main**
- 有长期依据价值且有维护人的才进 main，并须在 Work Contract 的“正式资产清单”逐条列出（路径、为何长期、谁维护）；只服务本次审查的（Plan/Design 全文、引导提交、过程记录）留在 PR。
- 最终 PR 差异不得出现 `Plan*.md`/`Design*.md` 类任务文件或与已归档合同哈希相同的文件（清单内除外）；该检查不得靠删旧文件或隐藏审查证据通过。

**5. Design 过程留痕（草稿与审查记录；不是合同、不是授权）**
- **两类记录，独立命名空间：** `reviewloop-draft:<任务>:<版本>`（设计全文，标注 `UNREVIEWED · NOT DESIGN PASS`）与 `reviewloop-review:<任务>:<版本>`（一轮审查里程碑、工具失败或外部审查转贴）。这两类标记**不会**被 `contract recover` / `verify-archive` 识别，因此不可能被当成正式 Plan/Design/Exception；不进入“合同索引”表，不新增合同类型。
- **发布顺序（Worker 用 `gh` 发，ReviewLoop 不写 GitHub）：** `reviewloop trace inspect`（已存在同哈希草稿则复用）→ `trace prepare --kind draft`（先做敏感信息扫描，命中即拒绝，无绕过开关）→ `gh pr comment` → `trace inspect` 读回（作者=仓库所有者、分段齐全、正文哈希=尾行哈希=本地文件）→ 成功才送审；失败则保留本地设计、不送审、报告用户。同哈希不得发新版本；修订发新版本并附变更说明与对上一轮 finding 的逐项处理（Worker 声明）。旧评论不原地编辑。
- **审查记录只绑定工具返回的 `adjudicatedDesignSha256`**（仅在审查真正产生可用裁决且内容未漂移时返回；PASS 仍用 `designSha256`）。工具超限、无结果、取消等一律记为“未绑定”，不得写成已审查或合格。外部独立审查转贴须写明审查者、独立性（转贴者声明，系统不验证）、材料与结论；NO_BLOCKING 不改变 ReviewLoop 状态，不构成 PASS、人工例外或 Code 许可。
- **PR 描述“设计过程”区块**由 `trace inspect --body-out` 从已校验评论派生，只替换 `<!-- reviewloop-trace:begin/end -->` 之间的内容；它不是权威，可随时由评论重建；Code 授权栏恒为“未授权，由用户另行决定”，正式 Design 与人工例外只引用合同索引并标 NOT_VERIFIED，核验仍用 `verify-archive`。同键同哈希重复评论取最小评论号为 canonical；同键异哈希、缺段、错作者、哈希与尾行不符一律失败关闭，不删不改。PR 描述无原子读改写：写后读回比对，不一致则停止并从评论重建。
- `verify-archive --require-trace` 要求存在与被归档 Design 哈希一致的已校验草稿；不带该参数时缺失只给 `TRACE_ABSENT` 警告（旧任务兼容）。新任务的 Design 阶段应带该参数。`NOT_ENFORCED`：`reviewloop_review` 本身不联网读 PR，“先发草稿再送审”是流程要求，由上述检查事后发现。

