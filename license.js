/* =============================================================
 * license.js — 远程激活码 + 设备指纹鉴权（共用模块）
 * 签名算法：ECDSA-P256 with SHA-256（Web Crypto 原生支持）
 * ============================================================= */

const LICENSE = (() => {
  // ---------- 配置 ----------
  const CFG = () => self.CONFIG || {};
  const SERVER_URL = () => CFG().LICENSE_SERVER_URL || "";
  const GRACE_DAYS = () => Number(CFG().LICENSE_GRACE_DAYS) || 7;
  const TIMEOUT_MS = 8000;

  // ---------- 基础工具 ----------
  function strToBytes(str) {
    return new TextEncoder().encode(str);
  }

  function bytesToHex(bytes) {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  function hexToBytes(hex) {
    const clean = hex.replace(/[^0-9a-fA-F]/g, "");
    const out = new Uint8Array(Math.floor(clean.length / 2));
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(clean.substr(i * 2, 2), 16);
    }
    return out;
  }

  function bytesToBase64(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function base64ToBytes(b64) {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  async function sha256Hex(text) {
    const buf = await crypto.subtle.digest("SHA-256", strToBytes(text));
    return bytesToHex(new Uint8Array(buf));
  }

  function randomHex(len) {
    const arr = new Uint8Array(len);
    crypto.getRandomValues(arr);
    return bytesToHex(arr);
  }

  // ---------- 公钥导入与验签 ----------
  let _pubKeyCache = null;

  async function getPublicKey() {
    if (_pubKeyCache) return _pubKeyCache;
    const pubkeySpkiHex = CFG().LICENSE_PUBKEY;
    if (!pubkeySpkiHex) {
      throw new Error("config.js 缺少 LICENSE_PUBKEY");
    }
    const spki = hexToBytes(pubkeySpkiHex);
    _pubKeyCache = await crypto.subtle.importKey(
      "spki",
      spki,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
    return _pubKeyCache;
  }

  /**
   * 验签
   * @param {*} body  响应体（参与签名的对象，签名前会 JSON.stringify）
   * @param {number} serverTime  服务器时间戳（毫秒）
   * @param {string} nonce
   * @param {string} signB64  base64 签名（raw r||s）
   * @returns {Promise<boolean>}
   */
  async function verifySign(body, serverTime, nonce, signB64) {
    try {
      if (!signB64 || !serverTime || !nonce) return false;
      const payload = strToBytes(
        JSON.stringify(body) + "|" + serverTime + "|" + nonce
      );
      const sig = base64ToBytes(signB64);
      const key = await getPublicKey();
      return crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        sig,
        payload
      );
    } catch (e) {
      console.warn("[license] verifySign error:", e);
      return false;
    }
  }

  // 时间漂移容忍：±60 秒（防重放）
  function checkTimeSkew(serverTimeMs) {
    const now = Date.now();
    return Math.abs(now - serverTimeMs) < 60 * 1000;
  }

  // ---------- HTTP ----------
  async function postJson(path, payload) {
    const url = SERVER_URL() + path;
    if (!SERVER_URL()) throw new Error("config.js 缺少 LICENSE_SERVER_URL");
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload || {}),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
      if (!res.ok && !data.code) {
        const err = new Error("HTTP " + res.status + ": " + text.slice(0, 200));
        err.httpStatus = res.status;
        throw err;
      }
      return data;
    } finally {
      clearTimeout(t);
    }
  }

  // ---------- 指纹采集 ----------
  /**
   * 采集设备指纹（需在 window 上下文调用，SW 中无 screen）
   * @returns {Promise<{hash:string, parts:string[]}>}
   */
  async function computeFingerprint() {
    const n = navigator || {};
    const s = (typeof screen !== "undefined") ? screen : {};
    const tz =
      (typeof Intl !== "undefined" &&
        Intl.DateTimeFormat &&
        Intl.DateTimeFormat().resolvedOptions().timeZone) ||
      "";
    const extId = (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id) || "";
    const parts = [
      String(n.platform || ""),
      String(n.userAgent || ""),
      String(n.hardwareConcurrency || ""),
      String(s.width || 0) + "x" + String(s.height || 0) + "x" + String(s.colorDepth || 0),
      String(tz),
      String(n.language || ""),
      String(extId),
    ];
    const SALT = "y3t00l-salt-v1";
    const hash = await sha256Hex(parts.join("|") + "|" + SALT);
    return { hash, parts };
  }

  // ---------- storage（兼容 SW 和 window） ----------
  function getStorage(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(keys, (res) => resolve(res || {}));
      } catch (e) { resolve({}); }
    });
  }
  function setStorage(obj) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set(obj, () => {
          // 记录单调时钟，用于检测时钟回拨
          if (typeof chrome.storage.local.get === "function") {
            chrome.storage.local.get(["_monotonicTs"], (r) => {
              const now = Date.now();
              const prev = r._monotonicTs || 0;
              chrome.storage.local.set({
                _monotonicTs: Math.max(prev, now),
              }, () => resolve());
            });
          } else {
            resolve();
          }
        });
      } catch (e) { resolve(); }
    });
  }

  async function getLicenseState() {
    const r = await getStorage([
      "licenseState",
      "_monotonicTs",
    ]);
    return r.licenseState || null;
  }

  async function setLicenseState(state) {
    await setStorage({ licenseState: state });
  }

  // ---------- 宽限期与时钟回拨 ----------
  /**
   * 判断当前是否在宽限期内
   * @param {*} state licenseState
   * @returns {{ok:boolean, reason:string}}
   */
  function checkGrace(state) {
    if (!state) return { ok: false, reason: "未激活" };
    const now = Date.now();

    // 时钟回拨检测
    if (state._lastMonotonicTs && now < state._lastMonotonicTs - 5 * 60 * 1000) {
      return { ok: false, reason: "检测到系统时钟回拨，需重新联网校验" };
    }

    // 宽限期
    const graceUntil = Number(state.graceUntil) || 0;
    if (!graceUntil) return { ok: false, reason: "无宽限期数据" };
    if (now > graceUntil) {
      return { ok: false, reason: "已超过宽限期" };
    }

    // 后端撤销
    if (state.revoked) {
      return { ok: false, reason: "激活码已被撤销" };
    }

    return { ok: true, reason: "" };
  }

  // ---------- 完整流程 ----------
  /**
   * 激活
   * @param {string} code
   */
  async function activate(code) {
    code = (code || "").trim().toUpperCase();
    if (!code) throw new Error("激活码不能为空");

    const fp = await computeFingerprint();
    const r = await postJson("/activate", {
      code,
      fingerprintHash: fp.hash,
      parts: fp.parts,
    });

    if (!r || r.code !== 200) {
      throw new Error((r && r.msg) || "激活失败");
    }

    // 验签
    const ok = await verifySign(r.data, r.serverTime, r.nonce, r.sign);
    if (!ok) throw new Error("响应签名校验失败");
    if (!checkTimeSkew(r.serverTime)) throw new Error("服务器时间漂移过大");

    const state = {
      activated: true,
      deviceId: r.data.deviceId,
      token: r.data.token,
      code,
      expireAt: r.data.expireAt,
      graceUntil: r.data.graceUntil,
      activatedAt: Date.now(),
      lastVerified: Date.now(),
      _lastMonotonicTs: Date.now(),
      revoked: false,
    };
    await setLicenseState(state);
    return state;
  }

  /**
   * 校验（启动时调用）
   * 如果本地宽限期还有效 → 不联网，直接返回 ok
   * 否则尝试联网 verify
   */
  async function verify() {
    const state = await getLicenseState();
    if (!state || !state.activated) {
      return { ok: false, reason: "未激活", needActivate: true };
    }

    // 时钟回拨 → 强制联网
    const now = Date.now();
    let clockRolledBack = false;
    if (state._lastMonotonicTs && now < state._lastMonotonicTs - 5 * 60 * 1000) {
      clockRolledBack = true;
    }

    // 宽限期内且未撤销且无时钟回拨 → 直接放行
    if (!clockRolledBack && !state.revoked && now <= (Number(state.graceUntil) || 0)) {
      return { ok: true, state, fromCache: true };
    }

    // 联网校验
    try {
      const r = await postJson("/verify", {
        token: state.token,
        fingerprintHash: (await computeFingerprint()).hash,
      });
      if (!r || r.code !== 200) {
        // 后端明确拒绝（撤销/过期/换绑）
        const newState = { ...state, revoked: !!(r && r.data && r.data.revoked) };
        await setLicenseState(newState);
        return { ok: false, reason: (r && r.msg) || "校验失败", state: newState };
      }
      const ok = await verifySign(r.data, r.serverTime, r.nonce, r.sign);
      if (!ok) return { ok: false, reason: "响应签名校验失败", state };
      if (!checkTimeSkew(r.serverTime)) return { ok: false, reason: "服务器时间漂移过大", state };

      const newState = {
        ...state,
        expireAt: r.data.expireAt,
        graceUntil: r.data.graceUntil,
        lastVerified: Date.now(),
        _lastMonotonicTs: Date.now(),
        revoked: false,
      };
      await setLicenseState(newState);
      return { ok: true, state: newState, fromCache: false };
    } catch (e) {
      // 网络失败 → 用本地宽限期兜底
      const g = checkGrace(state);
      if (g.ok) {
        return { ok: true, state, fromCache: true, offline: true };
      }
      return { ok: false, reason: g.reason + "（且无法联网校验）", state, offline: true };
    }
  }

  /**
   * 心跳（alarms 周期触发）
   */
  async function heartbeat() {
    const state = await getLicenseState();
    if (!state || !state.activated) return { ok: false, skip: true };
    try {
      const fp = await computeFingerprint().catch(() => ({ hash: "" }));
      const r = await postJson("/heartbeat", {
        token: state.token,
        fingerprintHash: fp.hash,
      });
      if (!r || r.code !== 200) {
        if (r && r.data && r.data.revoked) {
          await setLicenseState({ ...state, revoked: true });
        }
        return { ok: false, msg: (r && r.msg) || "心跳失败" };
      }
      const ok = await verifySign(r.data, r.serverTime, r.nonce, r.sign);
      if (!ok) return { ok: false, msg: "签名校验失败" };
      const newState = {
        ...state,
        expireAt: r.data.expireAt,
        graceUntil: r.data.graceUntil,
        lastVerified: Date.now(),
        _lastMonotonicTs: Date.now(),
      };
      await setLicenseState(newState);
      return { ok: true };
    } catch (e) {
      return { ok: false, msg: e.message, offline: true };
    }
  }

  /**
   * 解绑当前设备
   */
  async function unbind() {
    const state = await getLicenseState();
    if (!state || !state.activated) return;
    try {
      await postJson("/unbind", { token: state.token });
    } catch (e) {
      // 即便后端失败也清本地（用户可能离线解绑）
    }
    await setLicenseState(null);
  }

  /**
   * 是否已激活且在宽限期内（同步快速判断，业务入口守卫用）
   */
  function isActivatedSync(state) {
    if (!state || !state.activated || state.revoked) return false;
    const now = Date.now();
    if (state._lastMonotonicTs && now < state._lastMonotonicTs - 5 * 60 * 1000) return false;
    return now <= (Number(state.graceUntil) || 0);
  }

  return {
    // utils
    sha256Hex,
    bytesToHex,
    hexToBytes,
    bytesToBase64,
    base64ToBytes,
    randomHex,
    // fingerprint
    computeFingerprint,
    // sign
    getPublicKey,
    verifySign,
    checkTimeSkew,
    // http
    postJson,
    // storage
    getLicenseState,
    setLicenseState,
    // flow
    activate,
    verify,
    heartbeat,
    unbind,
    // check
    checkGrace,
    isActivatedSync,
  };
})();

// 兼容 SW 和 window
if (typeof self !== "undefined") self.LICENSE = LICENSE;
if (typeof window !== "undefined") window.LICENSE = LICENSE;
