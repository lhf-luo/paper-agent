# Paper Agent 团队库开发交接

本文档面向后续只负责团队库开发的成员。目标是先建立正确的系统边界，再进入实现细节。只开发团队库时，不需要通读 Paper Agent 主项目的 Web、Agent、个人库或 PDF 工具代码。

相关文档：

- [团队知识库行为说明](team-knowledge-base.md)
- [独立团队服务器部署指南](../team-server/README.md)
- [系统总览](system-guide.md)

## 1. 一句话架构

`team-server/` 是一个可以单独复制和部署的 API 服务。Paper Agent 主项目只是它的 HTTP 客户端。

```text
Paper Agent Web / Agent / CLI
            |
            | HTTPS + Bearer Token + pateam1 access string
            v
team-server/
  presentation -> application -> domain
                         |
                         v
                  infrastructure
                         |
                         v
               JSON files + SHA-256 blobs
```

客户端和服务端之间唯一的稳定契约是 HTTP API、接入串和磁盘格式。服务端不能依赖主项目的代码、Agent、模型、个人库 SQLite、Poppler、Tesseract、PDF2zh 或 MinerU。

## 2. 系统职责

### 团队服务器负责

- 成员身份和 Bearer Token 认证；
- role 和 namespace 授权；
- 团队论文记录、PDF 版本和 Artifact blob 存储；
- 论文、派生记录和 Artifact manifest 的提案与审核；
- 审计事件；
- namespace 备份和恢复演练；
- IP 自签 HTTPS 和端口 `14713`。

### 主项目客户端负责

- 保存本地 `.paper-agent/team-access.json`；
- 解析 `pateam1.` 接入串；
- 通过 HTTPS 调用团队服务器；
- Web 团队页面、Agent 团队工具和成员管理界面；
- 将个人库记录脱敏后提交为团队提案。

### 明确不属于团队服务器

- Web UI；
- 模型调用和 Agent 推理；
- 个人库 `personal.sqlite`；
- PDF 阅读器、PDF 布局分析、OCR 和翻译；
- 搜索 Provider 的外部抓取；
- 多实例共享写存储。

`team-server/test/standalone.test.ts` 会检查服务端源码不能导入 `team-server/` 以外的相对路径。不要绕过这个边界。

## 3. 代码地图

| 目录 | 职责 | 修改时应先看 |
| --- | --- | --- |
| `team-server/src/index.ts` | 读取环境变量、TLS、监听和优雅关闭 | 运行配置、启动条件 |
| `team-server/src/presentation/` | HTTP 路由、认证前后顺序、权限判断、请求校验 | API 行为 |
| `team-server/src/application/` | 组合 namespace 服务和存储 | 服务装配 |
| `team-server/src/domain/` | 身份、role、namespace、论文身份和领域校验 | 不变量 |
| `team-server/src/infrastructure/` | 文件存储、Token 注册表、审计、备份和原子写 | 磁盘格式 |
| `team-server/src/protocol/` | 客户端/服务端数据契约和接入串编解码 | 兼容性 |
| `team-server/test/` | 独立复制、TLS、认证和持久化测试 | 变更验证 |

主项目中的客户端边界主要在：

- `src/team/domain/team-access.ts`
- `src/team/application/team-connection.ts`
- `src/team/application/team-corpus-client.ts`
- `src/team/infrastructure/team-http-transport.ts`
- `src/team/presentation/team-corpus-tools.ts`

这些文件用于理解服务端调用方，但不要把服务端逻辑移回主项目。

## 4. 启动和请求链

### 启动顺序

1. 必须设置 `PAPER_AGENT_TEAM_AUTH_FILE`。
2. 读取身份种子文件 `auth.json`。
3. 读取可选的 TLS 证书和私钥。
4. 默认端口为 `14713`。
5. 有 TLS 时默认绑定 `0.0.0.0`；没有 TLS 时只允许绑定 loopback。
6. 创建 `TeamTokenRegistry` 和按 namespace 延迟创建的 `TeamKnowledgeStore`。
7. 收到 `SIGTERM` 或 `SIGINT` 后停止接受新请求，并等待活动请求结束。

