# Paper Agent 独立团队服务器部署指南

本文档说明如何把 `team-server/` 单独部署到 Linux 服务器。部署完成后，团队成员只需在自己的 Paper Agent 中粘贴一条 `pateam1.` 接入串，不需要手工填写服务器地址、Token、CA 或 namespace。

开发团队库前，请先阅读[团队库开发交接文档](../docs/team-handoff.md)。

团队服务器提供团队论文、PDF、Artifact 和派生知识存储，以及成员认证、namespace 授权、提议审核、审计和备份。它不包含模型、Agent、Web UI、个人库 SQLite、PDF 阅读器、Poppler、Tesseract、PDF2zh 或 MinerU。

## 1. 部署参数

以下示例使用这些值，请按实际环境替换：

| 参数 | 示例 | 说明 |
| --- | --- | --- |
| 服务器 IP | `203.0.113.10` | 客户端实际访问的稳定 IP |
| HTTPS 端口 | `14713` | 团队服务端口 |
| 初始 namespace | `lab` | 第一个团队空间 |
| 服务目录 | `/opt/paper-agent-team` | 服务端代码 |
| 配置目录 | `/etc/paper-agent-team` | 身份种子、环境配置和 TLS 文件 |
| 数据目录 | `/var/lib/paper-agent-team` | 团队数据和正式身份注册表 |
| 备份目录 | `/var/back/paper-agent-team` | 服务端备份 |

`14713` 是团队服务器端口。Paper Agent 本地 Web/浏览器扩展使用的 `43127` 是另一项服务，不要混用。

## 2. 运行要求

- Linux 服务器，以下命令以 Ubuntu/Debian 为例；
- 使用 `root` 账户部署和运行服务；
- Node.js 24 或更高版本；
- 首次生成证书时需要 OpenSSL；
- 服务器 IP 对成员电脑可达；
- 一个数据目录只能由一个团队服务实例使用。

安装基础工具：

```bash
sudo apt update
sudo apt install -y ca-certificates curl openssl
```

确认 Node.js：

```bash
node --version
command -v node
```

如果没有 Node.js 24，可使用系统支持的安装方式；Ubuntu/Debian 也可使用 NodeSource：

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node --version
```

systemd 默认调用 `/usr/bin/node`。如果 `command -v node` 返回其他路径，后面需要同步修改 service 文件中的 `ExecStartPre` 和 `ExecStart`。

## 3. 复制独立服务端

在 Paper Agent 项目根目录执行：

```bash
scp -r team-server your-user@203.0.113.10:/tmp/paper-agent-team
ssh your-user@203.0.113.10
```

以下步骤按 root 部署。登录后可先进入 root shell：

```bash
sudo -i

mkdir -p \
  /opt/paper-agent-team \
  /etc/paper-agent-team/tls \
  /var/lib/paper-agent-team \
  /var/back/paper-agent-team

cp -a /tmp/paper-agent-team/. /opt/paper-agent-team/
chown -R root:root \
  /opt/paper-agent-team \
  /etc/paper-agent-team \
  /var/lib/paper-agent-team \
  /var/back/paper-agent-team
```

进入 root shell 后，文档后续命令中的 `sudo` 可以直接省略；保留它们只是为了命令也能从普通管理账户执行。

运行服务不需要执行 `npm install`，因为运行时代码只使用 Node.js 内置模块。只有在服务器上运行类型检查和测试时才需要开发依赖。

确认文件完整：

```bash
test -f /opt/paper-agent-team/src/index.ts
test -f /opt/paper-agent-team/src/invite.ts
test -f /opt/paper-agent-team/deployment/paper-agent-team.service
```

## 4. 生成 IP 自签 HTTPS 证书

团队服务直接使用 Node.js HTTPS，不需要域名、Caddy 或 Nginx。将示例 IP 替换成服务器真实 IP：

```bash
sudo bash /opt/paper-agent-team/deployment/generate-ip-certificate.sh \
  203.0.113.10 \
  /etc/paper-agent-team/tls
