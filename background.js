const REMOTE_API_BASE_URL = "https://voicetext.world";
const BILLING_ENDPOINTS = [REMOTE_API_BASE_URL];
const FREE_TRIAL_SESSIONS = 15;
const UNINSTALL_URL = `${REMOTE_API_BASE_URL}/uninstall.html`;
const DEVICE_TOKEN_KEY = "deviceToken";
const AUTH_SESSION_KEY = "authSession";
const LOCAL_TRIAL_STATE_KEY = "localTrialState";
const SUBSCRIPTION_CACHE_MS = 30 * 1000;

let subscriptionCache = {
  deviceToken: "",
  active: false,
  status: "none",
  plan: null,
  sessionsLeft: FREE_TRIAL_SESSIONS,
  freeTrialSessions: FREE_TRIAL_SESSIONS,
  timestamp: 0,
};

const tabStateCache = new Map();

async function configureSidePanelBehavior() {
  if (!chrome.sidePanel?.setPanelBehavior) {
    return;
  }

  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (_error) {
    // Best effort only.
  }
}

void configureSidePanelBehavior();

chrome.runtime.setUninstallURL?.(UNINSTALL_URL).catch(() => {});

function isRemoteConfigured() {
  return Boolean(REMOTE_API_BASE_URL) && !/your-domain\.com/i.test(REMOTE_API_BASE_URL);
}

chrome.runtime.onInstalled.addListener((details) => {
  void configureSidePanelBehavior();
  if (details.reason !== "install") {
    return;
  }

  chrome.storage.local.set({ welcomeShown: true });
  chrome.tabs.create({
    url: "https://voicetext.world/welcome.html",
  });
});

chrome.runtime.onStartup?.addListener(() => {
  void configureSidePanelBehavior();
});

function readStorage(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => resolve(result || {}));
  });
}

function writeStorage(payload) {
  return new Promise((resolve) => {
    chrome.storage.local.set(payload, () => resolve());
  });
}

