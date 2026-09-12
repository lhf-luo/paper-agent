# 团队库与团队服务完善计划

本计划面向负责实施的模型/开发者。评审者只负责审核与补强，不参与实现。请严格按阶段推进，每个阶段独立提交，通过验收后再进入下一阶段。

评估基线：2026-09-11，分支 `fix/gitattributes-eol`，团队相关 24 个测试全部通过。

## 0. 必读约束

1. **边界不可破坏。** `team-server/` 不得引用 `team-server/` 之外的任何相对路径，运行时只能使用 Node.js 内置模块。`team-server/test/standalone.test.ts` 会检查这一点。主项目可以引用 `team-server/`，反向不行。
2. **所有团队写操作必须走 prepare/execute 两步确认。** 参考 `src/app/application/paper-agent-team-operations.ts` 中现有模式：`xxxPlan()` 生成 `OperationPlan`，`prepareXxx()` 调 `this.consent.prepare`，`xxx()` 调 `this.consent.consume` 后再执行。`OperationPlan.kind` 只能取 `src/shared/domain/operation-confirmation.ts` 中 `MutatingOperationKind` 已有的值。
3. **永远不要记录、打印、写入 Bearer token、`Authorization` 头、`pateam1.` 接入串或 `.paper-agent/team-access.json` 内容。** 访问日志只能记录脱敏后的字段。
4. **个人隐私不上行。** 论文提案在客户端和服务端都要清空 `userNotes` 和 `screening`。新增任何上行通道时保持同样的脱敏。
5. **协议两份拷贝必须同步改。** 任何请求体、响应体、类型字段变化都要同时修改 `team-server/src/protocol/` 与 `src/team/domain/`（以及必要时 `src/literature/domain/literature-types.ts`），并同步更新 `docs/team-handoff.md` 第 7 节 API 速查。
6. **文件换行统一 LF**，仓库已有 `.gitattributes` 约束。
7. **每阶段结束必须通过：** `npm run check`（包含 lint、三处 typecheck、web 构建、全部 vitest、team-server 测试与 `scripts/team-corpus-smoke.ts`）。
8. 不要顺手重构无关代码，不要改动无关文件的格式。

## 1. 关键代码地图

| 层 | 文件 | 说明 |
| --- | --- | --- |
| 服务端路由 | `team-server/src/presentation/team-corpus-server.ts` | 全部 HTTP 路由、role 判断 |
| 服务端校验 | `team-server/src/presentation/team-corpus-http.ts` | 请求体校验、分页、错误类型 |
| 服务端身份路由 | `team-server/src/presentation/team-identity-routes.ts` | `/v1/admin/identities/*` |
| 论文存储 | `team-server/src/infrastructure/file-team-literature-repository.ts` | records、搜索、提案合并、blob、paper-versions |
| 知识存储 | `team-server/src/infrastructure/team-knowledge-store.ts` | 派生、Artifact、审计、备份入口 |
| 合并语义 | `team-server/src/domain/literature-identifiers.ts` | `mergePaperRecords`、`mergeCuration` |
| 身份注册表 | `team-server/src/infrastructure/team-token-registry.ts` | token 哈希、生命周期 |
| 备份 | `team-server/src/infrastructure/team-backup.ts` | bundle 创建、校验、演练 |
| 服务端入口 | `team-server/src/index.ts` | 环境变量、TLS、监听 |
| 客户端 HTTP | `src/team/application/team-corpus-client.ts` | 覆盖全部服务端接口 |
| 客户端接入 | `src/team/application/team-access-service.ts` | 接入串、成员管理两步确认 |
| 应用层 | `src/app/application/paper-agent-team-access.ts` | `teamOverview()`、`searchTeamLibrary()` |
| 应用层 | `src/app/application/paper-agent-team-operations.ts` | 提案、审核、blob、备份 |
| 应用层契约 | `src/app/application/paper-agent-contracts.ts` | `Team*Input` 类型 |
| 本地 HTTP 路由 | `src/app/presentation/team-routes.ts` | `/api/team/*` |
| Pi 工具 | `src/team/presentation/team-corpus-tools.ts` | `manage_team_literature_server` |
| Web 页面 | `web/src/App.tsx` 中 `function TeamPage()`（约 3944 行起） | 团队知识库页 |
| 个人库写入 | `src/literature/application/literature-store-write.ts` | `upsertPaper()` 返回 created/updated/unchanged |
| 个人库材料 | `src/literature/application/literature-store-materials.ts` | `putBlob()`、`savePaperVersion()`、`listPaperVersions()`、`putDerived()`、`listDerived()` |
| 测试 | `test/team-corpus-server.test.ts` 等 5 个文件、`team-server/test/standalone.test.ts`、`scripts/team-corpus-smoke.ts` | 服务端测试用 `createTeamCorpusServer` 起 loopback 实例 |