### 请求顺序

```text
health 例外
  -> Bearer Token 认证
  -> /v1/whoami 或管理员身份路由
  -> 解析 /v1/namespaces/{namespace}/...
  -> namespace 授权
  -> role 权限
  -> 请求体和资源校验
  -> application/store 操作
  -> 审计和 JSON/blob 响应
```

错误状态约定：

| 状态 | 含义 |
| --- | --- |
| `400` | 请求字段、namespace、年份、review 决策等不合法 |
| `401` | Token 缺失、无效、已撤销、被封禁或已过期 |
| `403` | Token 有效，但 role 或 namespace 权限不足 |
| `404` | 资源不存在 |
| `405` | 路由存在，但 HTTP 方法不允许 |
| `413` | 请求体或 blob 超过限制 |
| `500` | 未预期的服务端错误 |

## 5. 身份和权限

### 身份字段

身份注册表是 `_security/identities.json`，当前 schema version 为 `2`。每个身份包含：

```ts
{
  id: "u-...";                 // 稳定身份 ID
  name: string;                // 展示名称，要求唯一
  tokenSha256: string;         // 只保存 SHA-256
  roles: TeamRole[];
  namespaces: string[];
  createdAt?: string;
  rotatedAt?: string;
  revokedAt?: string;
  expiresAt?: string;
  bannedAt?: string;
  banReason?: string;
}
```

服务端永远不会持久化明文 Token。明文 Token 只在创建或轮换时返回一次。

### Role 矩阵

Role 不是层级继承关系，必须显式授予。`admin` 通过 `permits()` 隐含拥有全部能力。

| Role | 能力 |
| --- | --- |
| `reader` | 搜索、读取论文、读取已批准的派生记录和 Artifact、读取 blob、查看统计 |
| `contributor` | 提交论文、派生记录和 Artifact 提案，上传 blob |
| `reviewer` | 查看待审核提案，执行审核，读取审计事件 |
| `admin` | 全部能力，管理身份、namespace 和备份 |

普通成员必须至少有一个 namespace。`admin` 可以访问全部 namespace，普通成员只能访问 `namespaces[]` 中明确列出的 namespace。

实际使用中，成员通常需要组合角色：

- 只读成员：`reader`
- 提交成员：`reader,contributor`
- 审核成员：`reader,reviewer`

### 身份生命周期

- `create`：生成随机 Token 和稳定成员 ID；
- `rotate`：生成新 Token，同时可更新 role、namespace 和有效期，旧 Token 立即失效；
- `rename`：只修改展示名称；
- `ban`：临时禁止登录，解封后 Token 仍有效；
- `unban`：解除封禁；
- `revoke`：永久撤销当前 Token，解封不能恢复；
- `delete`：只能删除已经撤销的身份，不删除论文和审计记录。

当前管理员不能撤销、封禁、删除自己，也不能通过轮换取消自己的管理员权限。

## 6. 接入串

客户端使用的接入串格式为：

```text
pateam1.<Base64URL(JSON)>
```

解码后的字段：

```ts
{
  serverUrl: string;   // HTTPS origin
  namespace: string;   // 默认团队空间
  token: string;       // Bearer Token
  identity: string;    // 展示提示，授权以服务端响应为准
  caPem: string;       // 自签 CA 证书
}
```

接入串只是 Base64URL 编码，不是加密。任何拿到接入串的人都可以读取其中的 Token。不要把接入串写入审计、日志、Agent 会话或 Git。

客户端验证顺序：

1. 解析接入串；
2. 校验 CA 和服务器 origin；
3. 请求 `/health`；
4. 请求 `/v1/whoami`；
5. 检查默认 namespace 是否获授权；
6. 全部通过后原子写入 `.paper-agent/team-access.json`。

## 7. API 速查

除 `/health` 外，所有接口都需要：

```http
Authorization: Bearer <token>
```

