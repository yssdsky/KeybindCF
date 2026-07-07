/**
 * Cloudflare Worker — License 服务
 *
 * 接口：
 *   用户：
 *     POST /activate    { code, fingerprintHash, parts }
 *     POST /verify      { token, fingerprintHash }
 *     POST /heartbeat   { token, fingerprintHash }
 *     POST /unbind      { token }
 *   Admin（需 ADMIN_TOKEN）：
 *     POST /admin/code/create     { adminToken, count, maxDevices, expireDays, note }
 *     GET  /admin/code/list?adminToken=...
 *     POST /admin/code/unbindAll  { adminToken, code }
 *     POST /admin/code/revoke     { adminToken, code }
 *
 * KV 绑定：
 *   LICENSES     code -> {maxDevices, expireAt, createdAt, revoked, note}
 *   DEVICES      deviceId -> {code, fingerprintHash, fingerprintParts[], token, tokenExpireAt, activatedAt, lastHeartbeat}
 *   CODE_DEVICES code -> [deviceId, ...]
 *
 * 环境变量（wrangler secret）：
 *   ED25519_PRIVATE_KEY  PKCS8 ECDSA P-256 私钥 hex（变量名沿用历史命名）
 *   ADMIN_TOKEN
 *   GRACE_DAYS   (默认 7)
 *
 * 签名：ECDSA-P256 with SHA-256，签 JSON.stringify(body) + "|" + serverTime + "|" + nonce
 *       输出 raw r||s 的 base64
 */

const DEFAULT_MAX_DEVICES = 2;
const DEFAULT_EXPIRE_DAYS = 365;
const TOKEN_TTL_DAYS = 30;
const GRACE_DAYS_DEFAULT = 7;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 去掉 0/O/1/I/L

// -------------------- 工具 --------------------
function hexToBytes(hex) {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}
function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function bytesToBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function strToBytes(str) { return new TextEncoder().encode(str); }

function randomId(len) {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  let s = "";
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[arr[i] % CODE_ALPHABET.length];
  return s;
}

function generateCode() {
  const p1 = randomId(4);
  const p2 = randomId(4);
  const p3 = randomId(4);
  const p4 = randomId(4);
  // 校验位（前 16 字符 hash 取首字符）
  const raw = p1 + p2 + p3 + p4;
  let sum = 0;
  for (const ch of raw) sum += ch.charCodeAt(0);
  const check = CODE_ALPHABET[sum % CODE_ALPHABET.length];
  return "V1-" + p1 + "-" + p2 + "-" + p3 + "-" + p4 + check;
}

function generateToken() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return bytesToHex(arr);
}

function generateDeviceId() {
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  return "dev_" + bytesToHex(arr);
}

function generateNonce() {
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  return bytesToHex(arr);
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", strToBytes(text));
  return bytesToHex(new Uint8Array(buf));
}

// -------------------- 签名 --------------------
let _privKeyCache = null;
async function getPrivateKey(env) {
  if (_privKeyCache) return _privKeyCache;
  const hex = env.ED25519_PRIVATE_KEY || env.ECDSA_PRIVATE_KEY;
  if (!hex) throw new Error("服务端未配置签名私钥");
  const pkcs8 = hexToBytes(hex);
  _privKeyCache = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  return _privKeyCache;
}

async function signBody(body, env) {
  const serverTime = Date.now();
  const nonce = generateNonce();
  const payload = strToBytes(JSON.stringify(body) + "|" + serverTime + "|" + nonce);
  const key = await getPrivateKey(env);
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    payload
  );
  return {
    serverTime,
    nonce,
    sign: bytesToBase64(new Uint8Array(sig)),
  };
}

