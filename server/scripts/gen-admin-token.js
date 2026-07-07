/**
 * 生成一个 admin token（用于 /admin/* 接口鉴权）
 *
 * 用法：
 *   node scripts/gen-admin-token.js
 *
 * 然后用 `wrangler secret put ADMIN_TOKEN` 注入。
 */

const { randomBytes } = require("crypto");

console.log("\nADMIN_TOKEN: " + randomBytes(24).toString("hex") + "\n");
console.log("注入到 Worker：");
console.log("  wrangler secret put ADMIN_TOKEN\n");
