# 失败诊断包：安全远端交接（方案 A）

本文档描述 `dsh-ssh-tui` 的**元数据-only** 失败诊断包如何通过私有 mTLS 端点上传、下载并校验。实现默认关闭；未显式启用时**不读取 endpoint、不联网、不写远端包**。

> 设计边界：远端包只含固定枚举/数字/版本/哈希，**不含** screen、transcript、session id、原始错误文本、路径、用户名或凭据。本地原有诊断目录不变，仍然只在本机。

## 1. 安全模型（Owner 硬约束对照）

| 约束 | 实现 |
|---|---|
| 发送端家宽动态 IP | 只有**发送端主动出站**；客户端代码没有任何 `listen`/server socket。接收端身份由证书/签名保证，不做客户端 IP 白名单。 |
| 禁止 80/443 | 端口必须 `>= 1024` 且不能是 80/443；默认示例 `18443`。 |
| TLS 1.3 | 客户端 `minVersion=maxVersion=TLSv1.3`，`rejectUnauthorized=true`。 |
| 双向认证 | 客户端证书 + 服务端 CA 校验；服务端 `requestCert` + CA 校验；双方 SPKI SHA-256 pin。 |
| 防重放 | 每次请求带随机 nonce + 毫秒时间戳 + Ed25519 签名；接收端 nonce 缓存（5 分钟）与时间窗校验。重放 nonce、过期 timestamp/token 固定返回 `AUTH_REPLAY_REFUSED`（真实 401，客户端 terminal、不重试）。 |
| 一次性会话令牌 | `POST /v1/session` 经 mTLS 签发短时 token，绑定 operation/bundleId/客户端 SPKI；upload token 在 finalize 后消费，download token 每请求一枚。token 只在内存/请求头，不进 URL。 |
| 内容保护 | 归档用 X25519 + HKDF-SHA256 + AES-256-GCM 信封加密（接收端公钥）；manifest 用 Ed25519 签名；信封头再用同一发送端 Ed25519 私钥签名，绑定实际 `ciphertextSha256` 与 `manifestSha256`，避免 manifest/envelope 循环；接收端校验双签名、独立 envelope digest、归档 SHA-256、长度、逐文件 SHA-256。 |
| 默认非公网 | endpoint 解析结果必须是 loopback/私网/link-local；公网地址默认 `PUBLIC_ENDPOINT_REFUSED`，只有显式 `allowPublicEndpoint=true` 才允许。 |
| 凭据卫生 | 证书/私钥/令牌只从 `0600` 文件或环境变量读取；配置样例不含 token；日志/回执只出现哈希化 endpoint id 和固定错误类。 |
| 域名/Cloudflare | 不需要域名或 CF；实现只用 host + 端口 + 证书/pin。确实需要域名/CF 时应 STOP 请求 Owner，不得自行接入。 |

## 2. 配置

配置来源优先级：环境变量 > `$DSH_HOME/tui-diagnostics/config.json` 的字段。`enabled` 默认 `false`；`DSH_DIAGNOSTICS_UPLOAD=1` 是显式 opt-in，`=0` 强制关闭。

### 2.1 配置文件样例（脱敏，无 token）

```json
{
  "enabled": true,
  "host": "diag.internal.example",
  "port": 18443,
  "caFile": "/etc/dsh-diag/ca.crt",
  "certFile": "/etc/dsh-diag/client.crt",
  "keyFile": "/etc/dsh-diag/client.key",
  "clientEd25519KeyFile": "/etc/dsh-diag/client-ed25519.key",
  "clientEd25519PublicKey": "<base64 raw 32-byte sender Ed25519 public key>",
  "serverSpkiSha256": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "serverEd25519PublicKey": "<base64 raw 32-byte Ed25519 public key>",
  "recipientX25519PublicKey": "<base64 raw 32-byte X25519 public key>",
  "maxBundleBytes": 33554432,
  "maxFileBytes": 262144,
  "maxTotalBytes": 1048576,
  "timeoutMs": 10000,
  "maxAttempts": 5,
  "maxSpoolEntries": 64,
  "maxSpoolBytes": 268435456,
  "allowPublicEndpoint": false
}
```