## 2. 阶段一：修正审核语义（必须最先做）

### 任务 1.1 读者只看到已批准的论文

**问题。** `FileTeamLiteratureRepository.searchPapers()` 与 `GET /papers/{id}` 不按 `curation.teamReview.status` 过滤，reader 能搜到待审核和已拒绝的记录。`docs/team-handoff.md` 第 12 节第 1、2 条已把它列为已知风险。

**改动。**

- `team-server/src/domain/team-literature-repository.ts`：`searchPapers` 的 options 增加 `reviewStatuses?: SharedReviewStatus[]`。
- `file-team-literature-repository.ts`：`searchPapers` 中按 `reviewStatuses` 过滤；未传时**默认只返回 `team-approved`**。
- `team-corpus-server.ts` `GET /search`：新增查询参数 `status`，可重复或逗号分隔，取值 `team-proposed|team-approved|team-rejected`。只有 `reviewer` 或 `admin` 可以传非 `team-approved` 的值，否则 403。
- `team-corpus-server.ts` `GET /papers/{id}`：非 reviewer/admin 读取到状态不是 `team-approved` 的记录时返回 404（不要返回 403，避免泄露记录存在）。
- `GET /derived` 与 `GET /artifacts` 已经有此语义，不动。
- 客户端 `team-corpus-client.ts` `search()` 增加 `statuses?: SharedReviewStatus[]`；`paper-agent-team-access.ts` 的 `teamOverview()` 在 `capabilities.canReview` 时不需要改（待审列表走 `/proposals`）。
- Pi 工具 `team-corpus-tools.ts` 的 `search` action 增加可选参数 `review_statuses`。

**测试。** 在 `test/team-corpus-server.test.ts` 新增用例：contributor 提案后，reader 搜索结果为空且 `GET /papers/{id}` 返回 404；reviewer 用 `status=team-proposed` 能搜到；批准后 reader 能搜到；拒绝后 reader 搜不到。`scripts/team-corpus-smoke.ts` 现有断言在提案后立即搜索并期望命中，需要改为批准后再搜索。

**文档。** 更新 `docs/team-handoff.md` 第 7 节搜索参数说明、第 12 节删除第 1、2 条；`docs/team-knowledge-base.md` 的 reader 说明保持一致。

### 任务 1.2 论文内容变化时重置审核状态

**问题。** `mergeCuration()`（`literature-identifiers.ts` 约 296 行）在合并时保留已审核状态，即使论文内容变了。派生记录和 Artifact 已使用 `stableFingerprint` 判断变化，论文没有。`docs/team-handoff.md` 第 9 节声称"只有内容指纹变化时才重新进入 team-proposed"，与实际不符。

**改动。**

- `file-team-literature-repository.ts` `upsertPaper()`：合并后，比较 `existing` 与 `merged` 去掉 `curation` 后的 `stableFingerprint`（从 `team-knowledge-serialization.ts` 导入）。若指纹不同且 `existing` 状态为 `team-approved` 或 `team-rejected`，把 `merged.curation.teamReview` 重置为 `{ status: "team-proposed", proposedBy: contributor, proposedAt: now }`。若指纹相同，保留原审核状态（现有行为）。
- 注意 `proposePapers()` 当前先把 `proposed.curation.teamReview` 设为 team-proposed，再由 `mergeCuration` 选出已审核的那个；新逻辑要在 `upsertPaper` 层面完成判断，把 contributor 传进去。
- 产品取舍：重置后该记录会从 reader 视图消失直到重新批准。在 `docs/team-knowledge-base.md` 明确写出这一行为。

