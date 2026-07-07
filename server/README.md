# License Worker 部署指南

Cloudflare Workers + KV 实现的远程激活码 + 设备指纹鉴权后端。

## 前置要求

- 已注册 Cloudflare 账号
- 本机已安装 Node.js 18+
- 全局安装 wrangler：
  ```bash
  npm install -g wrangler
  # 或本目录下 npm install 后用 npx wrangler
  ```

## 部署步骤

### 1. 登录 Cloudflare
```bash
cd server
wrangler login
```

### 2. 创建 4 个 KV 命名空间

> 注意：Wrangler v3+ 使用空格语法（`kv namespace`），不再支持冒号语法（`kv:namespace`），也不再需要 `--preview`。

```bash
wrangler kv namespace create LICENSES
wrangler kv namespace create DEVICES
wrangler kv namespace create CODE_DEVICES
wrangler kv namespace create TOKEN_INDEX
```
每条命令会输出 `id`，把 4 个 id 填回 `wrangler.toml` 的对应位置。

### 3. 生成 ECDSA P-256 密钥对
```bash
npm run gen-keys
```
输出会同时给出：
- **私钥 hex**（PKCS8）→ 注入到 Worker
- **公钥 hex**（SPKI）→ 填到客户端 `../config.js` 的 `LICENSE_PUBKEY`

### 4. 注入 secrets
```bash
# 注入签名私钥
wrangler secret put ED25519_PRIVATE_KEY
# 提示后粘贴 gen-keys.js 输出的私钥 hex
# 注：变量名沿用历史命名，实际算法是 ECDSA-P256

# 生成并注入 admin token
npm run gen-admin-token
wrangler secret put ADMIN_TOKEN
# 粘贴上一步输出的 token
```

### 5. 部署
```bash
npm run deploy
```
输出会告诉你 Worker 的访问 URL，例如：
`https://license-worker.<account>.workers.dev`

把这个 URL 填到客户端 `../config.js` 的 `LICENSE_SERVER_URL`。

### 6. 验证
```bash
curl https://license-worker.xxx.workers.dev/health
# 期望返回 {"code":200,"msg":"ok","data":{"ok":true,"ts":...}}
```

### 7. 生成激活码
直接打开 `admin.html`（用浏览器本地打开即可，纯前端）：
1. 填 Worker URL 和 ADMIN_TOKEN → 保存
2. 在"生成激活码"区域设置数量/设备数/有效期/备注 → 点"生成"
3. 在"激活码列表"可以查看所有码、解绑设备、撤销码、导出 CSV

把生成的激活码发给终端用户。

## 客户端配置回填

回到扩展根目录，编辑 `config.js`：

```js
LICENSE_SERVER_URL: "https://license-worker.<account>.workers.dev",
LICENSE_PUBKEY: "<gen-keys.js 输出的公钥 hex>",
LICENSE_GRACE_DAYS: 7,  // 必须和 wrangler.toml 的 GRACE_DAYS 一致
```

然后重新加载扩展。

## 本地开发模式
```bash
npm run dev   # 启动 wrangler dev（本地 8787 端口）
```
本地开发时，`config.js` 的 `LICENSE_SERVER_URL` 改为 `http://localhost:8787`。

## 接口一览

### 用户接口（不需要 admin token）
| 路径 | 方法 | 入参 | 返回（关键字段） |
|---|---|---|---|
| `/activate` | POST | `code, fingerprintHash, parts` | `{deviceId, token, expireAt, graceUntil} + serverTime + nonce + sign` |
| `/verify` | POST | `token, fingerprintHash, parts?` | `{valid, expireAt, graceUntil} + sign` |
| `/heartbeat` | POST | `token, fingerprintHash, parts?` | `{ok, nextHeartbeatIn, expireAt, graceUntil} + sign` |
| `/unbind` | POST | `token` | `{ok}` |
| `/health` | GET | - | `{ok, ts}` |

### Admin 接口（需要 adminToken）
| 路径 | 方法 | 入参 |
|---|---|---|
| `/admin/code/create` | POST | `{adminToken, count, maxDevices, expireDays, note}` |
| `/admin/code/list` | GET | `?adminToken=xxx` |
| `/admin/code/unbindAll` | POST | `{adminToken, code}` |
| `/admin/code/revoke` | POST | `{adminToken, code}` |

## 数据结构

| Namespace | Key 模式 | Value |
|---|---|---|
| `LICENSES` | `lic:<CODE>` | `{maxDevices, expireAt, createdAt, revoked, note}` |
| `DEVICES` | `dev:<deviceId>` | `{deviceId, code, fingerprintHash, fingerprintParts, token, tokenExpireAt, activatedAt, lastHeartbeat}` |
| `CODE_DEVICES` | `cd:<CODE>` | `[deviceId, ...]`（反向索引） |
| `TOKEN_INDEX` | `tk:<token>` | `deviceId`（token→设备反向索引） |

## 签名算法

- **算法**：ECDSA-P256 with SHA-256
- **签名内容**：`JSON.stringify(responseData) + "|" + serverTime + "|" + nonce`
- **格式**：raw r‖s，base64 编码
- **客户端校验**：扩展内 `license.js` 的 `verifySign()` 用预置公钥校验 + 时间漂移 < 60s

## 安全注意事项

- 私钥 hex **绝不能**提交到 git / 写到 wrangler.toml / 写到客户端代码
- `ADMIN_TOKEN` 用 `wrangler secret put` 注入，不要硬编码
- 客户端 `config.js` 只放**公钥**，泄露公钥不影响安全
- 若怀疑私钥泄露：重新 `gen-keys` → 重注入 secret → 重部署 → 更新所有客户端的 `LICENSE_PUBKEY`（已签发的激活码可继续用，但旧客户端无法验证新签名）
- KV 是最终一致的，新写入最多 ~60 秒全球同步；激活/校验/解绑的客户端会本地缓存，短暂不一致可被宽限期吸收

## 成本预估（Cloudflare 免费层）

- Workers 请求数：10 万/天，每用户每天约 5-10 次请求（首次激活 + 30 分钟心跳），可支撑约 1 万活跃用户
- KV 读：10 万/天，写：1000/天（写主要发生在新激活时）
- 超出免费层后再考虑 Workers Paid（$5/月，1000 万请求/月）

## 常见问题

**Q: 用户卸载扩展又重装，激活码会浪费一个设备位吗？**
A: 会。重装后 fingerprint 大概率变化（除非浏览器环境完全一致），需要重新激活。可以让用户在另一台仍激活的机器上点"解绑当前设备"释放该位，或 admin 后台点"解绑全部"。

**Q: 用户改系统时间能绕过宽限期吗？**
A: 不能。客户端只用服务端下发的 `serverTime` 推进 graceUntil；本地时钟回拨超过 5 分钟会立即触发"必须联网校验"。

**Q: 撤销激活码后多久生效？**
A: 下一次心跳（最长 30 分钟）就会被服务端拒绝；客户端收到拒绝信号后会立即锁定业务。

**Q: 怎么强制所有用户立即重新校验（例如应急情况）？**
A: 把 `wrangler.toml` 的 `GRACE_DAYS` 改小（如 0.01=15分钟）后重部署；已激活用户的心跳会拿到新的更短的 graceUntil，最长 30 分钟内全部锁定。注意：这会让所有用户必须重新联网，慎用。
