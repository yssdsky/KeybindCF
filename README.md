# Authorization 拦截 + License 激活示例（Chrome MV3 扩展模板）

一个开箱即用的 Chrome MV3 扩展骨架，提供两大能力：

1. **Authorization 拦截** — 后台 Service Worker 自动捕获目标站点请求中的 `Authorization` Header，前端面板可读取 / 手动覆盖 / 周期刷新。
2. **远程激活码 + 设备指纹鉴权** — 基于 ECDSA-P256 签名 + 设备指纹的 License 体系，支持一码多机、离线宽限期、心跳续签、解绑换机、服务端撤销。

业务侧（具体的 API 调用、UI 流程）已剥离，仅保留一个最小化的"示例 API 调用"演示区，便于二次开发。

## 目录结构

```
KeyBindCF/
├── manifest.json          扩展清单
├── config.js              ★ 全局配置（域名 / License 服务器 / 公钥）
├── background.js          Service Worker：拦截 Authorization + License 心跳
├── license.js             License 客户端模块（激活 / 校验 / 心跳 / 解绑 / 验签）
├── sidepanel.html         侧边栏界面（激活区 + Auth 状态 + 调试 + 示例 API）
├── sidepanel.css          样式
├── sidepanel.js           面板主逻辑
├── LICENSE_ACTIVATE.md    终端用户激活说明
└── server/                Cloudflare Worker 后端（License 服务 + 管理后台）
    ├── worker.js          Worker 主体（activate / verify / heartbeat / unbind / admin/*）
    ├── admin.html         管理后台（生成激活码 / 列表 / 解绑 / 撤销）
    ├── serve-admin.js     本地静态服务（用于打开 admin.html）
    ├── wrangler.toml      Cloudflare 部署配置
    └── scripts/
        ├── gen-keys.js           生成 ECDSA-P256 密钥对
        └── gen-admin-token.js    生成管理后台 token
```

## 全局配置（最重要）

**只有一处：`config.js`**

```js
self.CONFIG = {
  // 目标站点域名（末尾不要带斜杠）
  BASE_URL: "https://test.com",
  API_PREFIX: "/prod-api",
  CAPTURE_URL_PATTERN: "/prod-api",   // 命中此关键字即捕获其 Authorization

  // License 远程鉴权
  LICENSE_SERVER_URL: "https://license-worker.yuyuyour-account.workers.dev",
  LICENSE_PUBKEY: "<server/scripts/gen-keys.js 输出的公钥 hex>",
  LICENSE_GRACE_DAYS: 7,              // 必须与 wrangler.toml 的 GRACE_DAYS 一致
};
```

## 安装方式（Chrome / Edge）

1. 打开 `chrome://extensions/`（Edge 是 `edge://extensions/`）
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」，选中本目录
4. 浏览器工具栏出现扩展图标
5. 点击图标 → 打开侧边栏面板，按提示激活

## 工作原理

### Authorization 拦截

- `background.js` 通过 `chrome.webRequest.onBeforeSendHeaders`（带 `extraHeaders`）监听所有 URL 包含 `CAPTURE_URL_PATTERN` 的请求，提取 `Authorization` Header 存到 `chrome.storage.local`。
- 面板通过 `chrome.runtime.sendMessage({type:"GET_AUTH"})` 向 background 取最新 Authorization。
- 当 storage 中的 Authorization 更新时，background 主动 `AUTH_UPDATED` 推送给所有面板。
- 自动拦截失败时，可在面板的「手动设置 Authorization」里直接粘贴。

### License 鉴权

**首次激活**：

1. 面板启动 → 调 `LICENSE_VERIFY` → 后端返回"未激活"
2. 用户输入激活码 → 调 `LICENSE_ACTIVATE`
3. 客户端采集设备指纹（platform / UA / 屏幕 / 时区 / 扩展 ID 等 hash）→ POST `/activate`
4. 后端校验激活码有效性、设备数量上限、生成 `deviceId + token`，签发 `expireAt + graceUntil`，并对响应做 ECDSA-P256 签名
5. 客户端用预置公钥验签 + 时间漂移校验 → 写入 `chrome.storage.local`

**日常使用**：

- Service Worker 用 `chrome.alarms` 每 30 分钟调一次 `/heartbeat`，刷新 `graceUntil`
- 离线时使用本地缓存的 `graceUntil` 兜底（默认 7 天）
- 心跳返回 `revoked=true` 时立即锁定业务区

**时钟防作弊**：

- 客户端只信任服务器下发的 `serverTime` 推进 `graceUntil`
- 本地时钟回拨超过 5 分钟 → 强制联网校验
- 时间漂移 > 60 秒 → 拒绝响应

详见 [LICENSE_ACTIVATE.md](./LICENSE_ACTIVATE.md)。

## 二次开发指引

业务代码已剥离，仅保留一个 `apiFetch(path, options)` 通用请求封装，自动携带捕获到的 Authorization。可直接复用：

```js
// 在 sidepanel.js 中
const data = await apiFetch("/your/api/path");
// 或 POST
const data = await apiFetch("/your/api/path", {
  method: "POST",
  body: JSON.stringify({ foo: "bar" }),
});
```

面板上的「示例 API 调用」区即基于此封装，输入路径即可发起 GET 请求并查看响应。

### 业务守卫

在每个业务入口前调用 `guardActivated()`，未激活时自动锁定 UI 并触发重新校验：

```js
if (!guardActivated()) return;
// 此处可放心调用业务接口
```

## License 后端部署

见 [server/README.md](./server/README.md)。

简要流程：
1. `wrangler login`
2. 创建 4 个 KV 命名空间（LICENSES / DEVICES / CODE_DEVICES / TOKEN_INDEX）
3. `npm run gen-keys` 生成密钥对 → 私钥注入 Worker secret，公钥回填 `config.js`
4. `npm run gen-admin-token` 生成管理 token → 注入 Worker secret
5. `npm run deploy` 部署
6. 用 `admin.html` 生成激活码发给用户

## 接口一览（License Worker）

### 用户接口（无需 admin token）
| 路径 | 方法 | 入参 | 关键返回 |
|---|---|---|---|
| `/activate` | POST | `code, fingerprintHash, parts` | `{deviceId, token, expireAt, graceUntil} + sign` |
| `/verify` | POST | `token, fingerprintHash, parts?` | `{valid, expireAt, graceUntil} + sign` |
| `/heartbeat` | POST | `token, fingerprintHash, parts?` | `{ok, expireAt, graceUntil} + sign` |
| `/unbind` | POST | `token` | `{ok}` |
| `/health` | GET | - | `{ok, ts}` |

### Admin 接口（需 adminToken）
| 路径 | 方法 | 入参 |
|---|---|---|
| `/admin/code/create` | POST | `{adminToken, count, maxDevices, expireDays, note}` |
| `/admin/code/list` | GET | `?adminToken=xxx` |
| `/admin/code/unbindAll` | POST | `{adminToken, code}` |
| `/admin/code/revoke` | POST | `{adminToken, code}` |

## 安全要点

- 私钥 hex **绝不能**提交到代码仓库 / 写入 wrangler.toml / 客户端文件
- `ADMIN_TOKEN` 用 `wrangler secret put` 注入
- 客户端 `config.js` 仅放**公钥**，泄露不影响安全
- 怀疑私钥泄露：重新 `gen-keys` → 重注入 secret → 重部署 → 更新所有客户端公钥

## 关注我！！！
<img width="630" height="748" alt="803cb108-bc99-48de-aae0-b558788a7b9d" src="https://github.com/user-attachments/assets/241249f2-61de-422e-a9df-73ce546d339e" />