可选字段：

- `serverName`：SNI/证书主机名（默认取 `host`）。
- `clientSpkiSha256`：客户端 SPKI pin（接收端配置使用；发送端不需要）。
- `clientEd25519PublicKey`：发送端 manifest/envelope 签名公钥。`fetch`/审核方只读持有该公钥即可验签；请求鉴权仍用自己的 mTLS + Ed25519 请求私钥，两者可分离。
- `recipientX25519PrivateKeyFile`：接收端/`fetch` 校验用的 X25519 私钥；发送端不需要。
- `maxSpoolEntries` / `maxSpoolBytes`：spool 与 verified 的条数/字节硬上限（默认 64 / 256 MiB）；spool 满时 fail closed（`SPOOL_FAILED`），不静默丢弃原始失败。
- `spoolDir` / `verifiedDir`：默认 `$DSH_HOME/tui-diagnostics/{spool,verified}`。

所有 `caFile`/`certFile`/`keyFile`/Ed25519/X25519 文件必须是普通文件且 mode `0600`（Windows 上 mode 是 advisory，使用用户 ACL 或环境变量）。配置文件本身只放路径与公开 pin，不放 token/私钥。

### 2.2 环境变量

| 变量 | 说明 |
|---|---|
| `DSH_DIAGNOSTICS_UPLOAD` | `1`/`true` 启用；`0`/`false` 强制关闭 |
| `DSH_DIAGNOSTICS_CONFIG` | 配置文件路径（默认 `$DSH_HOME/tui-diagnostics/config.json`） |
| `DSH_DIAGNOSTICS_HOST` / `_PORT` | endpoint host / 端口（默认 18443） |
| `DSH_DIAGNOSTICS_CA_FILE` / `_CERT_FILE` / `_KEY_FILE` | mTLS 材料文件（0600） |
| `DSH_DIAGNOSTICS_CA_PEM` / `_CERT_PEM` / `_KEY_PEM` | 等价的内联 PEM（CI secret 场景） |
| `DSH_DIAGNOSTICS_CLIENT_ED25519_KEY_FILE` / `_PEM` | 请求/manifest 签名私钥 |
| `DSH_DIAGNOSTICS_CLIENT_ED25519_PUBLIC_KEY` | 发送端 manifest/envelope 验签公钥（raw base64 或 PEM；`fetch` 可只读持有） |
| `DSH_DIAGNOSTICS_SERVER_SPKI` | 服务端 SPKI SHA-256（hex，可带 `sha256:`） |
| `DSH_DIAGNOSTICS_CLIENT_SPKI` | 客户端 SPKI pin（接收端） |
| `DSH_DIAGNOSTICS_SERVER_ED25519_PUBLIC_KEY` | 服务端 session 响应签名公钥（raw base64 或 PEM） |
| `DSH_DIAGNOSTICS_RECIPIENT_X25519_PUBLIC_KEY` | 信封加密接收端公钥 |
| `DSH_DIAGNOSTICS_RECIPIENT_X25519_PRIVATE_KEY_FILE` / `_PEM` | 接收端/`fetch` 校验私钥（可选） |
| `DSH_DIAGNOSTICS_MAX_BUNDLE_BYTES` / `_MAX_FILE_BYTES` / `_MAX_TOTAL_BYTES` | 大小上限 |
| `DSH_DIAGNOSTICS_TIMEOUT_MS` / `_MAX_ATTEMPTS` | 超时与尝试次数 |
| `DSH_DIAGNOSTICS_MAX_SPOOL_ENTRIES` / `_MAX_SPOOL_BYTES` | spool/verified 条数与字节硬上限 |
| `DSH_DIAGNOSTICS_ALLOW_PUBLIC_ENDPOINT` | 显式允许公网 endpoint（默认拒绝） |
| `DSH_DIAGNOSTICS_SPOOL_DIR` / `_VERIFIED_DIR` | 本地 spool / verified 路径 |
| `DSH_TUI_COMMIT` | 回执/manifest 中的 source SHA（可选） |