```

设置权限：

```bash
sudo chown root:root /etc/paper-agent-team/tls/ca.key
sudo chown root:root /etc/paper-agent-team/tls/server.key
sudo chown root:root \
  /etc/paper-agent-team/tls/ca.crt \
  /etc/paper-agent-team/tls/server.crt

sudo chmod 600 /etc/paper-agent-team/tls/ca.key
sudo chmod 600 /etc/paper-agent-team/tls/server.key
sudo chmod 644 \
  /etc/paper-agent-team/tls/ca.crt \
  /etc/paper-agent-team/tls/server.crt
```

| 文件 | 用途 | 是否发送给客户端 |
| --- | --- | --- |
| `ca.key` | 私有 CA 私钥 | 绝对不要 |
| `ca.crt` | 私有 CA 公钥证书 | 编码到接入串 |
| `server.key` | HTTPS 私钥 | 绝对不要 |
| `server.crt` | 带服务器 IP SAN 的证书 | 无需单独发送 |

检查证书 IP：

```bash
openssl x509 \
  -in /etc/paper-agent-team/tls/server.crt \
  -noout -subject -issuer -ext subjectAltName
```

输出中应包含 `IP Address:203.0.113.10`。

## 5. 创建初始管理员

生成管理员 Token 和 SHA-256：

```bash
cd /opt/paper-agent-team
sudo node src/hash-token.ts | sudo tee /root/paper-agent-team-admin.json >/dev/null
sudo chmod 600 /root/paper-agent-team-admin.json
sudo cat /root/paper-agent-team-admin.json
```

输出格式：

```json
{
  "token": "只显示和保存一次的管理员明文Token",
  "tokenSha256": "64位SHA-256"
}
```

创建身份种子：

```bash
sudo cp /opt/paper-agent-team/config/auth.example.json \
  /etc/paper-agent-team/auth.json
sudo nano /etc/paper-agent-team/auth.json
```

填写为：

```json
{
  "identities": [
    {
      "name": "team-admin",
      "tokenSha256": "在这里填写64位tokenSha256",
      "roles": ["admin"],
      "namespaces": []
    }
  ]
}
```

把明文 Token 单独写入仅 root 可读的文件，供生成接入串和成员邀请：

```bash
sudo node -e '
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync("/root/paper-agent-team-admin.json", "utf8"));
fs.writeFileSync("/root/paper-agent-team-admin.token", value.token + "\n", { mode: 0o600 });
'

sudo chmod 600 \
  /etc/paper-agent-team/auth.json \
  /root/paper-agent-team-admin.token
```

`auth.json` 是首次启动的身份种子。首次启动后，正式身份注册表位于 `/var/lib/paper-agent-team/_security/identities.json`，其中只保存 Token 哈希。

## 6. 配置服务

```bash
sudo cp /opt/paper-agent-team/deployment/team-server.env.example \
  /etc/paper-agent-team/team-server.env
sudo nano /etc/paper-agent-team/team-server.env
```

完整配置：

```ini
PAPER_AGENT_TEAM_AUTH_FILE=/etc/paper-agent-team/auth.json
PAPER_AGENT_TEAM_ROOT=/var/lib/paper-agent-team
PAPER_AGENT_TEAM_BACKUP_ROOT=/var/back/paper-agent-team
PAPER_AGENT_TEAM_HOST=0.0.0.0
PAPER_AGENT_TEAM_PORT=14713
PAPER_AGENT_TEAM_MAX_BODY_BYTES=8388608
PAPER_AGENT_TEAM_MAX_BLOB_BYTES=209715200
PAPER_AGENT_TEAM_TLS_CERT_FILE=/etc/paper-agent-team/tls/server.crt
PAPER_AGENT_TEAM_TLS_KEY_FILE=/etc/paper-agent-team/tls/server.key
PAPER_AGENT_TEAM_PUBLIC_URL=https://203.0.113.10:14713
```

```bash
sudo chown root:root /etc/paper-agent-team/team-server.env
sudo chmod 600 /etc/paper-agent-team/team-server.env
```

规则：

- `0.0.0.0` 表示监听全部网卡；
- 对外监听必须配置 TLS 证书和私钥；
- 未配置 TLS 时只允许绑定 `127.0.0.1` 或 `::1`；
- `PAPER_AGENT_TEAM_MAX_BLOB_BYTES` 默认允许单个 PDF/Artifact blob 最大 200 MB。

## 7. 安装并启动 systemd

```bash
sudo cp /opt/paper-agent-team/deployment/paper-agent-team.service \
  /etc/systemd/system/paper-agent-team.service