// -------------------- 响应辅助 --------------------
function jsonOk(data, extra) {
  const body = Object.assign({ code: 200, msg: "ok", data }, extra || {});
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
function jsonErr(code, msg, extra) {
  const body = Object.assign({ code, msg }, extra || {});
  return new Response(JSON.stringify(body), {
    status: code === 200 ? 200 : (code === 401 ? 401 : 400),
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function signedOk(data, env) {
  const sig = await signBody(data, env);
  return jsonOk(data, sig);
}

// -------------------- 业务 --------------------
async function activateHandler(req, env) {
  let body;
  try { body = await req.json(); } catch (e) { return jsonErr(400, "invalid body"); }
  const code = (body.code || "").trim().toUpperCase();
  const fingerprintHash = body.fingerprintHash;
  const parts = Array.isArray(body.parts) ? body.parts : [];
  if (!code || !fingerprintHash) return jsonErr(400, "missing code/fingerprintHash");

  // 查码
  const lic = await env.LICENSES.get("lic:" + code);
  if (!lic) return jsonErr(404, "激活码不存在");
  let licObj;
  try { licObj = JSON.parse(lic); } catch (e) { return jsonErr(500, "license parse error"); }
  if (licObj.revoked) return jsonErr(403, "激活码已被撤销");
  if (licObj.expireAt && Date.now() > licObj.expireAt) return jsonErr(403, "激活码已过期");

  // 查已绑定设备列表
  const cd = await env.CODE_DEVICES.get("cd:" + code);
  let deviceIds = [];
  if (cd) { try { deviceIds = JSON.parse(cd); } catch (e) {} }

  // 在已绑定设备中找匹配的指纹（模糊匹配：7 中 5）
  let matchedDevice = null;
  const allDevices = [];
  for (const did of deviceIds) {
    const d = await env.DEVICES.get("dev:" + did);
    if (!d) continue;
    let dObj;
    try { dObj = JSON.parse(d); } catch (e) { continue; }
    allDevices.push(dObj);
    if (dObj.fingerprintHash === fingerprintHash) {
      matchedDevice = dObj;
      break;
    }
    // 模糊匹配
    const matchCount = countFingerprintMatch(dObj.fingerprintParts || [], parts);
    if (matchCount >= 5) { matchedDevice = dObj; break; }
  }

  let deviceId, token, isNew = false;
  if (matchedDevice) {
    // 复用旧设备
    deviceId = matchedDevice.deviceId;
    token = matchedDevice.token || generateToken();
  } else {
    // 新设备
    if (deviceIds.length >= (licObj.maxDevices || DEFAULT_MAX_DEVICES)) {
      return jsonErr(409, "DEVICE_LIMIT_REACHED", { maxDevices: licObj.maxDevices, used: deviceIds.length });
    }
    deviceId = generateDeviceId();
    token = generateToken();
    isNew = true;
  }

  const now = Date.now();
  const graceDays = Number(env.GRACE_DAYS) || GRACE_DAYS_DEFAULT;
  const graceUntil = now + graceDays * 86400 * 1000;
  const expireAt = licObj.expireAt || (now + DEFAULT_EXPIRE_DAYS * 86400 * 1000);

  const deviceRecord = {
    deviceId,
    code,
    fingerprintHash,
    fingerprintParts: parts,
    token,
    tokenExpireAt: now + TOKEN_TTL_DAYS * 86400 * 1000,
    activatedAt: matchedDevice ? matchedDevice.activatedAt : now,
    lastHeartbeat: now,
  };
  await env.DEVICES.put("dev:" + deviceId, JSON.stringify(deviceRecord));

  if (isNew) {
    deviceIds.push(deviceId);
    await env.CODE_DEVICES.put("cd:" + code, JSON.stringify(deviceIds));
    // token → deviceId 反向索引（用于 verify/heartbeat/unbind 直接定位设备）
    await env.TOKEN_INDEX.put("tk:" + token, deviceId);
  } else if (matchedDevice.token !== token) {
    // 复用旧设备但 token 更新了 → 同步索引
    if (matchedDevice.token) await env.TOKEN_INDEX.delete("tk:" + matchedDevice.token);
    await env.TOKEN_INDEX.put("tk:" + token, deviceId);
  }

  const data = { deviceId, token, expireAt, graceUntil };
  return await signedOk(data, env);
}

function countFingerprintMatch(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  const len = Math.min(a.length, b.length);
  let hit = 0;
  for (let i = 0; i < len; i++) if (a[i] === b[i]) hit++;
  return hit;
}

async function findDeviceByToken(env, token) {
  if (!token) return null;
  // 简化：扫 CODE_DEVICES 不可行（不知 code），改为在 deviceId 设计上把 token 包含
  // 这里我们 token 也写入 device，但仍要按 deviceId 查
  // 简化方案：DEVICES KV 中 key 也用 token 作二级索引
  const didByToken = await env.TOKEN_INDEX.get("tk:" + token);
  if (!didByToken) return null;
  const d = await env.DEVICES.get("dev:" + didByToken);
  if (!d) return null;
  try { return JSON.parse(d); } catch (e) { return null; }
}

async function verifyHandler(req, env) {
  let body;
  try { body = await req.json(); } catch (e) { return jsonErr(400, "invalid body"); }
  const { token, fingerprintHash } = body;
  if (!token || !fingerprintHash) return jsonErr(400, "missing token/fingerprintHash");

  const device = await findDeviceByToken(env, token);
  if (!device) return jsonErr(404, "device not found", { revoked: true });

  // 查 license
  const lic = await env.LICENSES.get("lic:" + device.code);
  if (!lic) return jsonErr(403, "license gone", { revoked: true });
  let licObj;
  try { licObj = JSON.parse(lic); } catch (e) { return jsonErr(500, "license parse error"); }
  if (licObj.revoked) return jsonErr(403, "license revoked", { revoked: true });
  if (licObj.expireAt && Date.now() > licObj.expireAt) return jsonErr(403, "license expired", { revoked: true });

  // 指纹模糊匹配
  const matchCount = countFingerprintMatch(device.fingerprintParts || [], body.parts || []);
  const sameHash = device.fingerprintHash === fingerprintHash;
  if (!sameHash && matchCount < 5) {
    return jsonErr(403, "fingerprint mismatch", { revoked: false });
  }

  const now = Date.now();
  const graceDays = Number(env.GRACE_DAYS) || GRACE_DAYS_DEFAULT;
  const graceUntil = now + graceDays * 86400 * 1000;
  // 更新 last seen
  device.lastHeartbeat = now;
  await env.DEVICES.put("dev:" + device.deviceId, JSON.stringify(device));

  const data = { valid: true, expireAt: licObj.expireAt, graceUntil };
  return await signedOk(data, env);
}

async function heartbeatHandler(req, env) {
  let body;
  try { body = await req.json(); } catch (e) { return jsonErr(400, "invalid body"); }
  const { token, fingerprintHash } = body;
  if (!token) return jsonErr(400, "missing token");

  const device = await findDeviceByToken(env, token);
  if (!device) return jsonErr(404, "device not found", { revoked: true });

  const lic = await env.LICENSES.get("lic:" + device.code);
  if (!lic) return jsonErr(403, "license gone", { revoked: true });
  let licObj;
  try { licObj = JSON.parse(lic); } catch (e) { return jsonErr(500, "parse error"); }
  if (licObj.revoked) return jsonErr(403, "license revoked", { revoked: true });
  if (licObj.expireAt && Date.now() > licObj.expireAt) return jsonErr(403, "license expired", { revoked: true });

  const now = Date.now();
  const graceDays = Number(env.GRACE_DAYS) || GRACE_DAYS_DEFAULT;
  const graceUntil = now + graceDays * 86400 * 1000;
  device.lastHeartbeat = now;
  // 指纹漂移更新（轻微，<5 项变化才更新，避免他机复用 token）
  if (fingerprintHash && device.fingerprintHash !== fingerprintHash) {
    // 模糊匹配通过才允许更新
    const matchCount = countFingerprintMatch(device.fingerprintParts || [], body.parts || []);
    if (matchCount >= 4) {
      device.fingerprintHash = fingerprintHash;
      device.fingerprintParts = body.parts || device.fingerprintParts;
    }
  }
  await env.DEVICES.put("dev:" + device.deviceId, JSON.stringify(device));

  const data = { ok: true, nextHeartbeatIn: 1800, expireAt: licObj.expireAt, graceUntil };
  return await signedOk(data, env);
}

async function unbindHandler(req, env) {
  let body;
  try { body = await req.json(); } catch (e) { return jsonErr(400, "invalid body"); }
  const { token } = body;
  if (!token) return jsonErr(400, "missing token");
  const device = await findDeviceByToken(env, token);
  if (!device) return jsonOk({ ok: true });

  // 删 device
  await env.DEVICES.delete("dev:" + device.deviceId);
  await env.TOKEN_INDEX.delete("tk:" + token);
  // 从 code 反向索引中移除
  const cd = await env.CODE_DEVICES.get("cd:" + device.code);
  if (cd) {
    let arr;
    try { arr = JSON.parse(cd); } catch (e) { arr = []; }
    arr = arr.filter((x) => x !== device.deviceId);
    await env.CODE_DEVICES.put("cd:" + device.code, JSON.stringify(arr));
  }
  return jsonOk({ ok: true });
}

// -------------------- Admin --------------------
function checkAdmin(body, env) {
  const t = body.adminToken || body;
  return t && t === env.ADMIN_TOKEN;
}

async function adminCreate(req, env) {
  let body;
  try { body = await req.json(); } catch (e) { return jsonErr(400, "invalid body"); }
  if (!checkAdmin(body, env)) return jsonErr(401, "admin token invalid");
  const count = Math.max(1, Math.min(100, Number(body.count) || 1));
  const maxDevices = Math.max(1, Math.min(50, Number(body.maxDevices) || DEFAULT_MAX_DEVICES));
  const expireDays = body.expireDays === null || body.expireDays === undefined
    ? DEFAULT_EXPIRE_DAYS
    : Number(body.expireDays);
  const note = (body.note || "").slice(0, 200);

  const out = [];
  for (let i = 0; i < count; i++) {
    const code = generateCode();
    const licObj = {
      maxDevices,
      expireAt: expireDays > 0 ? Date.now() + expireDays * 86400 * 1000 : null,
      createdAt: Date.now(),
      revoked: false,
      note,
    };
    await env.LICENSES.put("lic:" + code, JSON.stringify(licObj));
    out.push({ code, maxDevices, expireAt: licObj.expireAt });
  }
  return jsonOk({ codes: out });
}

async function adminList(req, env) {
  const url = new URL(req.url);
  const adminToken = url.searchParams.get("adminToken");
  if (!adminToken || adminToken !== env.ADMIN_TOKEN) return jsonErr(401, "admin token invalid");
  // KV 不支持 list with values，用 list 列出所有 lic: 前缀
  const list = await env.LICENSES.list({ prefix: "lic:" });
  const out = [];
  for (const k of list.keys) {
    const code = k.name.substr(4);
    const v = await env.LICENSES.get(k.name);
    let obj;
    try { obj = JSON.parse(v); } catch (e) { continue; }
    const cd = await env.CODE_DEVICES.get("cd:" + code);
    let used = 0;
    if (cd) { try { used = JSON.parse(cd).length; } catch (e) {} }
    out.push({
      code,
      maxDevices: obj.maxDevices,
      used,
      expireAt: obj.expireAt,
      createdAt: obj.createdAt,
      revoked: !!obj.revoked,
      note: obj.note || "",
    });
  }
  return jsonOk({ licenses: out });
}

async function adminUnbindAll(req, env) {
  let body;
  try { body = await req.json(); } catch (e) { return jsonErr(400, "invalid body"); }
  if (!checkAdmin(body, env)) return jsonErr(401, "admin token invalid");
  const code = (body.code || "").trim().toUpperCase();
  if (!code) return jsonErr(400, "missing code");
  const cd = await env.CODE_DEVICES.get("cd:" + code);
  if (cd) {
    let arr;
    try { arr = JSON.parse(cd); } catch (e) { arr = []; }
    for (const did of arr) {
      const d = await env.DEVICES.get("dev:" + did);
      if (d) {
        let dObj;
        try { dObj = JSON.parse(d); } catch (e) { dObj = null; }
        if (dObj && dObj.token) await env.TOKEN_INDEX.delete("tk:" + dObj.token);
      }
      await env.DEVICES.delete("dev:" + did);
    }
    await env.CODE_DEVICES.delete("cd:" + code);
  }
  return jsonOk({ ok: true });
}

async function adminRevoke(req, env) {
  let body;
  try { body = await req.json(); } catch (e) { return jsonErr(400, "invalid body"); }
  if (!checkAdmin(body, env)) return jsonErr(401, "admin token invalid");
  const code = (body.code || "").trim().toUpperCase();
  if (!code) return jsonErr(400, "missing code");
  const lic = await env.LICENSES.get("lic:" + code);
  if (!lic) return jsonErr(404, "code not found");
  let obj;
  try { obj = JSON.parse(lic); } catch (e) { return jsonErr(500, "parse error"); }
  obj.revoked = true;
  await env.LICENSES.put("lic:" + code, JSON.stringify(obj));
  return jsonOk({ ok: true });
}

// -------------------- 路由 --------------------
async function router(req, env) {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method.toUpperCase();

  if (method !== "POST" && method !== "GET") {
    return jsonErr(405, "method not allowed");
  }

  try {
    if (path === "/activate" && method === "POST") return await activateHandler(req, env);
    if (path === "/verify" && method === "POST") return await verifyHandler(req, env);
    if (path === "/heartbeat" && method === "POST") return await heartbeatHandler(req, env);
    if (path === "/unbind" && method === "POST") return await unbindHandler(req, env);
    if (path === "/admin/code/create" && method === "POST") return await adminCreate(req, env);
    if (path === "/admin/code/list" && method === "GET") return await adminList(req, env);
    if (path === "/admin/code/unbindAll" && method === "POST") return await adminUnbindAll(req, env);
    if (path === "/admin/code/revoke" && method === "POST") return await adminRevoke(req, env);
    if (path === "/health") return jsonOk({ ok: true, ts: Date.now() });
    if (path === "/") return new Response("license-worker running", { headers: { "Content-Type": "text/plain" } });
    return jsonErr(404, "not found: " + path);
  } catch (e) {
    return jsonErr(500, "server error: " + (e && e.message || String(e)));
  }
}

// -------------------- CORS --------------------
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function withCors(res) {
  const newHeaders = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders())) {
    newHeaders.set(k, v);
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: newHeaders,
  });
}

export default {
  async fetch(req, env, ctx) {
    // CORS 预检
    if (req.method.toUpperCase() === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    const res = await router(req, env || {});
    return withCors(res);
  },
};