**测试。** `test/team-corpus-server.test.ts`：批准一条记录后，同一 contributor 再次提案相同内容，状态仍为 approved；修改 abstract 后再提案，状态变为 team-proposed，且审计事件中有 `paper.propose`。

### 任务 1.3 补齐服务端测试缺口

在 `test/team-corpus-server.test.ts` 或新建 `test/team-identity-lifecycle.test.ts` 补充：

- `expiresAt` 过期身份认证返回 401；
- `ban` 后 401，`unban` 后恢复；
- `revoke` 后 401，未 revoke 直接 `delete` 返回错误，revoke 后 delete 成功且 `GET /v1/admin/identities` 不再列出；
- 管理员对自己执行 revoke/ban/delete 返回 4xx；
- `GET /events` 的 `cursor`/`limit` 分页与倒序；
- `GET /derived?pending=true` 对 reader 不生效（仍只返回 approved），对 reviewer 生效；
- `GET /papers/{id}` 对不存在的 id 返回 404。

**验收标准。** 上述全部通过；`npm run check` 通过；文档三处已同步。

## 3. 阶段二：打通"团队 → 个人"下行闭环

当前团队库只能上行，没有任何把团队论文或 PDF 拉回个人库的流程。`TeamCorpusClient.downloadBlob()` 存在但零调用。

### 任务 2.1 服务端：列出论文的 PDF 版本

客户端要下载 blob 需要 sha256，但服务端没有列出 `paper-versions/{paperId}.json` 的接口。

- `team-literature-repository.ts` 增加 `listPaperVersions(paperId): Promise<PaperVersion[]>`，`file-team-literature-repository.ts` 实现（读 `versionPath`，不存在返回 `[]`）。
- `team-corpus-server.ts` 新增 `GET /v1/namespaces/{ns}/papers/{paperId}/versions`，要求 `reader`；论文不存在或对该身份不可见（按任务 1.1 规则）时 404。注意现有 `papers/` 前缀路由要先匹配 `/versions` 后缀再匹配单篇读取。
- `team-corpus-client.ts` 增加 `listPaperVersions(namespace, paperId)`。
- 协议类型：`PaperVersion` 已在两份 `literature-types.ts` 中，不需要新增类型。

### 任务 2.2 应用层：拉取到个人库

- `paper-agent-contracts.ts` 新增：

```ts
export interface TeamPullInput {
	paperIds: string[];            // 1..200
	personalNamespace?: string;
	includePdf?: boolean;          // 默认 false
}
```

- `paper-agent-team-operations.ts` 新增 `teamPullPlan()` / `prepareTeamPull()` / `pullTeamPapers()`。plan 的 `kind` 用 `"personal-corpus-write"`，`targets` 列出每篇标题与 id，`details` 含 serverUrl、teamNamespace、personalNamespace、includePdf、以及每篇是否有可下载的 PDF 版本。
- 执行逻辑：对每个 id 调 `client.getPaper()`（需要在客户端补一个 `getPaper(namespace, id)` 方法，对应现有 `GET /papers/{id}`），得到的记录：
  - 保留 `provenance`、`identifiers`、`links`、`tags`、`mergedFrom`、`materialHashes`；
  - `curation.userNotes` 置空，`curation.screening` 置 undefined；
  - `curation.teamReview` 原样保留（状态为 `team-approved`，personal 侧的 `TeamReviewStatus` 已包含该值），这是个人侧识别"来自团队"的标记；
  - 调用个人库 `upsertPaper()`，收集 created/updated/unchanged 计数。