## 3. 证书与 pin（openssl 示例）

以下命令在**接收端**生成；私钥不进入仓库、不进入 argv、不打印。

```bash
# CA
openssl ecparam -name prime256v1 -genkey -noout -out ca.key
chmod 600 ca.key
openssl req -x509 -new -key ca.key -sha256 -days 3650 \
  -subj '/CN=dsh-diag-ca' -out ca.crt

# 服务端证书（SAN 按实际 host/IP 修改）
openssl ecparam -name prime256v1 -genkey -noout -out server.key
chmod 600 server.key
openssl req -new -key server.key -subj '/CN=diag.internal.example' -out server.csr
printf 'subjectAltName=DNS:diag.internal.example,IP:10.20.30.40\nextendedKeyUsage=serverAuth\n' > server.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -days 3650 -sha256 -extfile server.ext -out server.crt

# 客户端证书
openssl ecparam -name prime256v1 -genkey -noout -out client.key
chmod 600 client.key
openssl req -new -key client.key -subj '/CN=dsh-diag-client' -out client.csr
printf 'extendedKeyUsage=clientAuth\n' > client.ext
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -days 3650 -sha256 -extfile client.ext -out client.crt

# 配置加载器按策略要求证书也是 0600（证书是公开材料，但统一权限）
chmod 600 ca.crt server.crt client.crt

# SPKI pin（hex）
openssl x509 -in server.crt -pubkey -noout \
  | openssl pkey -pubin -outform der | sha256sum

# 客户端请求/manifest 签名密钥（Ed25519）
openssl genpkey -algorithm ED25519 -out client-ed25519.key
chmod 600 client-ed25519.key
openssl pkey -in client-ed25519.key -pubout -out client-ed25519.pub.pem
# raw 32-byte base64（给接收端 pin）
openssl pkey -pubin -in client-ed25519.pub.pem -outform der | tail -c 32 | base64

# 接收端信封密钥（X25519）
openssl genpkey -algorithm X25519 -out recipient-x25519.key
chmod 600 recipient-x25519.key
openssl pkey -in recipient-x25519.key -pubout -outform der | tail -c 32 | base64
```

接收端需要用同一套 CA 校验客户端证书，并配置 `clientSpkiSha256`、客户端 Ed25519 公钥、X25519 私钥、自己的 Ed25519 签名私钥。客户端配置服务端 SPKI pin、服务端 Ed25519 公钥、X25519 公钥、自己的 mTLS/Ed25519 私钥。

## 4. 网络与防火墙

- 发送端：只建立到 `host:port` 的**出站** TCP；无需开放任何入站端口。
- 接收端：只开放一个非标准端口（示例 `18443/tcp`），禁止 80/443。
- 不依赖客户端固定 IP；不要在防火墙/反向代理里做客户端 IP allowlist，身份由 mTLS + SPKI pin + 签名保证。
- 默认只允许私网/loopback 解析；需要跨公网时必须显式 `allowPublicEndpoint=true`，并另行评估暴露面。能放在 VPN/内网就放在 VPN/内网。
- 不要在 80/443 上做 TLS 终止后再转发；交接端口本身必须是 TLS 1.3 + 客户端证书。

## 5. 线协议（接收端契约）

所有请求都要求 mTLS；除 `POST /v1/session` 外都要求 `x-dsh-diag-token`、`x-dsh-diag-nonce`、`x-dsh-diag-timestamp`、`x-dsh-diag-signature`。

