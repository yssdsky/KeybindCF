// =============================================================
//  全局配置（如果你要改域名，就改这里！！！）
// =============================================================
self.CONFIG = {
  // 目标站点域名（末尾不要带斜杠）
  // ★★★ 这就是你要修改的地方 ★★★
  BASE_URL: "https://test.com",

  // 接口前缀（一般不需要改）
  API_PREFIX: "/prod-api",

  // 拦截规则：请求 URL 包含此关键字时，捕获其 Authorization Header
  CAPTURE_URL_PATTERN: "/prod-api",

  // =============================================================
  //  License 远程鉴权配置
  // =============================================================
  // 后端 Cloudflare Worker 的 URL（部署完 server/ 后填回这里）
  // 示例值，部署时请改为自己的 Worker URL
  LICENSE_SERVER_URL: "https://license-worker.your-account.workers.dev",

  // ECDSA-P256 公钥（SPKI 格式 hex）
  // 由 server/scripts/gen-keys.js 生成，**私钥** 只在后端
  // 部署时请运行 gen-keys.js 并填入此处；留空则跳过签名校验（仅开发调试用）
  LICENSE_PUBKEY: "",

  // 离线宽限期（天），后端会用同样值签发 graceUntil
  // 必须与 server/wrangler.toml 的 GRACE_DAYS 一致
  LICENSE_GRACE_DAYS: 7,
};