- `includePdf` 为 true 时：调 `client.listPaperVersions()`，取 `isPreferred` 或第一条；`client.downloadBlob()`；校验 sha256 与版本一致；个人库 `putBlob()` 与 `savePaperVersion()`（`blobPath` 用 putBlob 返回的 path）。任一篇 PDF 失败不影响其余篇，把失败原因收集进返回值。
- 返回值：`{ pulled: number; created: string[]; updated: string[]; unchanged: string[]; pdfs: { paperId; sha256; status: "stored" | "existed" | "failed"; reason? }[] }`。

### 任务 2.3 本地路由、Pi 工具、Web

- `team-routes.ts` 新增 `POST /api/team/pull/prepare` 与 `/execute`，参数校验方式参照现有 `proposals` 路由。
- `team-corpus-tools.ts` 新增 action `pull`，参数复用 `paper_ids`、`personal_namespace`、`personal_corpus_root`，新增 `include_pdf`。确认流程用现有 `authorize()`。同时 `search` 结果的 `details` 中每条 hit 保留 `record.id`，方便 Agent 接着 pull。
- `web/src/App.tsx` `TeamPage`：在"检索团队论文"结果和"已共享论文"列表中每条增加复选框与"拉取到个人库"按钮（可选"含 PDF"），走 `prepare()` 两步确认，执行后显示计数与 PDF 失败列表。
- `docs/agent-tools.md` 由 `npm run docs:tools` 重新生成，不要手改。

### 任务 2.4 文档与测试

- `test/paper-agent-application-team.test.ts` 新增：起 loopback 服务端，管理员提案并批准一篇并上传 blob，本地应用 `prepareTeamPull` → `pullTeamPapers({includePdf:true})`，断言个人库存在该论文、`listPaperVersions` 有对应 sha256、`userNotes` 为空、`teamReview.status === "team-approved"`；再次拉取返回 unchanged。
- `test/team-corpus-server.test.ts` 新增 `/papers/{id}/versions` 权限与 404 用例。
- `docs/team-knowledge-base.md` 增加"从团队拉取"一节；`docs/team-handoff.md` 第 7 节加新接口；`docs/web-agent-guide.md` 与 `web-agent-guide.zh-CN.md` 若有团队工作流描述则补一句。

**验收标准。** 一个 reader 身份可以在 Web 和 Pi 工具中把团队论文连同 PDF 拉进个人库；`npm run check` 通过。

## 4. 阶段三：补全内容类型与协作动作

### 任务 3.1 派生记录可从 UI 与工具提交

服务端 `POST /derived` 已存在，客户端 `proposeDerived()` 已存在，但无本地路由、无 Web、无 Pi action。

- `paper-agent-contracts.ts` 新增 `TeamDerivedProposalInput { keys: string[]; personalNamespace?: string }`（1..200）。
- `paper-agent-team-operations.ts` 新增 `teamDerivedProposalPlan()` 等三件套，`kind` 用 `"team-proposal"`。从个人库 `getDerived(key)` 读取；记录的 `paperId` 必须存在于个人库；`result` 字段中若含绝对路径（Windows 盘符或以 `/` 开头的字符串）需在 plan 的 `details.warnings` 里提示，但不自动改写。
- `team-routes.ts` 新增 `POST /api/team/derived/prepare|execute`。
- Pi 工具新增 action `propose_derived`，参数 `derived_keys`。
- Web `TeamPage` 提交区域增加"提交派生记录"块：列出个人库 `listDerived()` 的 key、operation、paperId，勾选后提交。若个人库没有派生记录，显示空状态说明。
- 测试：应用层用例走完整流程后，用 reviewer 在服务端 `listDerived({includePending:true})` 看到 team-proposed 条目。

### 任务 3.2 贡献者查看自己的提案