| 方法/路径 | 作用 |
|---|---|
| `POST /v1/session` | 签名请求换一次性 token；响应含 `token`、`expiresAt`、`serverNonce`、`serverSignature` |
| `HEAD /v1/diagnostics/{id}` | 返回 `x-dsh-upload-offset`、`x-dsh-upload-complete`，用于断点续传 |
| `PUT /v1/diagnostics/{id}` | 分块上传加密信封；`Upload-Offset` 头 + `Idempotency-Key`（归档 SHA-256，绑定 operation/bundleId/请求身份） |
| `POST /v1/diagnostics/{id}/finalize` | 提交签名 manifest；接收端验双签名、独立 envelope digest、解密、校验归档/文件/长度后标记完成；同一幂等键重复提交返回同一状态，冲突 409 |
| `GET /v1/diagnostics/{id}/manifest` | 返回签名 manifest |
| `GET /v1/diagnostics/{id}/bundle` | 返回加密信封 bytes |

签名域分隔：`dsh-diag-session-request-v1`、`dsh-diag-session-response-v1`、`dsh-diag-request-v1`、`dsh-ssh-tui/diagnostics-envelope/v1`。请求签名覆盖 method、path、body SHA-256、upload offset、nonce、timestamp、token hash。时间窗 ±5 分钟；nonce 不得复用；不跟随重定向；只接受 2xx。认证/重放失败的真实 4xx 响应带固定 `x-dsh-diag-error: AUTH_REPLAY_REFUSED`（或 `AUTH_FAILED`）头；客户端只认这个 allowlist 头，不把响应正文当可信错误码。

## 6. 包内容与脱敏

远端归档 `bundle.tar.gz` 只允许两个文件：

- `metadata.json`：`schema`、`kind`、`phase`、`failureCode`（稳定枚举/`^[A-Z][A-Z0-9_]{2,63}$`）、`exitCode`、`elapsedMs`、`problemClasses`、可选 `child`/`ci`。未知字段直接 fail closed。
- `versions.txt`：精确五字段 `node`、`npm`、`pnpm`、`os`、`created`；不可得的包管理器版本固定写 `unknown`。sourceSha 只保留在结构化 manifest（`sourceSha` 与 `tool.commit`），不写进 versions，避免自由文本。

manifest 额外记录 `bundleId`、`createdAt`、`tool`、`sourceSha`、`runtime`、`archive`（bytes/SHA-256）、`files[]`（name/bytes/SHA-256）、`encryption`（alg/recipientKeyId）、`redaction`（policy/ruleset/withheld/blocked）、Ed25519 `signature`。信封头记录 `ciphertextSha256` 与独立的 `envelopeSignature`；`verifyEncryptedBundle` 必须同时收到调用方独立持有的 `expectedEnvelopeSha256`。

**不进入远端包**：screen.txt、transcript.txt、原始日志、session id、问题原文、错误 message、home 路径、用户名、cookie/token/私钥、环境变量。secret scan 覆盖私钥头、Bearer/Authorization/Cookie、GitHub/AWS/Slack/JWT/`sk-`、URL 凭据、password/token/secret 赋值、`/home/*`、`/Users/*`、`C:\Users\*`、`~/*`、邮箱、session UUID、控制字符/零宽 bidi。命中即 `REDACTION_BLOCKED`，删除临时归档、不上传；扫描在截断之前对全量文本执行。

大小上限：单文件默认 256 KiB，解压总量默认 1 MiB，归档默认 32 MiB；超限 `TOO_LARGE`，本地保留、不上传。tar 写入器拒绝 `..`、绝对路径、symlink/非普通文件；条目排序、mtime/uid/gid 归零、mode 0600，gzip 头固定，保证同输入字节一致。

## 7. 零人工、重试与 spool

