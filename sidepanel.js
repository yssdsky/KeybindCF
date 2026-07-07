/* =================== 全局状态 =================== */
let currentAuth = null;       // 最新的 Authorization
let licenseState = null;      // 激活状态
let licenseActivated = false; // 是否已激活（业务入口守卫用）

/* =================== 工具函数 =================== */
function apiUrl(path) {
  return self.CONFIG.BASE_URL + self.CONFIG.API_PREFIX + path;
}

function setAuthStatus(text, type) {
  const el = document.getElementById("authStatus");
  el.textContent = text;
  el.className = "status " + type;
}

function setLicenseStatus(text, type) {
  const el = document.getElementById("licenseStatus");
  el.textContent = text;
  el.className = "status " + type;
}

function fmtDate(ms) {
  if (!ms) return "-";
  const d = new Date(Number(ms));
  if (isNaN(d.getTime())) return "-";
  return d.toLocaleString("zh-CN", { hour12: false });
}

/* =============================================================
 * License 闸门
 * ============================================================= */

// 调 background 完成激活
function bgSendMessage(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(resp || {});
        }
      });
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

function showActivationForm(show) {
  document.getElementById("activationForm").style.display = show ? "" : "none";
}
function showLicenseInfo(show) {
  document.getElementById("licenseInfo").style.display = show ? "" : "none";
}
function showBusinessArea(show) {
  document.getElementById("businessArea").style.display = show ? "" : "none";
}

function renderLicenseUI(state) {
  const deviceId = document.getElementById("licDeviceId");
  const expire = document.getElementById("licExpire");
  const grace = document.getElementById("licGrace");

  if (!state || !state.activated) {
    showActivationForm(true);
    showLicenseInfo(false);
    return;
  }
  showActivationForm(false);
  showLicenseInfo(true);
  deviceId.textContent = state.deviceId || "-";
  expire.textContent = fmtDate(state.expireAt);
  grace.textContent = fmtDate(state.graceUntil);
}

// 启动时调用：先联网校验，再决定是否解锁业务
async function checkLicenseGate() {
  setLicenseStatus("正在检查激活状态...", "pending");
  const r = await bgSendMessage({ type: "LICENSE_VERIFY" });
  if (r && r.ok) {
    licenseState = r.state;
    licenseActivated = true;
    const offlineTag = r.offline ? "（离线/宽限期内）" : (r.fromCache ? "（缓存）" : "");
    setLicenseStatus("已激活" + offlineTag, "ok");
    renderLicenseUI(licenseState);
    showBusinessArea(true);
    await refreshAuth();
    return true;
  }
  licenseActivated = false;
  if (r && r.needActivate) {
    setLicenseStatus("未激活，请输入激活码", "error");
  } else {
    setLicenseStatus("激活失效：" + (r && r.reason || "未知原因"), "error");
  }
  // 即便失效，也展示历史信息（便于查看 deviceId / 到期）
  const resp = await bgSendMessage({ type: "GET_LICENSE" });
  licenseState = resp.state || null;
  renderLicenseUI(licenseState);
  showBusinessArea(false);
  return false;
}

async function onActivateClick() {
  const code = document.getElementById("licenseCode").value.trim();
  if (!code) {
    setLicenseStatus("请输入激活码", "error");
    return;
  }
  setLicenseStatus("正在激活...", "pending");
  document.getElementById("activateBtn").disabled = true;
  try {
    const r = await bgSendMessage({ type: "LICENSE_ACTIVATE", code });
    if (r && r.ok) {
      licenseState = r.state;
      licenseActivated = true;
      setLicenseStatus("激活成功", "ok");
      renderLicenseUI(licenseState);
      showBusinessArea(true);
      await refreshAuth();
    } else {
      setLicenseStatus("激活失败：" + (r && r.error || "未知错误"), "error");
    }
  } catch (e) {
    setLicenseStatus("激活异常：" + e.message, "error");
  } finally {
    document.getElementById("activateBtn").disabled = false;
  }
}

async function onUnbindClick() {
  if (!confirm("确定解绑当前设备？解绑后该设备的占用会立即释放。")) return;
  setLicenseStatus("正在解绑...", "pending");
  const r = await bgSendMessage({ type: "LICENSE_UNBIND" });
  if (r && r.ok) {
    licenseState = null;
    licenseActivated = false;
    setLicenseStatus("已解绑，请重新激活", "pending");
    renderLicenseUI(null);
    showBusinessArea(false);
  } else {
    setLicenseStatus("解绑失败：" + (r && r.error || "未知"), "error");
  }
}

/* =============================================================
 * 业务守卫：未激活直接拦截
 * ============================================================= */
function guardActivated() {
  if (!licenseActivated || !LICENSE.isActivatedSync(licenseState)) {
    licenseActivated = false;
    showBusinessArea(false);
    checkLicenseGate();
    return false;
  }
  return true;
}

/* =============================================================
 * Auth 拉取
 * ============================================================= */
function getAuthFromStorage() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(
        ["latestAuth", "latestAuthTime", "latestAuthUrl", "lastCapture", "bgError"],
        (res) => resolve(res || {})
      );
    } catch (e) { resolve({}); }
  });
}

async function refreshAuth() {
  const s = await getAuthFromStorage();
  renderDebug(s);

  if (s.latestAuth) {
    currentAuth = s.latestAuth;
    const when = s.latestAuthTime
      ? new Date(s.latestAuthTime).toLocaleTimeString("zh-CN", { hour12: false })
      : "";
    setAuthStatus(
      "已拦截到 Authorization" + (when ? "（" + when + "）" : "") + (s.latestAuthUrl ? "：" + s.latestAuthUrl : ""),
      "ok"
    );
    return true;
  }

  currentAuth = null;
  setAuthStatus(
    "尚未拦截到 Authorization。请：1) 打开目标系统 " +
      (self.CONFIG.BASE_URL || "") +
      " 登录并点击任意菜单；2) 或在上方「手动设置」里粘贴 Authorization",
    "error"
  );
  return false;
}