```

检查 Node 路径：

```bash
command -v node
grep -n 'ExecStart' /etc/systemd/system/paper-agent-team.service
```

如果 Node 不在 `/usr/bin/node`，编辑 service 文件并修改两处 Node 绝对路径：

```bash
sudo systemctl edit --full paper-agent-team
```

启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now paper-agent-team
sudo systemctl status paper-agent-team --no-pager
sudo journalctl -u paper-agent-team -n 100 --no-pager
sudo ss -lntp | grep 14713
```

正常日志包含：

```text
Paper Agent team server listening at https://0.0.0.0:14713
```

## 8. 开放端口

使用 UFW 时：

```bash
sudo ufw allow 14713/tcp
sudo ufw status
```

云服务器还需要在安全组中允许入站 TCP `14713`。建议只允许团队成员所在的公网 IP 或内网网段。不需要开放客户端本地 Web 端口 `43127`。

## 9. 验证服务

服务器本机验证 HTTPS：

```bash
curl --fail --show-error \
  --cacert /etc/paper-agent-team/tls/ca.crt \
  https://203.0.113.10:14713/health
```

预期结果：

```json
{"ok":true,"service":"paper-agent-team-corpus","version":2}
```

验证管理员身份：

```bash
ADMIN_TOKEN="$(sudo cat /root/paper-agent-team-admin.token)"

curl --fail --show-error \
  --cacert /etc/paper-agent-team/tls/ca.crt \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  https://203.0.113.10:14713/v1/whoami

unset ADMIN_TOKEN
```

返回身份应包含 `admin` 角色。从管理员电脑也应使用 `ca.crt` 验证 `/health`；服务器本机成功而远程失败通常说明云安全组、防火墙、NAT 或路由有问题。

## 10. 生成管理员接入串

```bash
cd /opt/paper-agent-team

sudo node src/invite.ts \
  --existing \
  --url https://203.0.113.10:14713 \
  --connect-host 127.0.0.1 \
  --namespace lab \
  --token-file /root/paper-agent-team-admin.token \
  --ca-file /etc/paper-agent-team/tls/ca.crt
```

命令输出一整行以 `pateam1.` 开头的接入串。

在管理员电脑上：

1. 启动 Paper Agent；
2. 打开“设置与诊断”；
3. 找到“团队接入”；
4. 粘贴完整接入串；
5. 点击“验证并接入”；
6. 打开“团队知识库”确认管理员身份。

客户端会验证接入串、自签 CA、`/health`、`/v1/whoami` 和 namespace 权限。全部通过后才会写入 Git 已忽略的 `.paper-agent/team-access.json`。

接入串包含服务器地址、namespace、身份提示、Bearer Token 和 `ca.crt`。它只是 Base64URL 编码，不是加密内容，应按密码保管。

## 11. 邀请成员

管理员可以在 Paper Agent 团队页面创建成员，也可以在服务器执行：

```bash
cd /opt/paper-agent-team

sudo node src/invite.ts \
  --url https://203.0.113.10:14713 \
  --connect-host 127.0.0.1 \
  --name alice \
  --roles reader,contributor \
  --namespace lab \
  --namespaces lab \
  --token-file /root/paper-agent-team-admin.token \
  --ca-file /etc/paper-agent-team/tls/ca.crt
```

授权多个空间：

```bash
sudo node /opt/paper-agent-team/src/invite.ts \
  --url https://203.0.113.10:14713 \
  --connect-host 127.0.0.1 \
  --name bob \
  --roles reader,contributor,reviewer \
  --namespace lab \
  --namespaces lab,security,compiler \
  --token-file /root/paper-agent-team-admin.token \
  --ca-file /etc/paper-agent-team/tls/ca.crt
```

创建 90 天后过期的成员：