- 失败触发：boot 失败、turn/end error、agent error、probe 断言失败（仅启用时）。稳定 failure ID 由 kind/failureCode/phase/exitCode/sourceSha/problemClasses/ci（可选 incidentId）计算，不包含时间；receipt 持久化该 ID。pending/retry/uploading 条目跨重复触发与进程重启去重；verified/终态仅在 5 秒窗口内去重，之后同签名的新独立事件仍会生成新包。`probe` 与 TUI/boot 共用 `loadDiagnosticsConfig`：config-file `enabled:true` 即可触发，env `DSH_DIAGNOSTICS_UPLOAD=0` 仍强制关闭；未配置/disabled 零网络。
- 上传：分块（默认 1 MiB，最大 4 MiB）+ 断点续传；失败只对网络/408/425/429/5xx 重试，指数退避 1/2/4/8/16s + 抖动，最多 `maxAttempts`（默认 5）。TLS/证书/pin/401/403/4xx/重定向/脱敏/超限不重试。
- spool：`$DSH_HOME/tui-diagnostics/spool/<bundleId>/` 原子写 `bundle.tar.gz`、`manifest.json`、`envelope.bin`、`receipt.json`；目录 0700、文件 0600；单消费者 lease；重启恢复；7 天过期。条数/字节硬上限（默认 64 / 256 MiB）在 `.admission.lock` 原子准入下按磁盘实况重算，重启后仍生效；满时 `SPOOL_FAILED` 且保留原始失败证据。只有 7 天以上的 `abandoned`/`destination-changed` 条目会被受控清理；`verified/` 同受条数/字节上限约束并按最旧副本清理。频控每实例 5 分钟 1 次、全局每小时 3 次。
- 目的地绑定：spool 记录 `destinationFingerprint`（host/port/pin/公钥/证书 SPKI 的哈希）。改 endpoint 或轮换 pin/证书后，旧队列标 `destination-changed`，**不会**自动发往新目标。
- 下载校验：上传后自动 `GET manifest` + `GET bundle`；对照本地独立绑定的 `manifestSha256`/`envelopeSha256`/`archiveSha256`，验 manifest 签名、信封 binding 签名、`ciphertextSha256`、manifest 绑定的归档哈希/长度；接收端/授权审核方再用 X25519 私钥解密并逐文件验 SHA-256。只有同时具备独立期望 digest（本地 receipt 的 remote 字段，或调用方显式 `expectedManifestSha256`/`expectedEnvelopeSha256`）并实际解密验完内容才声明 `verified`；缺 receipt/期望 digest 时即使能解密也最多 `envelope-verified`，不误报 `VERIFIED`。
- 退出码：诊断路径从不改变原始失败码；boot 仍 `exit(1)`，probe 仍返回自己的 `reportOutcome`；下载 CLI 的退出码只表示 fetch 校验是否成功，manifest 中的 `exitCode` 单独打印。

## 8. CLI

```bash
npm run build

# 默认关闭：不会联网
node scripts/diagnostics-cli.mjs status

# 人工/CI 发布（配置只从 env/0600 文件读取；没有 token 参数）
DSH_DIAGNOSTICS_UPLOAD=1 node scripts/diagnostics-cli.mjs publish \
  --kind probe-failure --failure-code PROBE_ASSERTION --phase probe --exit-code 1

# 下载 + 校验（有接收端私钥时会解密并校验内容）
DSH_DIAGNOSTICS_UPLOAD=1 node scripts/diagnostics-cli.mjs fetch <bundleId>

# 重试 spool 中到期的条目
DSH_DIAGNOSTICS_UPLOAD=1 node scripts/diagnostics-cli.mjs drain
```

`publish` 在未配置/关闭时退出 0（CI 的可选证据步骤不能改变 job 结论）；`fetch` 校验失败时非零。

## 9. 故障模式