### 公共和身份接口

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/health` | 无 | 服务和版本健康检查 |
| `GET` | `/v1/whoami` | 任意有效身份 | 返回当前公开身份，不返回 Token 哈希 |
| `GET` | `/v1/admin/identities` | `admin` | 列出身份 |
| `POST` | `/v1/admin/identities` | `admin` | 创建身份和新 Token |
| `POST` | `/v1/admin/identities/{id}/rotate` | `admin` | 轮换 Token，可更新授权 |
| `POST` | `/v1/admin/identities/{id}/revoke` | `admin` | 永久撤销 |
| `POST` | `/v1/admin/identities/{id}/rename` | `admin` | 改名 |
| `POST` | `/v1/admin/identities/{id}/ban` | `admin` | 封禁 |
| `POST` | `/v1/admin/identities/{id}/unban` | `admin` | 解封 |
| `POST` | `/v1/admin/identities/{id}/delete` | `admin` | 删除已撤销身份 |

### namespace 接口

以下路径都省略前缀 `/v1/namespaces/{namespace}`：

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/search` | `reader` | 分页搜索团队论文 |
| `GET` | `/papers/{paperId}` | `reader` | 读取一篇团队论文 |
| `GET` | `/proposals` | `reviewer` | 查看待审核论文 |
| `POST` | `/proposals` | `contributor` | 提交论文提案 |
| `POST` | `/reviews` | `reviewer` | 审核论文 |
| `GET` | `/derived` | `reader` 或 `reviewer` | 查看派生记录 |
| `POST` | `/derived` | `contributor` | 提交派生记录 |
| `POST` | `/derived/reviews` | `reviewer` | 审核派生记录 |
| `GET` | `/artifacts` | `reader` 或 `reviewer` | 查看 Artifact 记录 |
| `POST` | `/artifacts` | `contributor` | 提交 Artifact manifest |
| `POST` | `/artifacts/reviews` | `reviewer` | 审核 Artifact manifest |
| `PUT` | `/blobs/{sha256}` | `contributor` | 上传经 SHA-256 校验的 blob |
| `GET` | `/blobs/{sha256}` | `reader` | 下载 blob |
| `GET` | `/events` | `reviewer` | 读取 namespace 审计事件 |
| `GET` | `/stats` | `reader` | 读取统计 |
| `GET` | `/audit` | `reviewer` | 审计记录、provenance 和待审核状态 |
| `POST` | `/backups` | `admin` | 创建备份 |
| `POST` | `/backups/drill` | `admin` | 验证备份并执行恢复演练 |

搜索支持 `q`、`yearFrom`、`yearTo`、`author`、`venue`、`type`、`openAccess`、`cursor` 和 `limit`。当前 `cursor` 实际是数字 offset 的字符串。

## 8. 磁盘数据

默认数据根目录由 `PAPER_AGENT_TEAM_ROOT` 指定。实际结构：

```text
{PAPER_AGENT_TEAM_ROOT}/
  _security/
    identities.json
    token-audit.jsonl
  {namespace}/
    records/
      {paperId}.json
    paper-versions/
      {paperId}.json
    blobs/
      sha256/
        {first-two-hex}/{sha256}
    knowledge/
      derived/
        {key}.json
      artifacts/
        {paperId}.json
    events/
      audit.jsonl
    manifest.json
    .write.lock
```

`FileTeamLiteratureRepository.initialize()` 还会创建 `search-runs/`、`derived/`、`derived-history/`、`collections/`、`exports/` 和 `imports/`。当前团队服务的主要业务没有使用这些目录，后续如果启用，应先补充协议和迁移设计。

### 文件含义

- `records/{paperId}.json`：规范化的 `PaperRecord`。
- `paper-versions/{paperId}.json`：该论文的 `PaperVersion[]`。
- `blobs/sha256/...`：按内容寻址的 PDF 或其他二进制。
- `knowledge/derived/{key}.json`：派生记录和审核状态。
- `knowledge/artifacts/{paperId}.json`：Artifact manifest 和审核状态。
- `events/audit.jsonl`：namespace 级追加式审计日志。
- `manifest.json`：团队 corpus 的轻量统计清单。
- `_security/identities.json`：身份注册表，schema version 2。
- `_security/token-audit.jsonl`：身份和 Token 管理审计。

