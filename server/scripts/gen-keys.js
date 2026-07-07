/**
 * 生成 ECDSA P-256 密钥对（PKCS8 私钥 hex + SPKI 公钥 hex）
 *
 * 用法：
 *   node scripts/gen-keys.js
 *
 * 输出：
 *   1) 私钥 hex（PKCS8）—— 用 `wrangler secret put ED25519_PRIVATE_KEY` 注入到 Worker
 *      （变量名沿用历史命名 ED25519_PRIVATE_KEY，实际算法是 ECDSA-P256）
 *   2) 公钥 hex（SPKI）—— 复制到 ../config.js 的 LICENSE_PUBKEY
 *
 * 注意：私钥必须保密，泄露后需重新生成并重部署后端 + 更新所有客户端。
 */

const { webcrypto } = require("crypto");
const { subtle } = webcrypto;

(async () => {
  const kp = await subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );

  const priv = await subtle.exportKey("pkcs8", kp.privateKey);
  const pub = await subtle.exportKey("spki", kp.publicKey);

  const toHex = (buf) =>
    Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

  const privHex = toHex(priv);
  const pubHex = toHex(pub);

  console.log("========================================================");
  console.log(" ECDSA-P256 密钥对已生成 ");
  console.log("========================================================\n");
  console.log("[1] 私钥（PKCS8 hex）—— 注入到 Worker：");
  console.log("    wrangler secret put ED25519_PRIVATE_KEY");
  console.log("    然后粘贴下面这一行：\n");
  console.log("    " + privHex + "\n");
  console.log("[2] 公钥（SPKI hex）—— 复制到 ../config.js 的 LICENSE_PUBKEY：\n");
  console.log("    LICENSE_PUBKEY: \"" + pubHex + "\",\n");
  console.log("========================================================");
  console.log(" ⚠️  私钥请妥善保管，不要提交到 git / 不要外发");
  console.log("========================================================");
})();
