const REMOTE_API_BASE_URL = "https://pdftext2speech.com";

const TTS_ENDPOINTS = [
  `${REMOTE_API_BASE_URL}/tts`,
];

const BILLING_ENDPOINTS = [
  REMOTE_API_BASE_URL,
];

const FREE_MINUTES = 5;
const DEVICE_TOKEN_KEY = "deviceToken";
const AUTH_SESSION_KEY = "authSession";

const SUBSCRIPTION_CACHE_MS = 30 * 1000;
let subscriptionCache = {
  deviceToken: "",
  active: false,
  status: "none",
  plan: null,
  minutesLeft: FREE_MINUTES,
  timestamp: 0,
};

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason !== "install") {
    return;
  }

  chrome.tabs.create({
    url: chrome.runtime.getURL("welcome.html"),
  });
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

async function readUsageSeconds() {
  return 0;
}

async function writeUsageSeconds(value) {
  return value;
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

async function getAuthState() {
  const deviceToken = await getOrCreateDeviceToken();
  const cached = await readStorage([AUTH_SESSION_KEY]);
  const cachedSession = cached?.[AUTH_SESSION_KEY];

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
      method: email ? cachedSession?.method || "email" : null,
      signedInAt: cachedSession?.signedInAt || null,
      deviceToken,
    };
  }
}

async function signOut() {
  const deviceToken = await getOrCreateDeviceToken();
  try {
    await fetchJsonFromEndpoints("/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_token: deviceToken }),
    });
  } catch (_error) {
    // Clear local state even if the remote logout endpoint is not available.
  }
  await writeStorage({ [AUTH_SESSION_KEY]: null });
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
  const target = new URL(`${REMOTE_API_BASE_URL}/auth/google/start`);
  target.searchParams.set("device_token", deviceToken);
  if (typeof returnUrl === "string" && returnUrl.trim()) {
    target.searchParams.set("return_url", returnUrl.trim());
  }
  await chrome.tabs.create({ url: target.toString() });
  return { started: true, deviceToken };
}