JSON 写入应先写临时文件，再原子 `rename`。论文存储还会使用 `.write.lock` 串行化写操作。一个数据根目录只能有一个写服务实例，不要把它挂到多个共享写入进程。

### 备份结构

备份由 `backup-manifest.json`、`namespace/`、`_security/identities.json` 和 `_security/token-audit.jsonl` 组成。manifest 记录每个文件的路径、字节数和 SHA-256。

恢复演练只验证备份和复制到临时目录，不会覆盖当前生产数据。真正的恢复需要由运维人员按部署文档执行。

## 9. 状态和不变量

### 审核状态

论文、派生记录和 Artifact manifest 使用同一组状态：

```text
team-proposed -> team-approved
              -> team-rejected
```

再次提交完全相同的内容时，已经审核过的状态会保留；只有内容指纹发生变化时才重新进入 `team-proposed`。

### 数据脱敏

论文提案在客户端和服务端都有防护：

- 客户端 `sanitizePaperRecordForTeamProposal()` 清空个人 `userNotes`；
- 服务端再次清空 `userNotes`，不使用客户端传入的个人备注；
- Artifact manifest 会移除本地绝对路径、保留元数据文件名和有限长度的来源上下文。

不要为了“方便调试”把个人路径、Token、提示词或私人笔记写入团队文件。

### 写入一致性

- `writeJsonAtomic()` 负责 JSON 原子替换。
- `FileTeamLiteratureRepository` 使用文件锁避免并发论文写入。
- `TeamKnowledgeStore` 内部还有写入和审计串行链。
- blob 通过内容 SHA-256 寻址，上传内容必须与路径哈希一致。
- 业务文件和审计是分开的文件，当前不是跨文件事务。审计追加失败时，业务数据可能已经写入，交接后新增流程时要考虑补偿语义。

## 10. 本地开发

要求 Node.js 24 或更高版本。运行时不需要安装 npm 依赖，因为服务端使用 Node.js 内置模块和原生 `.ts` 执行。

在 `team-server/` 内运行：

```bash
npm install
npm run typecheck
npm test
```

从仓库根目录运行：

```bash
npm run typecheck:team-server
npm run test:team-server
```

### 生成测试身份

```bash
node team-server/src/hash-token.ts
```

输出包含明文 Token 和 `tokenSha256`。创建测试 `auth.json`：

```json
{
  "identities": [
    {
      "name": "admin",
      "tokenSha256": "填写上一步生成的 SHA-256",
      "roles": ["admin"],
      "namespaces": []
    }
  ]
}
```

### 启动无 TLS 的本地服务

明文 HTTP 只能绑定 loopback。下面的变量在 PowerShell 和 Bash 中语法不同，按当前 shell 设置：

```text
PAPER_AGENT_TEAM_AUTH_FILE=<auth.json>
PAPER_AGENT_TEAM_ROOT=<test-data-root>
PAPER_AGENT_TEAM_BACKUP_ROOT=<test-backup-root>
PAPER_AGENT_TEAM_HOST=127.0.0.1
PAPER_AGENT_TEAM_PORT=14713
```

然后启动：

```bash
node team-server/src/index.ts
```

健康检查：

```bash
curl http://127.0.0.1:14713/health
```

