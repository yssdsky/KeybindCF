// Service Worker：拦截请求头、捕获最新 Authorization、license 心跳
try {
  importScripts("config.js");
  importScripts("license.js");
} catch (e) {
  self.CONFIG = self.CONFIG || {
    BASE_URL: "https://test.com",
    API_PREFIX: "/prod-api",
    CAPTURE_URL_PATTERN: "/prod-api",
    LICENSE_SERVER_URL: "",
    LICENSE_PUBKEY: "",
    LICENSE_GRACE_DAYS: 7,
  };
  chrome.storage.local.set({ bgError: "importScripts failed: " + e.message });
}

const CAPTURE_PATTERN =
  (self.CONFIG && self.CONFIG.CAPTURE_URL_PATTERN) || "/prod-api";

// 记录最近一次拦截详情（便于排查）
function recordCapture(level, info) {
  chrome.storage.local.set({
    lastCapture: {
      level,
      time: Date.now(),
      ...info,
    },
  });
}

// =============================================================
// 1. 拦截 Authorization（原有功能）
// =============================================================
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    try {
      const url = details.url || "";
      if (!url.includes(CAPTURE_PATTERN)) return;

      const headers = details.requestHeaders || [];
      const authHeader = headers.find(
        (h) => (h.name || "").toLowerCase() === "authorization"
      );

      if (authHeader && authHeader.value) {
        const value = authHeader.value;
        chrome.storage.local.get(["latestAuth"], (res) => {
          if (res.latestAuth !== value) {
            chrome.storage.local.set({
              latestAuth: value,
              latestAuthTime: Date.now(),
              latestAuthUrl: url,
            });
            chrome.runtime
              .sendMessage({ type: "AUTH_UPDATED", value, url })
              .catch(() => {});
          }
          recordCapture("hit", {
            url,
            hasAuth: true,
            authPreview: value.slice(0, 24) + "...",
          });
        });
      } else {
        recordCapture("miss_no_auth", { url, headerCount: headers.length });
      }
    } catch (e) {
      recordCapture("error", { error: e.message });
    }
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"]
);

// =============================================================
// 2. License 心跳（alarms 每 30 分钟）
// =============================================================
const HEARTBEAT_ALARM = "licenseHeartbeat";

chrome.runtime.onInstalled.addListener(() => {
  // 让点击图标直接打开 side panel
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((err) => console.error("setPanelBehavior 失败:", err));
  }
  // 注册心跳 alarm（periodInMinutes 最小值在 MV3 中为 0.5）
  chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 30 });
  // 安装时立即触发一次校验
  doHeartbeat();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === HEARTBEAT_ALARM) {
    doHeartbeat();
  }
});

async function doHeartbeat() {
  try {
    const r = await LICENSE.heartbeat();
    if (r && r.ok) {
      chrome.runtime
        .sendMessage({ type: "LICENSE_UPDATED", state: await LICENSE.getLicenseState() })
        .catch(() => {});
    } else if (r && r.msg && !r.offline) {
      // 后端明确拒绝（撤销/过期等）→ 通知 sidepanel
      chrome.runtime
        .sendMessage({ type: "LICENSE_REVOKED", msg: r.msg })
        .catch(() => {});
    }
  } catch (e) {
    // 静默失败（宽限期内不影响业务）
    console.warn("[license] heartbeat error:", e);
  }
}

// =============================================================
// 3. 消息处理
// =============================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  // --- Auth ---
  if (msg.type === "GET_AUTH") {
    chrome.storage.local.get(
      ["latestAuth", "latestAuthTime", "latestAuthUrl"],
      (res) => {
        sendResponse({
          authorization: res.latestAuth || null,
          time: res.latestAuthTime || null,
          url: res.latestAuthUrl || null,
        });
      }
    );
    return true;
  }

  if (msg.type === "PING") {
    sendResponse({ ok: true, ts: Date.now() });
    return false;
  }

  // --- License ---
  if (msg.type === "GET_LICENSE") {
    LICENSE.getLicenseState().then((state) => {
      sendResponse({ state });
    });
    return true;
  }

  if (msg.type === "LICENSE_ACTIVATE") {
    LICENSE.activate(msg.code)
      .then((state) => sendResponse({ ok: true, state }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === "LICENSE_VERIFY") {
    LICENSE.verify()
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, reason: e.message }));
    return true;
  }

  if (msg.type === "LICENSE_UNBIND") {
    LICENSE.unbind()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === "LICENSE_HEARTBEAT_NOW") {
    doHeartbeat().then(() => sendResponse({ ok: true }));
    return true;
  }
});