async function fetchJsonFromEndpoints(pathname, options = {}) {
  const deviceToken = await getOrCreateDeviceToken();
  let lastError = null;

  for (const baseUrl of BILLING_ENDPOINTS) {
    try {
      const headers = {
        ...(options.headers || {}),
        "x-device-token": deviceToken,
      };
      const response = await fetch(`${baseUrl}${pathname}`, {
        ...options,
        headers,
      });
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

async function getSubscriptionStatus(forceRefresh = false) {
  const deviceToken = await getOrCreateDeviceToken();
  const now = Date.now();

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
      minutesLeft: subscriptionCache.minutesLeft,
    };
  }

  const data = await fetchJsonFromEndpoints("/me");

  subscriptionCache = {
    deviceToken,
    active: !!data.paid,
    status: data.subscriptionStatus || "none",
    plan: data.plan ? { planId: data.plan } : null,
    minutesLeft: Number.isFinite(Number(data.minutesLeft))
      ? Math.max(0, Number(data.minutesLeft))
      : FREE_MINUTES,
    timestamp: now,
  };

  return {
    deviceToken,
    active: subscriptionCache.active,
    status: subscriptionCache.status,
    plan: subscriptionCache.plan,
    minutesLeft: subscriptionCache.minutesLeft,
  };
}

async function getPlaybackQuota() {
  const sub = await getSubscriptionStatus(false).catch(() => ({ active: false }));
  const minutesLeft = Number.isFinite(Number(sub.minutesLeft))
    ? Math.max(0, Number(sub.minutesLeft))
    : sub.active
    ? Number.MAX_SAFE_INTEGER
    : 0;
  const remainingSeconds = minutesLeft * 60;

  if (sub.active) {
    return {
      usedSeconds: 0,
      limitSeconds: remainingSeconds,
      remainingSeconds,
      isLimited: remainingSeconds <= 0,
      isSubscribed: true,
      subscriptionStatus: sub.status || "active",
      plan: sub.plan || null,
    };
  }

  return {
    usedSeconds: 0,
    limitSeconds: FREE_MINUTES * 60,
    remainingSeconds,
    isLimited: remainingSeconds <= 0,
    isSubscribed: false,
    subscriptionStatus: "none",
    plan: sub.plan || null,
  };
}

async function addPlaybackUsage(rawSeconds) {
  void rawSeconds;
  return getPlaybackQuota();
}

async function fetchPdfBytes(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Background fetch failed (${response.status}).`);
  }
  const buffer = await response.arrayBuffer();
  return { bytes: Array.from(new Uint8Array(buffer)) };
}

async function synthesizeSpeech({ text, speed, language }) {
  if (!text || typeof text !== "string") {
    throw new Error("TTS text is empty.");
  }

  const deviceToken = await getOrCreateDeviceToken();
  let lastError = null;
  for (const endpoint of TTS_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-device-token": deviceToken,
        },
        body: JSON.stringify({ input: text, speed, language }),
      });

      if (!response.ok) {
        const details = await response.text().catch(() => "");
        throw new Error(
          `Remote TTS returned ${response.status}${details ? `: ${details}` : ""}`
        );
      }

      const buffer = await response.arrayBuffer();
      return {
        bytes: Array.from(new Uint8Array(buffer)),
        mimeType: response.headers.get("content-type") || "audio/mpeg",
      };
    } catch (error) {
      lastError = error;
    }
  }

  const message =
    lastError && lastError.message
      ? lastError.message
      : "Unable to reach the remote TTS service.";
  throw new Error(message);
}

async function createCheckoutSession(planId, returnUrl) {
  void returnUrl;
  const deviceToken = await getOrCreateDeviceToken();
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
    }),
  });
  return {
    deviceToken,
    email: authState.email,
    url: data.url,
    sessionId: data.sessionId || null,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message?.type) {
    return false;
  }

  if (message.type === "getPlaybackQuota") {
    getPlaybackQuota()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        const errorMessage =
          error && error.message ? error.message : "Failed to read quota.";
        sendResponse({ ok: false, error: errorMessage });
      });
    return true;
  }

  if (message.type === "addPlaybackUsage") {
    addPlaybackUsage(message.seconds)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        const errorMessage =
          error && error.message ? error.message : "Failed to save quota.";
        sendResponse({ ok: false, error: errorMessage });
      });
    return true;
  }

  if (message.type === "createCheckoutSession") {
    createCheckoutSession(message.planId, message.returnUrl)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        const errorMessage =
          error && error.message ? error.message : "Failed to create checkout session.";
        sendResponse({ ok: false, error: errorMessage });
      });
    return true;
  }

  if (message.type === "getAuthState") {
    getAuthState()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        const errorMessage =
          error && error.message ? error.message : "Failed to read auth state.";
        sendResponse({ ok: false, error: errorMessage });
      });
    return true;
  }

  if (message.type === "startGoogleSignIn") {
    startGoogleSignIn(message.returnUrl)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        const errorMessage =
          error && error.message ? error.message : "Failed to start Google sign-in.";
        sendResponse({ ok: false, error: errorMessage });
      });
    return true;
  }

  if (message.type === "signOut") {
    signOut()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        const errorMessage =
          error && error.message ? error.message : "Failed to sign out.";
        sendResponse({ ok: false, error: errorMessage });
      });
    return true;
  }

  if (message.type === "refreshSubscriptionStatus") {
    getSubscriptionStatus(true)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        const errorMessage =
          error && error.message ? error.message : "Failed to refresh subscription status.";
        sendResponse({ ok: false, error: errorMessage });
      });
    return true;
  }

  if (message.type === "fetchPdfBytes" && message.url) {
    fetchPdfBytes(message.url)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        const errorMessage =
          error && error.message ? error.message : "Background fetch failed.";
        sendResponse({ ok: false, error: errorMessage });
      });
    return true;
  }

  if (message.type === "synthesizeSpeech") {
    synthesizeSpeech(message)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        const errorMessage =
          error && error.message ? error.message : "TTS request failed.";
        sendResponse({ ok: false, error: errorMessage });
      });
    return true;
  }

  return false;
});