| 错误类 | 行为 | 重试 |
|---|---|---|
| `NOT_CONFIGURED` / `DISABLED` | 不联网、不建包 | 否 |
| `CONFIG_INVALID` / `PUBLIC_ENDPOINT_REFUSED` | 启动前拒绝；不连接 | 否 |
| `TLS_FAILED` / `PIN_MISMATCH` | 证书/公钥 pin 失败；不发送 | 否 |
| `AUTH_FAILED` / `AUTH_REPLAY_REFUSED` / `SESSION_FAILED` | 认证/防重放失败；重放/过期固定 terminal 类 | 否 |
| `REDIRECT_REFUSED` | 3xx 不跟随 | 否 |
| `TOO_LARGE` | 超限；本地保留 | 否 |
| `REDACTION_BLOCKED` | 命中 secret scan；临时归档删除 | 否 |
| `NETWORK` / `TIMEOUT` / `RATE_LIMITED` / `SERVER_ERROR` | 退避重试至上限，之后 `abandoned`；握手前 ECONNREFUSED/ENETUNREACH/EHOSTUNREACH 属可重试网络类 | 是 |
| `INTEGRITY_FAILED` / `DOWNLOAD_FAILED` | 哈希/签名/长度/下载失败；不标 verified | 下载有限重试 |
| `SPOOL_FAILED` / `DESTINATION_CHANGED` | 本地 spool 问题/目的地变更；不发送 | 否 |

## 10. 回滚、轮换与清理

- 立即关闭：`DSH_DIAGNOSTICS_UPLOAD=0`（或配置 `enabled=false`）。停止新上传和重试；spool 保留。
- 清理本地：`spool` 满时不会静默丢包；可显式删除 `$DSH_HOME/tui-diagnostics/spool` / `verified`（或手工清理）。超过 7 天的 terminal spool 副本与最旧 verified 副本按上限受控清理。远端对象由接收端 retention 管理；本实现不实现 `DELETE`。
- 轮换 token/证书/pin：先换接收端，再更新发送端配置；`destinationFingerprint` 变化后旧队列不会自动重发。旧 client 证书可被接收端 CA/CRL/allowlist 撤销。
- 代码回滚：普通 revert；无 schema migration、无版本号/peer 变更。`RC_CUT_READY=false`。

## 11. CI 与不受信任 PR

- CI 与本地共用 `lib/diagnostics` 核心与同一 schema；CI 只是另一个调用点。
- **不要**在 `pull_request_target` 中 checkout/执行 PR 代码并注入 evidence 写凭据；fork/不受信任 PR 不注入任何凭据。
- 需要真实失败产物时，使用可信 relay：由受控 workflow 运行 pinned 代码，验证/转交 metadata-only 包；relay 不冒充产品上传。
- 本 PR 未修改 `.github/workflows/ci.yml`，也未配置任何仓库 secret；真实 CI 远端路径仍为 `FEATURE_REQUIRED` / `NOT_MEASURED`。

## 12. 已知限制

- 仓库只提供客户端与测试/参考用 in-memory mTLS receiver；生产接收端部署不在本单范围。参考接收端已实现幂等键的 bundle/digest/operation/身份绑定与冲突 409，但跨重启持久幂等语义 **HOLD**（内存 map，不冒充真实持久化）。
- 未连接真实公网/私有 endpoint；所有传输证据来自本地 TLS 1.3 mock。真实 endpoint 的证书链、保留策略、并发/配额仍需部署方验收。
- TLS 1.3 的客户端证书拒绝在部分 Node/OpenSSL 组合下表现为握手后的 reset；客户端会把它归为 `TLS_FAILED` 或有限次 `NETWORK`，**不会**上传；接收端必须确保未通过 mTLS 的请求不落盘。
- Windows 的 `0600` 是 advisory；生产 Windows 应使用用户 ACL 或环境变量提供 PEM。
- 不实现远端删除、服务端 retention、CRL/OCSP 主动检查；这些属于接收端运维。
- 远端包只能定位到失败类/阶段/退出码/版本，不能复现 screen/transcript；这是隐私最小化的有意取舍。