- 服务端 `GET /proposals` 增加查询参数 `mine=true`：`contributor` 角色允许调用，只返回 `curation.teamReview.proposedBy === identity.name` 的 team-proposed 记录；不带 `mine` 仍要求 reviewer。
- 客户端 `pendingPapers(namespace, cursor, { mine?: boolean })`。
- `teamOverview()`：`capabilities.canContribute && !canReview` 时请求 `mine=true`，返回值新增 `myProposals`。
- Web：贡献者身份显示"我的待审提案"列表。

### 任务 3.3 撤回提案

- 服务端新增 `POST /v1/namespaces/{ns}/proposals/withdraw`，body `{ paperIds: string[] }`，要求 `contributor`。规则：记录必须存在、状态为 `team-proposed`、`proposedBy` 等于当前身份名、且 `reviewedAt` 为空（从未被审核过）。满足则删除 `records/{id}.json` 并刷新 manifest，审计 `paper.withdraw`。任一条不满足整批 400，不做部分成功。
- 客户端、`TeamReviewInput` 之外新增 `TeamWithdrawInput { paperIds: string[] }`，应用层三件套，`kind` 用 `"team-write"`。
- 本地路由 `POST /api/team/proposals/withdraw/prepare|execute`；Web "我的待审提案"每条增加撤回按钮。
- 测试：撤回成功；他人提案撤回被 403 或 400；已批准记录撤回被拒绝。

### 任务 3.4 批量审核 UI

Web 待审核区三个列表（论文、派生、Artifact）增加全选/多选和"批量批准/批量拒绝"按钮，以及可选的 reason 输入框。后端 `reviewTeamEntries` 已支持数组，不需要改服务端。

**验收标准。** 三类内容都能从 Web 和 Pi 工具提交；贡献者能看到并撤回自己的提案；`npm run check` 通过。

## 5. 阶段四：规模与运维

### 任务 4.1 服务端内存索引

`searchPapers()` 每次全量读取 `records/*.json`。改为：

- `FileTeamLiteratureRepository` 持有 `private index?: Map<string, PaperRecord>`；`listPapers()` 首次调用时加载并缓存，之后直接返回 `[...index.values()]` 的深拷贝或冻结副本；
- 所有写路径（`upsertPaper`、`reviewTeamPaper`、任务 3.3 的删除）在写文件成功后同步更新 `index`；
- 备份恢复演练不会改动生产目录，不需要失效；
- 服务是单实例单写者，这个假设已在文档中声明，不要引入跨进程失效机制。
- 保留一个 `invalidate()` 方法供测试用。

审计日志 `listAuditEvents()` 全量读文件，在本阶段维持不变，但在 `docs/team-handoff.md` 第 12 节保留为已知项。

### 任务 4.2 脱敏访问日志与 401 限速

- `team-corpus-server.ts` 在 `handleRequest` 外层记录一行 JSON 日志到 stdout：`{ at, method, path, status, ms, identityId?, namespace? }`。`path` 只保留 pathname，不含 query；绝不记录 headers、body、token。可通过环境变量 `PAPER_AGENT_TEAM_ACCESS_LOG=off` 关闭。
- 对 401 做 per-IP 计数：同一 `request.socket.remoteAddress` 60 秒内超过 20 次 401，则在窗口内直接返回 429 `{ error: "too many authentication failures" }`。用内存 Map 加定时清理，不引入依赖。`/health` 不受影响。
- 测试：`test/team-corpus-server.test.ts` 新增 21 次错误 token 后返回 429 的用例。

### 任务 4.3 定时备份、保留策略与真正的恢复脚本