```bash
sudo node /opt/paper-agent-team/src/invite.ts \
  --url https://203.0.113.10:14713 \
  --connect-host 127.0.0.1 \
  --name temporary-reviewer \
  --roles reader,reviewer \
  --namespace lab \
  --namespaces lab \
  --expires-days 90 \
  --token-file /root/paper-agent-team-admin.token \
  --ca-file /etc/paper-agent-team/tls/ca.crt
```

| 角色 | 权限 |
| --- | --- |
| `reader` | 搜索和读取已批准的团队内容 |
| `contributor` | 提交论文、PDF、Artifact 和派生内容提议 |
| `reviewer` | 审核或拒绝提议，读取审计事件 |
| `admin` | 管理全部 namespace、成员、备份和管理操作 |

普通成员必须至少有一个 namespace。角色不互相隐式包含，需要“读取并提交”时应同时授予 `reader,contributor`。

同名成员已存在时，命令会轮换其 Token，并更新角色、namespace 和有效期；旧 Token 立即失效。接入串只输出一次。

## 12. 成员状态

管理员可在 Paper Agent 中创建、轮换、改名、封禁、解封、撤销和删除成员。

- **轮换**：生成新 Token，旧 Token 永久失效；
- **封禁**：临时禁止登录，解封后当前有效 Token 可继续使用；
- **撤销**：当前 Token 永久失效，不能通过解封恢复；
- **删除**：只能删除已撤销身份，不删除其论文或审计记录；
- **过期**：到达 `expiresAt` 后认证返回 `401`。

服务端禁止当前管理员撤销、封禁、删除自己或取消自身管理员权限。

## 13. 日常运维

```bash
# 状态和日志
sudo systemctl status paper-agent-team --no-pager
sudo journalctl -u paper-agent-team -f
sudo journalctl -u paper-agent-team -n 200 --no-pager

# 停止、启动、重启
sudo systemctl stop paper-agent-team
sudo systemctl start paper-agent-team
sudo systemctl restart paper-agent-team

# 开机启动
sudo systemctl disable paper-agent-team
sudo systemctl enable paper-agent-team

# 磁盘占用
sudo du -sh /var/lib/paper-agent-team
sudo du -sh /var/back/paper-agent-team
```

## 14. 数据与备份

```text
/var/lib/paper-agent-team/
  _security/
    identities.json
  {namespace}/
    records/
    paper-versions/
    blobs/sha256/
    knowledge/derived/
    knowledge/artifacts/
    events/audit.jsonl
    manifest.json
```

建议定期：

1. 使用管理员页面创建一致性备份；
2. 把 `/var/back/paper-agent-team` 复制到其他磁盘或主机；
3. 离线备份 `/etc/paper-agent-team`；
4. 加密离线保存 `ca.key`；
5. 执行恢复演练验证备份。

做完整文件级备份时先停止服务：

```bash
sudo systemctl stop paper-agent-team
sudo tar -C / -czf /root/paper-agent-team-data-$(date +%F).tar.gz \
  var/lib/paper-agent-team \
  etc/paper-agent-team
sudo systemctl start paper-agent-team
```

## 15. 升级

```bash
sudo systemctl stop paper-agent-team
sudo cp -a /opt/paper-agent-team /opt/paper-agent-team.previous
sudo tar -C / -czf /root/paper-agent-team-before-upgrade-$(date +%F-%H%M).tar.gz \
  var/lib/paper-agent-team \
  etc/paper-agent-team

sudo rm -rf /opt/paper-agent-team.new
sudo mkdir /opt/paper-agent-team.new
sudo cp -a /tmp/new-team-server/. /opt/paper-agent-team.new/
sudo chown -R root:root /opt/paper-agent-team.new
sudo mv /opt/paper-agent-team /opt/paper-agent-team.old
sudo mv /opt/paper-agent-team.new /opt/paper-agent-team

sudo systemctl daemon-reload
sudo systemctl start paper-agent-team
sudo systemctl status paper-agent-team --no-pager
```

升级后重新检查 `/health`。只要服务器 IP、端口、CA 和成员 Token 未改变，客户端接入串无需更新。