### 关键环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PAPER_AGENT_TEAM_AUTH_FILE` | 无 | 必填，首次启动身份种子 |
| `PAPER_AGENT_TEAM_ROOT` | `.paper-agent/team-server` | 数据和身份注册表根目录 |
| `PAPER_AGENT_TEAM_BACKUP_ROOT` | 无 | 备份目标根目录 |
| `PAPER_AGENT_TEAM_IDENTITY_STORE` | `{root}/_security/identities.json` | 覆盖身份注册表位置 |
| `PAPER_AGENT_TEAM_MAX_BODY_BYTES` | `8388608` | JSON 请求体上限 |
| `PAPER_AGENT_TEAM_MAX_BLOB_BYTES` | `209715200` | blob 上限 |
| `PAPER_AGENT_TEAM_TLS_CERT_FILE` | 无 | TLS 证书，和私钥必须同时设置 |
| `PAPER_AGENT_TEAM_TLS_KEY_FILE` | 无 | TLS 私钥 |
| `PAPER_AGENT_TEAM_HOST` | TLS 时为 `0.0.0.0` | 监听地址 |
| `PAPER_AGENT_TEAM_PORT` | `14713` | 监听端口 |

## 11. 修改指南

### 新增身份字段

1. 修改 `domain/team-identity.ts` 和注册表 normalize 逻辑。
2. 决定旧注册表缺少字段时的默认行为。
3. 更新 `infrastructure/team-token-registry.ts` 的 schema version 和迁移。
4. 更新公开身份类型，确保不会泄露 Token 哈希。
5. 更新备份校验和恢复演练测试。

### 新增 API

1. 先在 `protocol/` 定义请求和响应类型。
2. 在 `presentation/` 添加 route、role 和 namespace 检查。
3. 在 application 或 store 中实现业务操作。
4. 增加服务端独立测试。
5. 如果客户端也需要调用，同步更新主项目 `src/team/`，并增加兼容性测试。

### 修改磁盘格式

优先采用向后兼容的增量字段。需要破坏性变化时：

1. 提供显式 schema version；
2. 写迁移前备份；
3. 保留旧文件读取路径；
4. 增加“旧数据启动”测试；
5. 确认服务端可独立复制后启动。

### 修改协议

服务端协议和主项目客户端类型目前不是自动生成的。任何请求体、响应体、接入串或错误语义变化，都必须同时检查：

- `team-server/src/protocol/`
- `src/team/domain/`
- `src/team/application/team-corpus-client.ts`
- `src/team/presentation/team-corpus-tools.ts`

不要只改服务端再假定旧客户端仍能工作。

## 12. 当前已知风险

接手后建议优先确认以下事项：

1. `searchPapers()` 当前没有按 `curation.teamReview.status` 过滤。产品说明期望读者主要看到已批准内容，但代码会搜索到待审核或已拒绝的论文记录。若该行为不是有意设计，应修复并增加测试。
2. `GET /papers/{paperId}` 同样没有审核状态过滤。
3. 团队搜索是逐个读取 JSON 后在内存中打分，不是数据库查询。记录数增长后需要索引或分页优化。
4. JSON 和 blob 请求会完整读入内存。当前限制分别是默认 8 MiB 和 200 MiB。
5. 业务写入和审计追加不是同一个事务，审计失败可能留下已写入业务数据。
6. 当前没有数据库迁移框架，依赖 schema version、备份和兼容读取。
7. 服务设计为单实例写入。不要在没有重新设计锁、审计和备份的情况下部署多个写实例。
8. 团队服务器可以直接复制运行，但协议兼容性仍由服务端和主项目两边共同维护。

## 13. 推荐阅读顺序

1. 本文档；
2. `team-server/src/protocol/team-access.ts`；
3. `team-server/src/protocol/team-corpus-types.ts`；
4. `team-server/src/domain/team-identity.ts`；
5. `team-server/src/presentation/team-corpus-server.ts`；
6. `team-server/src/infrastructure/team-token-registry.ts`；
7. `team-server/src/infrastructure/file-team-literature-repository.ts`；
8. `team-server/src/infrastructure/team-knowledge-store.ts`；
9. `team-server/src/infrastructure/team-backup.ts`；
10. `team-server/test/standalone.test.ts`。

完成阅读后，接手者应该能够回答三个问题：

- 一次客户端请求经过哪些认证、授权和存储步骤？
- 新增一个字段或 API 需要同时修改哪些层和兼容边界？
- 哪些数据可以安全地写入磁盘，哪些内容必须脱敏或永远不能持久化？