- 新增 `team-server/deployment/paper-agent-team-backup.service` 与 `.timer`（每日一次），service 调用 `curl --cacert ... -H "Authorization: Bearer $(cat /root/paper-agent-team-admin.token)" -X POST .../backups`，token 文件路径通过 `EnvironmentFile` 配置。
- 新增 `team-server/src/prune-backups.ts`：参数 `--root <backupRoot> --keep <N>`，按目录名中的时间戳排序，删除多余的 `team-*` 目录；删除前先用 `validateTeamBackupBundle` 确认候选是合法 bundle，不合法的目录只警告不删除。
- 新增 `team-server/src/restore.ts`：参数 `--backup <bundlePath> --root <dataRoot> [--with-identities] [--force]`。先 `validateTeamBackupBundle`；目标 `{root}/{namespace}` 已存在且无 `--force` 时拒绝；`--force` 时先把现有目录重命名为 `{namespace}.replaced-<timestamp>`；复制 `namespace/` 到目标；`--with-identities` 时同样处理 `_security/identities.json`。脚本开头检查 `{root}/{namespace}/.write.lock` 存在则拒绝运行并提示先停服务。
- `team-server/README.md` 新增"定时备份与恢复"章节，`docs/team-handoff.md` 第 8 节同步。
- 测试：`team-server/test/` 新增对 `prune-backups` 与 `restore` 核心函数的测试（把逻辑放在可导入的函数中，CLI 入口只做参数解析）。

### 任务 4.4 Web 概览分页

`teamOverview()` 一次 `search({limit: 300})`。改为：概览只返回 `stats` 与前 50 条；Web "已共享论文"区增加"加载更多"，通过 `/api/team/search?cursor=` 追加。`teamOverview` 的返回类型中把 `papers` 改名或保留但注释为首页。

**验收标准。** 1000 条记录的临时 namespace 下搜索响应时间显著优于改动前（在 PR 描述中给出改动前后的粗略测量）；限速与日志用例通过；恢复脚本在测试中完成一次真实恢复。

## 6. 阶段五：协议单一来源与文档收口

### 任务 5.1 协议漂移测试

新增 `test/team-protocol-drift.test.ts`：

- 比较规则：读取两个文件，去除 CRLF，删除所有以 `import` 开头的行（import 路径在两边必然不同），然后逐行比较，差异必须为空。
- 纳入严格比较的文件对：
  - `src/literature/domain/literature-types.ts` ↔ `team-server/src/protocol/literature-types.ts`（当前已一致）
  - `src/team/domain/team-corpus-types.ts` ↔ `team-server/src/protocol/team-corpus-types.ts`（当前服务端多一个 `TeamActor` 接口，把它补到客户端拷贝即可）
  - `src/team/domain/team-access.ts` ↔ `team-server/src/protocol/team-access.ts`（服务端内联了 `INVITE_PREFIX` 常量而客户端从 validation 模块导入，先把两边统一成同一写法再纳入比较）
- `src/team/domain/team-identity.ts` 与 `team-server/src/domain/team-identity.ts` 目前差异约 51 行，客户端是服务端的子集。把客户端需要的类型与 `canAccessTeamNamespace`、`publicTeamIdentity` 抽到 `team-server/src/protocol/team-identity.ts`，服务端 domain 文件从 protocol 导入，客户端文件与 protocol 文件纳入上面的严格比较。
- 测试文件放在主项目 `test/` 下，因为它需要同时读取两侧文件；这不违反服务端的单向边界。

### 任务 5.2 文档修正

- `team-server/README.md` 第 7 节日志示例 `listening at` 改为实际输出的 `listening on`。
- `team-server/deployment/team-server.env.example` 与 README 第 6 节说明 `PAPER_AGENT_TEAM_PUBLIC_URL` 只被 `invite.ts` 使用，服务本身不读取。
- `docs/team-handoff.md` 第 12 节按各阶段实际结果重写。
- `docs/README.md` 文档索引已包含本计划链接，阶段结束后按需更新描述。

## 7. 交付规范

- 每阶段一个分支、一个 PR，分支名 `team/phase-<n>-<slug>`。
- PR 描述必须包含：改动的接口列表、协议改动是否已同步两份拷贝、新增测试名、`npm run check` 输出的最后 10 行。
- 不合并到 `main` 之前，先把 PR 编号发给评审者。
- 阶段一必须最先完成，阶段二依赖阶段一（可见性规则）。阶段三、四可并行，阶段五最后。
- 如果某项任务在实现中发现与本计划冲突（例如类型不允许、边界测试失败），在 PR 描述中写明冲突和你选择的替代方案，不要静默改变范围。