async function getOrCreateDeviceToken() {
  const result = await readStorage([DEVICE_TOKEN_KEY]);
  const existing = typeof result?.[DEVICE_TOKEN_KEY] === "string" ? result[DEVICE_TOKEN_KEY] : "";
  if (existing) {
    return existing;
  }

  const created =
    (self.crypto && self.crypto.randomUUID && self.crypto.randomUUID()) ||
    `device_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  await writeStorage({ [DEVICE_TOKEN_KEY]: created });
  return created;
}

async function fetchJsonFromEndpoints(pathname, options = {}) {
  const deviceToken = await getOrCreateDeviceToken();
  let lastError = null;

  for (const baseUrl of BILLING_ENDPOINTS) {
    try {
      const timeoutMs = Math.max(0, Number(options.timeoutMs) || 0);
      const headers = {
        ...(options.headers || {}),
        "x-device-token": deviceToken,
      };
      const requestOptions = {
        ...options,
        headers,
      };
      delete requestOptions.timeoutMs;

      let timeoutId = null;
      const abortController = timeoutMs ? new AbortController() : null;
      if (abortController) {
        requestOptions.signal = abortController.signal;
        timeoutId = setTimeout(() => abortController.abort(), timeoutMs);
      }

      const response = await fetch(`${baseUrl}${pathname}`, requestOptions);
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      const text = await response.text();
      let data = {};
      if (text) {
        try {
          data = JSON.parse(text);
        } catch (_error) {
          data = { raw: text };
        }
      }

      if (!response.ok) {
        throw new Error(data?.error || `Request failed with ${response.status}`);
      }

      return data;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(lastError?.message || "Remote billing server is unreachable.");
}

async function getAuthState() {
  const deviceToken = await getOrCreateDeviceToken();
  const cached = await readStorage([AUTH_SESSION_KEY]);
  const cachedSession = cached?.[AUTH_SESSION_KEY];

  if (!isRemoteConfigured()) {
    const email = typeof cachedSession?.email === "string" ? cachedSession.email.trim() : "";
    return {
      signedIn: false,
      email,
      method: null,
      signedInAt: null,
      deviceToken,
    };
  }

  try {
    const data = await fetchJsonFromEndpoints(`/auth/me?device_token=${encodeURIComponent(deviceToken)}`);
    const session = {
      email: typeof data?.email === "string" ? data.email.trim() : "",
      method: data?.method || null,
      signedInAt: data?.signedInAt || null,
    };
    await writeStorage({ [AUTH_SESSION_KEY]: session.email ? session : null });
    return {
      signedIn: Boolean(session.email),
      email: session.email,
      method: session.method,
      signedInAt: session.signedInAt,
      deviceToken,
    };
  } catch (_error) {
    const email = typeof cachedSession?.email === "string" ? cachedSession.email.trim() : "";
    return {
      signedIn: Boolean(email),
      email,
      method: email ? cachedSession?.method || "google" : null,
      signedInAt: cachedSession?.signedInAt || null,
      deviceToken,
    };
  }
}

async function signOut() {
  const deviceToken = await getOrCreateDeviceToken();
  if (isRemoteConfigured()) {
    try {
      await fetchJsonFromEndpoints("/auth/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_token: deviceToken }),
      });
    } catch (_error) {
      // Clear local auth state even when backend logout is unavailable.
    }
  }

  await writeStorage({ [AUTH_SESSION_KEY]: null });
  subscriptionCache.timestamp = 0;
  return {
    signedIn: false,
    email: "",
    method: null,
    signedInAt: null,
    deviceToken,
  };
}

async function startGoogleSignIn(returnUrl) {
  const deviceToken = await getOrCreateDeviceToken();
  if (!isRemoteConfigured()) {
    throw new Error("Configure the product domain and backend before Google sign-in.");
  }
  const target = new URL(`${REMOTE_API_BASE_URL}/auth/google/start`);
  target.searchParams.set("device_token", deviceToken);
  if (typeof returnUrl === "string" && returnUrl.trim()) {
    target.searchParams.set("return_url", returnUrl.trim());
  }
  await chrome.tabs.create({ url: target.toString() });
  return { started: true, deviceToken };
}

function getDefaultLocalTrialState() {
  return {
    sessionsLeft: FREE_TRIAL_SESSIONS,
    updatedAt: Date.now(),
  };
}

async function getLocalTrialState() {
  const result = await readStorage([LOCAL_TRIAL_STATE_KEY]);
  const raw = result?.[LOCAL_TRIAL_STATE_KEY];
  if (!raw || !Number.isFinite(Number(raw.sessionsLeft))) {
    const initial = getDefaultLocalTrialState();
    await writeStorage({ [LOCAL_TRIAL_STATE_KEY]: initial });
    return initial;
  }

  const normalized = {
    sessionsLeft: Math.max(0, Math.min(FREE_TRIAL_SESSIONS, Math.floor(Number(raw.sessionsLeft)))),
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
  if (
    normalized.sessionsLeft !== Number(raw.sessionsLeft) ||
    normalized.updatedAt !== Number(raw.updatedAt)
  ) {
    await writeStorage({ [LOCAL_TRIAL_STATE_KEY]: normalized });
  }
  return normalized;
}

async function consumeLocalTrialSession() {
  const current = await getLocalTrialState();
  if (current.sessionsLeft <= 0) {
    throw new Error("Free trial ended. Upgrade to continue dictation.");
  }

  const next = {
    sessionsLeft: Math.max(0, current.sessionsLeft - 1),
    updatedAt: Date.now(),
  };
  await writeStorage({ [LOCAL_TRIAL_STATE_KEY]: next });
  return next;
}

async function getSubscriptionStatus(forceRefresh = false) {
  const deviceToken = await getOrCreateDeviceToken();
  const now = Date.now();
  const localState = await getLocalTrialState();

  if (
    !forceRefresh &&
    subscriptionCache.deviceToken === deviceToken &&
    now - subscriptionCache.timestamp < SUBSCRIPTION_CACHE_MS
  ) {
    return {
      deviceToken,
      active: subscriptionCache.active,
      status: subscriptionCache.status,
      plan: subscriptionCache.plan,
      sessionsLeft: subscriptionCache.active ? null : localState.sessionsLeft,
      freeTrialSessions: FREE_TRIAL_SESSIONS,
    };
  }

  if (!isRemoteConfigured()) {
    subscriptionCache = {
      deviceToken,
      active: false,
      status: "none",
      plan: null,
      sessionsLeft: localState.sessionsLeft,
      freeTrialSessions: FREE_TRIAL_SESSIONS,
      timestamp: now,
    };
    return {
      deviceToken,
      active: false,
      status: "none",
      plan: null,
      sessionsLeft: localState.sessionsLeft,
      freeTrialSessions: FREE_TRIAL_SESSIONS,
    };
  }

  try {
    const data = await fetchJsonFromEndpoints("/me");
    subscriptionCache = {
      deviceToken,
      active: !!data.paid,
      status: data.subscriptionStatus || "none",
      plan: data.plan ? { planId: data.plan } : null,
      sessionsLeft: localState.sessionsLeft,
      freeTrialSessions: FREE_TRIAL_SESSIONS,
      timestamp: now,
    };

    return {
      deviceToken,
      active: subscriptionCache.active,
      status: subscriptionCache.status,
      plan: subscriptionCache.plan,
      sessionsLeft: subscriptionCache.active ? null : localState.sessionsLeft,
      freeTrialSessions: FREE_TRIAL_SESSIONS,
    };
  } catch (_error) {
    subscriptionCache = {
      deviceToken,
      active: false,
      status: "none",
      plan: null,
      sessionsLeft: localState.sessionsLeft,
      freeTrialSessions: FREE_TRIAL_SESSIONS,
      timestamp: now,
    };
    return {
      deviceToken,
      active: false,
      status: "none",
      plan: null,
      sessionsLeft: localState.sessionsLeft,
      freeTrialSessions: FREE_TRIAL_SESSIONS,
    };
  }
}

async function getDictationQuota() {
  const sub = await getSubscriptionStatus(false).catch(() => ({
    active: false,
    sessionsLeft: FREE_TRIAL_SESSIONS,
  }));

  const sessionsLeft = sub.active
    ? null
    : Number.isFinite(Number(sub.sessionsLeft))
    ? Math.max(0, Math.floor(Number(sub.sessionsLeft)))
    : 0;

  return {
    isSubscribed: !!sub.active,
    subscriptionStatus: sub.status || "none",
    plan: sub.plan || null,
    sessionsLeft,
    freeTrialSessions: FREE_TRIAL_SESSIONS,
    canStart: sub.active || sessionsLeft > 0,
  };
}

async function consumeDictationSession() {
  const sub = await getSubscriptionStatus(true);
  if (sub.active) {
    return {
      isSubscribed: true,
      sessionsLeft: null,
      freeTrialSessions: FREE_TRIAL_SESSIONS,
      subscriptionStatus: sub.status || "none",
      plan: sub.plan || null,
    };
  }

  const localState = await consumeLocalTrialSession();
  subscriptionCache = {
    deviceToken: await getOrCreateDeviceToken(),
    active: false,
    status: "none",
    plan: null,
    sessionsLeft: localState.sessionsLeft,
    freeTrialSessions: FREE_TRIAL_SESSIONS,
    timestamp: Date.now(),
  };

  return {
    isSubscribed: false,
    sessionsLeft: localState.sessionsLeft,
    freeTrialSessions: FREE_TRIAL_SESSIONS,
    subscriptionStatus: "none",
    plan: null,
  };
}

async function createCheckoutSession(planId, returnUrl) {
  const deviceToken = await getOrCreateDeviceToken();
  if (!isRemoteConfigured()) {
    throw new Error("Configure the product backend before opening checkout.");
  }
  const authState = await getAuthState();

  if (!authState.signedIn || !authState.email) {
    throw new Error("Sign in required before checkout.");
  }

  const data = await fetchJsonFromEndpoints("/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      device_token: deviceToken,
      plan: planId,
      return_url: returnUrl || "",
    }),
  });

  return {
    deviceToken,
    email: authState.email,
    url: data.url,
    sessionId: data.sessionId || null,
  };
}

async function trackAnalyticsEvent(name, params = {}, sessionId = "") {
  const data = await fetchJsonFromEndpoints("/analytics/event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      params,
      sessionId,
    }),
  });
  return {
    tracked: data?.ok !== false,
    skipped: !!data?.skipped,
    reason: data?.reason || null,
  };
}

function getDefaultTabState() {
  return {
    connected: false,
    supported: false,
    isDocsPage: false,
    status: "idle",
    message: "Open a Google Doc and place the text cursor before starting dictation.",
    transcript: "",
    interimTranscript: "",
    docTitle: "",
    language: "Auto",
    insertedChars: 0,
    sessionSeconds: 0,
    cursorReady: false,
  };
}

function queryActiveTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(tabs?.[0] || null);
    });
  });
}

function activateTab(tabId, windowId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.update(tabId, { active: true }, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      if (typeof windowId === "number") {
        chrome.windows.update(windowId, { focused: true }, () => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(tab);
        });
        return;
      }

      resolve(tab);
    });
  });
}

function attachDebugger(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, "1.3", () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function detachDebugger(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.detach(target, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function sendDebuggerCommand(target, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result);
    });
  });
}

async function nativeTypeTextInTab(tabId, windowId, text) {
  const normalized = typeof text === "string" ? text : "";
  if (!normalized.trim()) {
    throw new Error("Nothing to insert.");
  }

  await activateTab(tabId, windowId).catch(() => null);
  const target = { tabId };
  await attachDebugger(target);

  try {
    for (const char of normalized) {
      if (char === "\n") {
        await sendDebuggerCommand(target, "Input.dispatchKeyEvent", {
          type: "rawKeyDown",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
        });
        await sendDebuggerCommand(target, "Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
        });
        continue;
      }

      await sendDebuggerCommand(target, "Input.insertText", { text: char });
    }

    return { inserted: true };
  } finally {
    await detachDebugger(target).catch(() => null);
  }
}

async function getActiveDocsTab() {
  const tab = await queryActiveTab();
  if (!tab?.id) {
    throw new Error("No active tab found.");
  }

  const url = typeof tab.url === "string" ? tab.url : "";
  if (!url.startsWith("https://docs.google.com/document/")) {
    throw new Error("Open a Google Docs document first.");
  }

  return tab;
}

function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "Tab request failed."));
        return;
      }
      resolve(response);
    });
  });
}

function executeScript(tabId, files) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        files,
      },
      () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      }
    );
  });
}

async function ensureDocsContentScript(tabId) {
  try {
    await sendMessageToTab(tabId, { type: "getDictationState" });
    return;
  } catch (_error) {
    await executeScript(tabId, ["contentScript.js"]);
  }
}

async function getDictationState() {
  const tab = await queryActiveTab();
  if (!tab?.id) {
    return getDefaultTabState();
  }

  const defaultState = {
    ...getDefaultTabState(),
    isDocsPage: typeof tab.url === "string" && tab.url.startsWith("https://docs.google.com/document/"),
    docTitle: tab.title || "",
  };

  if (!defaultState.isDocsPage) {
    return defaultState;
  }

  try {
    await ensureDocsContentScript(tab.id);
    const response = await sendMessageToTab(tab.id, { type: "getDictationState" });
    const nextState = {
      ...defaultState,
      ...response.state,
      connected: true,
      supported: response.state?.supported !== false,
    };
    tabStateCache.set(tab.id, nextState);
    return nextState;
  } catch (_error) {
    const cached = tabStateCache.get(tab.id);
    return cached
      ? { ...defaultState, ...cached, connected: true }
      : {
          ...defaultState,
          message: "Reload this Google Docs tab so the extension can connect.",
          connected: false,
        };
  }
}

async function startDictation() {
  const tab = await getActiveDocsTab();
  const quota = await getDictationQuota();
  if (!quota.canStart) {
    throw new Error("Free trial ended. Upgrade to continue dictation.");
  }

  await ensureDocsContentScript(tab.id);
  const response = await sendMessageToTab(tab.id, {
    type: "startDictation",
  });

  let updatedQuota = quota;
  if (!quota.isSubscribed && response?.started && !response?.alreadyRunning) {
    updatedQuota = await consumeDictationSession();
  }

  return {
    tabId: tab.id,
    ...response,
    quota: updatedQuota,
  };
}

async function stopDictation() {
  const tab = await getActiveDocsTab();
  const response = await sendMessageToTab(tab.id, { type: "stopDictation" });
  return {
    tabId: tab.id,
    ...response,
  };
}

async function openGoogleDocs() {
  const createdTab = await chrome.tabs.create({ url: "https://docs.google.com/document/create" });
  return { opened: true, reused: false, tabId: createdTab?.id || null };
}

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStateCache.delete(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type) {
    return false;
  }

  if (message.type === "dictationStateUpdate") {
    if (sender.tab?.id) {
      tabStateCache.set(sender.tab.id, {
        ...getDefaultTabState(),
        ...(message.state || {}),
        connected: true,
      });
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "getDictationQuota") {
    getDictationQuota()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Failed to read quota." }));
    return true;
  }

  if (message.type === "getAuthState") {
    getAuthState()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Failed to read auth state." }));
    return true;
  }

  if (message.type === "startGoogleSignIn") {
    startGoogleSignIn(message.returnUrl)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Failed to start Google sign-in." }));
    return true;
  }

  if (message.type === "signOut") {
    signOut()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Failed to sign out." }));
    return true;
  }

  if (message.type === "refreshSubscriptionStatus") {
    getSubscriptionStatus(true)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Failed to refresh subscription status." }));
    return true;
  }

  if (message.type === "trackAnalyticsEvent") {
    trackAnalyticsEvent(message.name, message.params, message.sessionId)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Failed to track analytics event." }));
    return true;
  }

  if (message.type === "createCheckoutSession") {
    createCheckoutSession(message.planId, message.returnUrl)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Failed to create checkout session." }));
    return true;
  }

  if (message.type === "getDictationState") {
    getDictationState()
      .then((result) => sendResponse({ ok: true, state: result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Failed to read dictation state." }));
    return true;
  }

  if (message.type === "startDictation") {
    startDictation()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Failed to start dictation." }));
    return true;
  }

  if (message.type === "stopDictation") {
    stopDictation()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Failed to stop dictation." }));
    return true;
  }

  if (message.type === "openGoogleDocs") {
    openGoogleDocs()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Failed to open Google Docs." }));
    return true;
  }

  if (message.type === "nativeTypeText") {
    if (!sender.tab?.id) {
      sendResponse({ ok: false, error: "No Google Docs tab is attached to this request." });
      return false;
    }

    nativeTypeTextInTab(sender.tab.id, sender.tab.windowId, message.text)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) =>
        sendResponse({ ok: false, error: error.message || "Failed to type text into Google Docs." })
      );
    return true;
  }

  return false;
});
