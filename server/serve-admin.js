/**
 * 零依赖本地静态服务器（仅用于跑 admin.html）
 *
 * 启动：node serve-admin.js
 * 访问：http://localhost:8080/admin.html
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

http
  .createServer((req, res) => {
    try {
      let p = decodeURIComponent((req.url || "/").split("?")[0]);
      if (p === "/") p = "/admin.html";
      // 防目录遍历：只取 basename，不允许 ../
      const safe = path.basename(p);
      const full = path.join(ROOT, safe);
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("404 not found");
        return;
      }
      const type = MIME[path.extname(full).toLowerCase()] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": type });
      fs.createReadStream(full).pipe(res);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("server error: " + e.message);
    }
  })
  .listen(PORT, () => {
    console.log("\n  License admin 已启动");
    console.log("  ─────────────────────────────────────────");
    console.log("  访问： http://localhost:" + PORT + "/admin.html");
    console.log("  ─────────────────────────────────────────");
    console.log("  按 Ctrl+C 退出\n");
  });