## 8. 评审清单（评审者使用）

每个 PR 评审时逐项确认：

- [ ] `npm run check` 在 Windows 与 Linux（CI）都通过；
- [ ] `team-server/test/standalone.test.ts` 的边界测试仍通过，服务端没有新增对主项目的引用；
- [ ] 新增的写操作都有 prepare/execute 两步，`consume()` 在真正执行前调用；
- [ ] 任何新日志、错误信息、plan details 中没有 token、接入串、`Authorization`、个人笔记；
- [ ] 协议类型两份拷贝一致（阶段五之后由漂移测试保证）；
- [ ] 新接口的 role 判断与 `docs/team-handoff.md` 第 7 节表格一致；
- [ ] 404 与 403 的选择符合"不泄露记录存在性"原则；
- [ ] 审计事件覆盖了新增的每种写操作；
- [ ] 搜索/读取默认只返回 `team-approved`（阶段一之后）；
- [ ] 测试用真实 loopback 服务端而不是 mock 客户端；
- [ ] 文档三处（`team-handoff.md`、`team-knowledge-base.md`、`team-server/README.md`）同步；
- [ ] `docs/agent-tools.md` 由脚本重新生成而非手改（`npm run docs:tools:check` 通过）。

## 9. 评审与补强记录（2026-09-11）

五个阶段由实施方完成后，评审方复核并补强了以下内容，均已随同一批改动落地：

- **审核指纹收窄。** 实施方的 `reviewableContent()` 把 provenance、引用数、作者列表和全部链接都算作内容，导致第二个成员重复提案同一篇论文就会把已批准记录踢回待审。现在只比较规范化标题、规范化摘要、年份、规范化 identifiers 和 `pdf`/`artifact` 下载链接。
- **修订模型取代原地重置。** 已批准记录在内容变化时原样保留并继续对读者可见，变化写入 `revisions/{paperId}.json`，以 `teamReview.revision: true` 出现在 `GET /proposals`；批准即替换，拒绝或撤回即丢弃。这同时给了"更长者胜出"合并一个回退手段。
- **恢复 id 冲突守卫。** 实施方以"守卫会阻断所有重复提案"为由删除了它，实际只有无任何标识信号的记录会被误拦。现在守卫在两边都无标识信号时按规范化标题匹配，冲突返回 409，且整批提案在写入前预检。没有守卫时，贡献者只要复制搜索结果里的 id 就能把外来标题和下载链接合并进已批准记录（已用真实服务端复现）。
- **限速只针对认证失败。** 原实现按 IP 封锁全部请求，20 次错误 token 后有效 token 也返回 429，NAT 后一台配错的机器会锁掉整个实验室。
- **备份定时单元修复。** systemd 不通过 shell 执行 `ExecStart`，原来的 `$(cat …)` 不会被展开，定时备份必然 401；改为 `curl -H @header-file`，token 也不再出现在进程列表。
- **恢复脚本的"服务在运行"检测。** `.write.lock` 只在写入瞬间存在，无法作为服务存活信号；服务现在启动时写入 `{root}/.team-server.pid`，`restore.ts` 检查该进程是否存活。
- **撤回与"我的提案"按成员 id 匹配。** `teamReview.proposedById` 随提案写入，管理员改名不再影响撤回；旧记录回退到按名称匹配。
- **审计日志尾部读取。** `listAuditEvents()` 改为从文件尾部按 64 KiB 分块倒序读取，只解码完整行，不再整文件载入。
- **pull 逻辑合一。** 应用层与 Pi 工具共用 `src/team/application/team-pull.ts`，执行阶段不再重复请求团队服务器。
- 文档修正：交接文档中关于 `invite.ts` 的不实描述、错误码表新增 409、磁盘布局新增 `revisions/` 与 pid 文件。

未做的事项：Web 页面仍只有类型检查和构建验证，没有浏览器端人工点检；软字段（作者列表、venue、引用数）的合并不经审核直接生效，只能靠审计事件追溯。