function renderDebug(s) {
  const lastUrl = document.getElementById("lastUrl");
  const lastTime = document.getElementById("lastTime");
  const swPing = document.getElementById("swPing");
  const swError = document.getElementById("swError");

  if (s.lastCapture) {
    const c = s.lastCapture;
    lastUrl.textContent = c.url || "-";
    if (c.time) {
      lastTime.textContent =
        new Date(c.time).toLocaleTimeString("zh-CN", { hour12: false }) +
        "  [" + c.level + "]" +
        (c.authPreview ? "  " + c.authPreview : "") +
        (c.error ? "  " + c.error : "");
    } else {
      lastTime.textContent = "-";
    }
  }

  try {
    chrome.runtime.sendMessage({ type: "PING" }, (resp) => {
      if (chrome.runtime.lastError) {
        swPing.textContent = "未响应：" + chrome.runtime.lastError.message;
      } else if (resp && resp.ok) {
        swPing.textContent = "OK（" + new Date(resp.ts).toLocaleTimeString("zh-CN", { hour12: false }) + "）";
      } else {
        swPing.textContent = "异常";
      }
    });
  } catch (e) {
    swPing.textContent = "异常：" + e.message;
  }

  swError.textContent = s.bgError || "-";
}

/* =============================================================
 * 通用请求（业务侧二次开发参考）
 * ============================================================= */
async function apiFetch(path, options) {
  options = options || {};
  if (!currentAuth) {
    const ok = await refreshAuth();
    if (!ok) throw new Error("未拦截到 Authorization");
  }
  const headers = Object.assign(
    {
      Authorization: currentAuth || "",
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
    },
    options.headers || {}
  );
  const res = await fetch(apiUrl(path), {
    method: options.method || "GET",
    headers,
    body: options.body || undefined,
    credentials: "include",
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
  if (!res.ok && !data.code) {
    throw new Error("HTTP " + res.status + ": " + text.slice(0, 200));
  }
  return data;
}

/* =============================================================
 * 示例 API 调用（演示如何使用捕获到的 Authorization）
 * ============================================================= */
async function onDemoGetClick() {
  if (!guardActivated()) return;
  const path = document.getElementById("demoPath").value.trim();
  const out = document.getElementById("demoResult");
  if (!path) { out.textContent = "请输入 API 路径"; return; }
  out.textContent = "请求中...";
  try {
    const data = await apiFetch(path);
    out.textContent = JSON.stringify(data, null, 2);
  } catch (e) {
    out.textContent = "请求失败：" + e.message;
  }
}

/* =============================================================
 * 手动 Auth
 * ============================================================= */
function saveManualAuth() {
  const v = document.getElementById("manualAuth").value.trim();
  if (!v) { alert("请输入 Authorization 值"); return; }
  chrome.storage.local.set({
    latestAuth: v,
    latestAuthTime: Date.now(),
    latestAuthUrl: "手动输入",
  }, () => {
    alert("已使用手动输入的 Authorization");
    refreshAuth();
  });
}
function clearManualAuth() {
  chrome.storage.local.remove(["latestAuth", "latestAuthTime", "latestAuthUrl"], () => {
    currentAuth = null;
    document.getElementById("manualAuth").value = "";
    refreshAuth();
  });
}

/* =============================================================
 * storage 变化监听
 * ============================================================= */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.latestAuth) refreshAuth();
  if (changes.licenseState) {
    chrome.runtime.sendMessage({ type: "GET_LICENSE" }, (resp) => {
      licenseState = (resp && resp.state) || null;
      renderLicenseUI(licenseState);
    });
  }
});

/* =============================================================
 * background 推送：license 失效或更新
 * ============================================================= */
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return;
  if (msg.type === "LICENSE_UPDATED" && msg.state) {
    licenseState = msg.state;
    licenseActivated = LICENSE.isActivatedSync(licenseState);
    renderLicenseUI(licenseState);
    if (licenseActivated) {
      setLicenseStatus("已激活（心跳续签成功）", "ok");
    }
  } else if (msg.type === "LICENSE_REVOKED") {
    licenseActivated = false;
    setLicenseStatus("激活已失效：" + (msg.msg || "服务端拒绝"), "error");
    showBusinessArea(false);
  } else if (msg.type === "AUTH_UPDATED") {
    refreshAuth();
  }
});

/* =============================================================
 * 事件绑定
 * ============================================================= */
document.getElementById("refreshBtn").addEventListener("click", () => {
  if (licenseActivated) refreshAuth(); else checkLicenseGate();
});
document.getElementById("saveManualAuth").addEventListener("click", saveManualAuth);
document.getElementById("clearManualAuth").addEventListener("click", clearManualAuth);
document.getElementById("activateBtn").addEventListener("click", onActivateClick);
document.getElementById("unbindBtn").addEventListener("click", onUnbindClick);
document.getElementById("demoGetBtn").addEventListener("click", onDemoGetClick);

document.getElementById("licenseCode").addEventListener("keydown", (e) => {
  if (e.key === "Enter") onActivateClick();
});

/* =============================================================
 * 启动
 * ============================================================= */
(async () => {
  // 1. 先检查激活（不依赖业务 Auth）
  await checkLicenseGate();
  // 2. 若已激活，则周期性刷新 Auth 状态（用于呈现最新拦截信息）
  setInterval(() => { if (licenseActivated) refreshAuth(); }, 2000);
})();