## 16. IP 和证书变化

- 仅服务器证书到期：使用原 `ca.key` 为相同 IP 签发新证书，客户端可继续使用旧接入串；
- 更换服务器 IP：重新签发包含新 IP SAN 的证书，并生成包含新 URL 的接入串；
- 更换 CA：所有旧接入串失效，管理员和成员都需要新接入串。

修改证书后：

```bash
sudo systemctl restart paper-agent-team
sudo journalctl -u paper-agent-team -n 100 --no-pager
```

## 17. 常见故障

### 公网 HTTP 被拒绝

服务绑定 `0.0.0.0` 时必须配置 TLS：

```bash
sudo grep PAPER_AGENT_TEAM_TLS /etc/paper-agent-team/team-server.env
sudo test -r /etc/paper-agent-team/tls/server.crt
sudo test -r /etc/paper-agent-team/tls/server.key
```

### `EADDRINUSE`

```bash
sudo ss -lntp | grep 14713
sudo systemctl status paper-agent-team --no-pager
```

不要同时手工运行 `node src/index.ts` 和 systemd 服务。

### 证书错误

检查证书 SAN、接入串 URL 和 CA 是否一致：

```bash
openssl x509 \
  -in /etc/paper-agent-team/tls/server.crt \
  -noout -ext subjectAltName
```

使用主机名访问只包含 IP SAN 的证书、重新生成 CA 后继续使用旧接入串，都会导致验证失败。

### HTTP `401`

Token 无效、已轮换、已撤销、成员被封禁或身份已过期。管理员应检查成员状态，必要时轮换 Token 并发送新接入串。

### HTTP `403`

身份有效，但缺少操作所需角色，或没有当前 namespace 权限。

### 本机可访问，其他电脑无法访问

```bash
sudo ss -lntp | grep 14713
sudo ufw status
ip address
```

继续检查云安全组、路由器端口映射、校园/公司防火墙和客户端路由。

### Node.js 路径错误

```bash
node --version
command -v node
systemctl cat paper-agent-team
```

如果 Node 不在 `/usr/bin/node`，修改 service 文件中的两处绝对路径。

### 数据目录权限错误

```bash
sudo chown -R root:root \
  /var/lib/paper-agent-team \
  /var/back/paper-agent-team
sudo systemctl restart paper-agent-team
```

## 18. 本机无 TLS 测试

明文 HTTP 只允许 loopback：

```bash
cd /opt/paper-agent-team

export PAPER_AGENT_TEAM_AUTH_FILE=/etc/paper-agent-team/auth.json
export PAPER_AGENT_TEAM_ROOT=/tmp/paper-agent-team-test
export PAPER_AGENT_TEAM_BACKUP_ROOT=/tmp/paper-agent-team-test-backups
export PAPER_AGENT_TEAM_HOST=127.0.0.1
export PAPER_AGENT_TEAM_PORT=14713

node src/index.ts
```

另一个终端：

```bash
curl http://127.0.0.1:14713/health
```

不要把无 TLS 模式暴露到局域网或公网。

## 19. 可选测试

```bash
cd /opt/paper-agent-team
npm install
npm run typecheck
npm test
```

这些命令只用于开发和验收，正式运行不依赖 `node_modules`。

## 20. 完成检查清单

- [ ] Node.js 为 24 或更高版本；
- [ ] `team-server/` 已完整复制；
- [ ] 证书包含正确的服务器 IP SAN；
- [ ] `ca.key` 和 `server.key` 未发送给客户端；
- [ ] `auth.json` 只包含 Token SHA-256；
- [ ] 服务、数据和备份目录由 root 管理；
- [ ] systemd 服务为 `active (running)`；
- [ ] `14713/tcp` 已在系统防火墙和云安全组开放；
- [ ] 使用 `--cacert` 访问 `/health` 成功；
- [ ] 管理员 Token 访问 `/v1/whoami` 成功；
- [ ] 管理员 `pateam1.` 接入串已在客户端验证；
- [ ] 普通成员只有所需角色和 namespace；
- [ ] 已建立异地备份并完成恢复演练。
