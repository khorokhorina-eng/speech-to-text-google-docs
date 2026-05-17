const statusEl = document.getElementById("status");
const hintEl = document.getElementById("hint");
const docTitleEl = document.getElementById("docTitle");
const quotaEl = document.getElementById("quota");
const languageSelectEl = document.getElementById("languageSelect");
const recordingTipsEl = document.getElementById("recordingTips");
const startBtn = document.getElementById("start");
const stopBtn = document.getElementById("stop");
const upgradeBtn = document.getElementById("upgrade");
const contactBtn = document.getElementById("contact");
const accountActionBtn = document.getElementById("accountAction");
const paywallStatusEl = document.getElementById("paywallStatus");
const trialEndedNoticeEl = document.getElementById("trialEndedNotice");
const trialUpgradeBtn = document.getElementById("trialUpgrade");
const continueCheckoutMonthlyBtn = document.getElementById("continueCheckoutMonthly");
const continueCheckoutAnnualBtn = document.getElementById("continueCheckoutAnnual");
const authMessageEl = document.getElementById("authMessage");
const authCopyEl = document.getElementById("authCopy");
const authGoogleBtn = document.getElementById("authGoogle");
const authPanelEl = document.getElementById("authPanel");
const authSignedInEl = document.getElementById("authSignedIn");
const authSignedInTextEl = document.getElementById("authSignedInText");
const authSignOutBtn = document.getElementById("authSignOut");
const profileTriggerBtn = document.getElementById("profileTrigger");
const closeDrawerBtn = document.getElementById("closeDrawer");
const drawerBackdropEl = document.getElementById("drawerBackdrop");
const drawerPlanNameEl = document.getElementById("drawerPlanName");
const drawerPlanMetaEl = document.getElementById("drawerPlanMeta");
const drawerEmailEl = document.getElementById("drawerEmail");
const drawerUpgradeBtn = document.getElementById("drawerUpgrade");
const authToastEl = document.getElementById("authToast");
const authOverlayEl = document.getElementById("authOverlay");
const readerScreenEl = document.getElementById("readerScreen");
const paywallScreenEl = document.getElementById("paywallScreen");
const backToReaderBtn = document.getElementById("backToReader");

const ANALYTICS_SESSION_ID = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
const FREE_TRIAL_SESSIONS = 15;
const RECOGNITION_LANGUAGE_OPTIONS = [
  { value: "Auto", label: "Auto (browser language)" },
  { value: "am-ET", label: "Amharic" },
  { value: "ar", label: "Arabic" },
  { value: "bg-BG", label: "Bulgarian" },
  { value: "bn-BD", label: "Bengali" },
  { value: "ca-ES", label: "Catalan" },
  { value: "cs-CZ", label: "Czech" },
  { value: "da-DK", label: "Danish" },
  { value: "de-DE", label: "German" },
  { value: "el-GR", label: "Greek" },
  { value: "en-US", label: "English" },
  { value: "es-ES", label: "Spanish" },
  { value: "es-419", label: "Spanish (Latin America)" },
  { value: "et-EE", label: "Estonian" },
  { value: "fa-IR", label: "Persian" },
  { value: "fi-FI", label: "Finnish" },
  { value: "fil-PH", label: "Filipino" },
  { value: "fr-FR", label: "French" },
  { value: "gu-IN", label: "Gujarati" },
  { value: "he-IL", label: "Hebrew" },
  { value: "hi-IN", label: "Hindi" },
  { value: "hr-HR", label: "Croatian" },
  { value: "hu-HU", label: "Hungarian" },
  { value: "id-ID", label: "Indonesian" },
  { value: "it-IT", label: "Italian" },
  { value: "ja-JP", label: "Japanese" },
  { value: "kn-IN", label: "Kannada" },
  { value: "ko-KR", label: "Korean" },
  { value: "lt-LT", label: "Lithuanian" },
  { value: "lv-LV", label: "Latvian" },
  { value: "ml-IN", label: "Malayalam" },
  { value: "mr-IN", label: "Marathi" },
  { value: "ms-MY", label: "Malay" },
  { value: "nl-NL", label: "Dutch" },
  { value: "no-NO", label: "Norwegian" },
  { value: "pl-PL", label: "Polish" },
  { value: "pt-BR", label: "Portuguese (Brazil)" },
  { value: "pt-PT", label: "Portuguese (Portugal)" },
  { value: "ro-RO", label: "Romanian" },
  { value: "ru-RU", label: "Russian" },
  { value: "sk-SK", label: "Slovak" },
  { value: "sl-SI", label: "Slovenian" },
  { value: "sr-RS", label: "Serbian" },
  { value: "sv-SE", label: "Swedish" },
  { value: "sw-KE", label: "Swahili" },
  { value: "ta-IN", label: "Tamil" },
  { value: "te-IN", label: "Telugu" },
  { value: "th-TH", label: "Thai" },
  { value: "tr-TR", label: "Turkish" },
  { value: "uk-UA", label: "Ukrainian" },
  { value: "vi-VN", label: "Vietnamese" },
  { value: "zh-CN", label: "Chinese (Simplified)" },
  { value: "zh-TW", label: "Chinese (Traditional)" },
];

const state = {
  dictation: {
    connected: false,
    supported: false,
    isDocsPage: false,
    status: "idle",
    message: "Open a Google Docs document to begin.",
    transcript: "",
    interimTranscript: "",
    docTitle: "",
    language: "Auto",
    insertedChars: 0,
    sessionSeconds: 0,
    cursorReady: false,
  },
  auth: {
    signedIn: false,
    email: "",
    method: null,
  },
  subscription: {
    active: false,
    status: "none",
    plan: null,
    sessionsLeft: FREE_TRIAL_SESSIONS,
    freeTrialSessions: FREE_TRIAL_SESSIONS,
  },
};

const PLAN_META = {
  monthly: {
    buttonText: "Subscribe monthly",
    label: "Monthly plan",
  },
  annual: {
    buttonText: "Subscribe yearly",
    label: "Annual plan",
  },
};

const STATUS_LABELS = {
  idle: "Ready",
  starting: "Starting",
  listening: "Listening",
  unsupported: "Unsupported",
  error: "Needs attention",
};

let docsAutoOpenLastAttemptAt = 0;
let activeScreen = "reader";
let isAuthenticating = false;
let authSuccessToastTimer = null;
let authPollingTimer = null;
let authReturnScreen = "paywall";
let stopRequestInFlight = false;
let stopStatePollTimer = null;
let extensionOpenedTracked = false;
const DOCS_AUTO_OPEN_COOLDOWN_MS = 5000;

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "Request failed."));
        return;
      }
      resolve(response);
    });
  });
}

function trackAnalyticsEvent(name, params = {}) {
  return sendRuntimeMessage({
    type: "trackAnalyticsEvent",
    name,
    params,
    sessionId: ANALYTICS_SESSION_ID,
  }).catch(() => null);
}

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

async function getReturnUrlForAuth() {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const url = tabs?.[0]?.url || "";
    if (typeof url === "string" && url.startsWith("https://")) {
      return url;
    }
  } catch (_error) {
    // Fall through.
  }
  return chrome.runtime.getURL("paywall.html");
}

function getPlanLabel(plan) {
  const planId = plan?.planId || "";
  if (planId === "annual") return "Annual plan";
  if (planId === "monthly") return "Monthly plan";
  return "Premium plan";
}

function formatSessions(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "0 sessions";
  }
  const rounded = Math.max(0, Math.floor(numeric));
  return `${rounded} ${rounded === 1 ? "session" : "sessions"}`;
}

function populateRecognitionLanguageOptions() {
  if (!languageSelectEl) {
    return;
  }
  languageSelectEl.textContent = "";
  RECOGNITION_LANGUAGE_OPTIONS.forEach((option) => {
    const nextOption = document.createElement("option");
    nextOption.value = option.value;
    nextOption.textContent = option.label;
    languageSelectEl.appendChild(nextOption);
  });
}

function isTrialEndedState() {
  const sessionsLeft = Number.isFinite(Number(state.subscription.sessionsLeft))
    ? Math.max(0, Math.floor(Number(state.subscription.sessionsLeft)))
    : 0;
  const trialMessage = String(state.dictation.message || "").toLowerCase();
  return (
    !state.subscription.active &&
    (sessionsLeft <= 0 ||
      trialMessage.includes("free trial ended") ||
      trialMessage.includes("upgrade to continue dictation"))
  );
}

function setActiveScreen(screen) {
  activeScreen = screen === "paywall" ? "paywall" : "reader";
  const showingPaywall = activeScreen === "paywall";
  readerScreenEl.classList.toggle("hidden", showingPaywall);
  paywallScreenEl.classList.toggle("hidden", !showingPaywall);
  backToReaderBtn.classList.toggle("hidden", !showingPaywall);
  upgradeBtn.classList.toggle("hidden", showingPaywall);
}

function openDrawer() {
  document.body.classList.add("drawer-open");
  drawerBackdropEl.classList.remove("hidden");
}

function closeDrawer() {
  document.body.classList.remove("drawer-open");
  drawerBackdropEl.classList.add("hidden");
}

function setAuthenticating(nextValue) {
  isAuthenticating = Boolean(nextValue);
  authOverlayEl.classList.toggle("hidden", !isAuthenticating);
  if (authPollingTimer) {
    clearInterval(authPollingTimer);
    authPollingTimer = null;
  }
  if (isAuthenticating) {
    authPollingTimer = setInterval(() => {
      void loadAuthState();
      void loadSubscriptionStatus();
    }, 1500);
  }
}

function showAuthSuccessToast() {
  if (authSuccessToastTimer) {
    clearTimeout(authSuccessToastTimer);
  }
  authToastEl.textContent = "Successfully signed in with Google.";
  authToastEl.classList.remove("hidden");
  authSuccessToastTimer = setTimeout(() => {
    authToastEl.classList.add("hidden");
    authSuccessToastTimer = null;
  }, 3200);
}

function trackExtensionOpened() {
  if (extensionOpenedTracked) {
    return;
  }
  extensionOpenedTracked = true;
  void trackAnalyticsEvent("extension_opened", {
    signed_in: state.auth.signedIn,
    is_docs_page: state.dictation.isDocsPage,
    trial_sessions_left: Number(state.subscription.sessionsLeft || 0),
  });
}

function getPlanPresentation() {
  if (state.subscription.active) {
    return {
      name: getPlanLabel(state.subscription.plan),
      meta: "Premium dictation is active on this account.",
    };
  }

  return {
    name: "Free Trial",
    meta:
      Number(state.subscription.sessionsLeft) > 0
        ? `${formatSessions(state.subscription.sessionsLeft)} remaining in your free trial.`
        : "Upgrade to unlock premium dictation.",
  };
}

function setPaywallStatus(text, ok = false) {
  paywallStatusEl.textContent = text;
  paywallStatusEl.style.color = ok ? "#4d8b46" : "#72798b";
}

function updatePaywallButtons() {
  const activePlanId = state.subscription.plan?.planId || "";
  const monthlyCurrent = state.subscription.active && activePlanId === "monthly";
  const annualCurrent = state.subscription.active && activePlanId === "annual";

  continueCheckoutMonthlyBtn.textContent = monthlyCurrent
    ? "Current monthly plan"
    : state.auth.signedIn
    ? "Subscribe monthly"
    : "Sign in to subscribe";
  continueCheckoutAnnualBtn.textContent = annualCurrent
    ? "Current yearly plan"
    : state.auth.signedIn
    ? "Subscribe yearly"
    : "Sign in to subscribe";
  continueCheckoutMonthlyBtn.disabled = monthlyCurrent;
  continueCheckoutAnnualBtn.disabled = annualCurrent;
}

function updateAuthUI() {
  drawerEmailEl.textContent = state.auth.signedIn ? state.auth.email : "Guest mode";
  const planPresentation = getPlanPresentation();
  drawerPlanNameEl.textContent = planPresentation.name;
  drawerPlanMetaEl.textContent = planPresentation.meta;
  accountActionBtn.textContent = state.auth.signedIn ? "Sign out" : "Sign in with Google";
  drawerUpgradeBtn.classList.toggle("hidden", state.subscription.active);

  authPanelEl?.classList.toggle("hidden", state.auth.signedIn);
  authCopyEl?.classList.toggle("hidden", state.auth.signedIn);
  authGoogleBtn?.classList.toggle("hidden", state.auth.signedIn);
  authSignedInEl?.classList.toggle("hidden", !state.auth.signedIn);
  authSignedInTextEl.textContent = state.auth.signedIn ? `Signed in as ${state.auth.email}` : "";
  authMessageEl.textContent = state.auth.signedIn
    ? ""
    : "Sign in to continue to checkout.";

  if (isAuthenticating && state.auth.signedIn) {
    setAuthenticating(false);
    showAuthSuccessToast();
    setActiveScreen(authReturnScreen);
  }
}

function updateQuotaUI() {
  if (state.subscription.active) {
    quotaEl.textContent = `${getPlanLabel(state.subscription.plan)} · Premium active`;
    return;
  }

  quotaEl.textContent = isTrialEndedState()
    ? "0 sessions left in trial"
    : `${formatSessions(state.subscription.sessionsLeft)} left in trial`;
}

function updateDictationUI() {
  const dictation = state.dictation;
  const trialEnded = isTrialEndedState();
  document.body.dataset.status = dictation.status;
  statusEl.textContent = trialEnded
    ? "Trial ended"
    : STATUS_LABELS[dictation.status] || "Ready";
  hintEl.textContent = trialEnded
    ? "Your free trial has ended. Choose your plan to keep dictating."
    : dictation.message || " ";
  docTitleEl.textContent = dictation.docTitle || "No active Google Docs tab";

  const isRunning = dictation.status === "listening" || dictation.status === "starting";
  startBtn.disabled = trialEnded || !dictation.isDocsPage || !dictation.supported || isRunning;
  stopBtn.disabled = !isRunning || stopRequestInFlight;
  stopBtn.textContent = stopRequestInFlight ? "Stopping..." : "Stop dictation";
  stopBtn.setAttribute("aria-busy", stopRequestInFlight ? "true" : "false");
  stopBtn.classList.toggle("is-processing", stopRequestInFlight);
  startBtn.classList.toggle("hidden", isRunning);
  stopBtn.classList.toggle("hidden", !isRunning);
  recordingTipsEl?.classList.toggle("hidden", !isRunning);

  trialEndedNoticeEl.classList.toggle("hidden", !trialEnded);

  if (trialEnded) {
    startBtn.disabled = true;
  } else if (!dictation.isDocsPage) {
    startBtn.disabled = true;
    hintEl.textContent = "Open a Google Docs document first.";
  } else if (dictation.status === "idle" && !dictation.cursorReady) {
    hintEl.textContent = "Click inside Google Docs first, then start dictation.";
  }
}

function updateUI() {
  updateAuthUI();
  updateQuotaUI();
  updateDictationUI();
  updatePaywallButtons();
}

async function loadAuthState() {
  try {
    const result = await sendRuntimeMessage({ type: "getAuthState" });
    state.auth = {
      signedIn: !!result.signedIn,
      email: result.email || "",
      method: result.method || null,
    };
  } catch (_error) {
    state.auth = { signedIn: false, email: "", method: null };
  }
  updateUI();
}

async function loadSubscriptionStatus() {
  try {
    const result = await sendRuntimeMessage({ type: "refreshSubscriptionStatus" });
    state.subscription = {
      active: !!result.active,
      status: result.status || "none",
      plan: result.plan || null,
      sessionsLeft: Number.isFinite(Number(result.sessionsLeft))
        ? Number(result.sessionsLeft)
        : state.subscription.sessionsLeft,
      freeTrialSessions: Number.isFinite(Number(result.freeTrialSessions))
        ? Number(result.freeTrialSessions)
        : FREE_TRIAL_SESSIONS,
    };
  } catch (_error) {
    state.subscription = {
      active: false,
      status: "none",
      plan: null,
      sessionsLeft: state.subscription.sessionsLeft,
      freeTrialSessions: state.subscription.freeTrialSessions,
    };
  }

  if (activeScreen === "paywall") {
    if (state.subscription.active) {
      setPaywallStatus("Subscription active on this account.", true);
    } else {
      setPaywallStatus(
        state.auth.signedIn
          ? "No active subscription detected."
          : "Choose a plan and continue with Google."
      );
    }
  }

  updateUI();
}

async function loadRecognitionLanguage() {
  try {
    const result = await sendRuntimeMessage({ type: "getRecognitionLanguage" });
    state.dictation.language = result.language || "Auto";
  } catch (_error) {
    state.dictation.language = "Auto";
  }
  if (languageSelectEl) {
    languageSelectEl.value = state.dictation.language || "Auto";
  }
}

async function setRecognitionLanguage(language) {
  const nextLanguage = typeof language === "string" && language.trim() ? language.trim() : "Auto";
  try {
    const result = await sendRuntimeMessage({ type: "setRecognitionLanguage", language: nextLanguage });
    state.dictation.language = result.language || nextLanguage;
    await refreshDictationState();
  } catch (_error) {
    state.dictation.language = nextLanguage;
  }
  if (languageSelectEl) {
    languageSelectEl.value = state.dictation.language || "Auto";
  }
  updateUI();
}

async function refreshDictationState() {
  try {
    const result = await sendRuntimeMessage({ type: "getDictationState" });
    state.dictation = {
      ...state.dictation,
      ...(result.state || {}),
    };
  } catch (error) {
    state.dictation = {
      ...state.dictation,
      connected: false,
      status: "idle",
      message: error.message || "Reload the Google Docs tab and try again.",
    };
  }
  updateUI();
}

async function startDictation() {
  try {
    void trackAnalyticsEvent("record_started", {
      signed_in: state.auth.signedIn,
      trial_sessions_left: Number(state.subscription.sessionsLeft || 0),
      doc_ready: state.dictation.cursorReady,
    });
    const result = await sendRuntimeMessage({ type: "startDictation" });
    if (result?.quota) {
      state.subscription = {
        ...state.subscription,
        active: !!result.quota.isSubscribed,
        status: result.quota.subscriptionStatus || state.subscription.status,
        plan: result.quota.plan || state.subscription.plan,
        sessionsLeft: Number.isFinite(Number(result.quota.sessionsLeft))
          ? Number(result.quota.sessionsLeft)
          : state.subscription.sessionsLeft,
      };
    }
    await refreshDictationState();
  } catch (error) {
    state.dictation.status = "error";
    state.dictation.message = error.message || "Unable to start dictation.";
    updateUI();
    if ((error.message || "").toLowerCase().includes("upgrade")) {
      openPaywall("record_start_blocked");
    }
  }
}

async function stopDictation() {
  if (stopRequestInFlight) {
    return;
  }
  void trackAnalyticsEvent("stop_and_transcribe_clicked", {
    signed_in: state.auth.signedIn,
    session_seconds: Number(state.dictation.sessionSeconds || 0),
  });
  stopRequestInFlight = true;
  state.dictation.status = "starting";
  state.dictation.message = "Stopping dictation...";
  updateUI();
  try {
    const result = await sendRuntimeMessage({ type: "stopDictation" });
    if (result.state) {
      state.dictation = {
        ...state.dictation,
        ...result.state,
      };
    }
  } finally {
    stopRequestInFlight = false;
    updateUI();
  }
  pollDictationAfterStop();
}

function pollDictationAfterStop() {
  if (stopStatePollTimer) {
    clearInterval(stopStatePollTimer);
    stopStatePollTimer = null;
  }
  let attempts = 0;
  const maxAttempts = 20;
  stopStatePollTimer = setInterval(() => {
    attempts += 1;
    void refreshDictationState().then(() => {
      const status = state.dictation.status;
      if (status !== "starting" && status !== "listening") {
        clearInterval(stopStatePollTimer);
        stopStatePollTimer = null;
        void loadSubscriptionStatus();
      }
    });
    if (attempts >= maxAttempts) {
      clearInterval(stopStatePollTimer);
      stopStatePollTimer = null;
      void loadSubscriptionStatus();
    }
  }, 500);
}

async function autoOpenGoogleDocsIfNeeded() {
  if (state.dictation.isDocsPage) {
    return;
  }
  if (Date.now() - docsAutoOpenLastAttemptAt < DOCS_AUTO_OPEN_COOLDOWN_MS) {
    return;
  }
  docsAutoOpenLastAttemptAt = Date.now();
  state.dictation.message = "Opening Google Docs...";
  updateUI();
  try {
    await sendRuntimeMessage({ type: "openGoogleDocs" });
  } catch (_error) {
    chrome.tabs.create({ url: "https://docs.google.com/document/create" });
  }
}

async function signInWithGoogle(source = "unknown") {
  void trackAnalyticsEvent("login_started", {
    source,
    signed_in: state.auth.signedIn,
    trial_sessions_left: Number(state.subscription.sessionsLeft || 0),
  });
  authGoogleBtn.disabled = true;
  authGoogleBtn.textContent = "Opening Google...";
  setAuthenticating(true);
  try {
    const returnUrl = await getReturnUrlForAuth();
    await sendRuntimeMessage({
      type: "startGoogleSignIn",
      returnUrl,
    });
    setPaywallStatus("Complete Google sign-in in the opened tab, then return here.");
  } catch (error) {
    setPaywallStatus(error.message || "Unable to start Google sign-in.");
    setAuthenticating(false);
  } finally {
    authGoogleBtn.disabled = false;
    authGoogleBtn.textContent = "Continue with Google";
  }
}

async function signOut() {
  try {
    await sendRuntimeMessage({ type: "signOut" });
    await Promise.all([loadAuthState(), loadSubscriptionStatus()]);
    setPaywallStatus("Signed out. Sign in again before checkout.");
  } catch (error) {
    setPaywallStatus(error.message || "Unable to sign out.");
  }
}

function openPaywall(source = "unknown") {
  authReturnScreen = "paywall";
  setActiveScreen("paywall");
  closeDrawer();
  void trackAnalyticsEvent("paywall_opened", {
    source,
    signed_in: state.auth.signedIn,
    trial_sessions_left: Number(state.subscription.sessionsLeft || 0),
    trial_exhausted: Number(state.subscription.sessionsLeft || 0) <= 0,
  });
  void Promise.all([loadAuthState(), loadSubscriptionStatus()]).then(() => {
    if (state.subscription.active) {
      setPaywallStatus("Subscription active on this account.", true);
    } else {
      setPaywallStatus(
        state.auth.signedIn
          ? "No active subscription detected."
          : "Choose a plan and continue with Google."
      );
    }
  });
}

async function openCheckout(planId, button) {
  await loadAuthState();
  if (!state.auth.signedIn) {
    authReturnScreen = "paywall";
    setPaywallStatus("Sign in with Google to continue.");
    await signInWithGoogle(`checkout_${planId}`);
    return;
  }

  const initialLabel = button.textContent;
  button.disabled = true;
  button.textContent = "Opening checkout...";
  setPaywallStatus("Creating Stripe Checkout session...");
  try {
    void trackAnalyticsEvent("checkout_started", {
      plan_id: planId,
      signed_in: state.auth.signedIn,
      trial_sessions_left: Number(state.subscription.sessionsLeft || 0),
    });
    const result = await sendRuntimeMessage({
      type: "createCheckoutSession",
      planId,
      returnUrl: chrome.runtime.getURL("paywall.html"),
    });
    if (!result.url) {
      throw new Error("Checkout URL is missing.");
    }
    chrome.tabs.create({ url: result.url });
    setPaywallStatus("Stripe Checkout opened in a new tab.", true);
  } catch (error) {
    setPaywallStatus(error.message || "Unable to open checkout.");
  } finally {
    button.disabled = false;
    button.textContent = initialLabel;
    updatePaywallButtons();
  }
}

function openExternalPage(pathname) {
  const base = "https://voicetext.world";
  chrome.tabs.create({ url: `${base}${pathname}` });
}

async function showWelcomeOnFirstLaunch() {
  const { welcomeShown } = await readStorage({ welcomeShown: false });
  if (welcomeShown) return;
  chrome.tabs.create({ url: "https://voicetext.world/welcome.html" });
  await writeStorage({ welcomeShown: true });
}

let popupInitialized = false;

function initializePopup() {
  if (popupInitialized) {
    return;
  }
  popupInitialized = true;
  populateRecognitionLanguageOptions();

  startBtn.addEventListener("click", () => {
    void startDictation();
  });
  stopBtn.addEventListener("click", () => {
    void stopDictation();
  });
  languageSelectEl?.addEventListener("change", (event) => {
    const nextLanguage = event.target?.value || "Auto";
    void setRecognitionLanguage(nextLanguage);
  });
  upgradeBtn.addEventListener("click", () => {
    void trackAnalyticsEvent("upgrade_clicked", { source: "header_button" });
    openPaywall("header_button");
  });
  trialUpgradeBtn?.addEventListener("click", () => {
    void trackAnalyticsEvent("upgrade_clicked", { source: "trial_notice" });
    openPaywall("trial_notice");
  });
  drawerUpgradeBtn.addEventListener("click", () => {
    void trackAnalyticsEvent("upgrade_clicked", { source: "drawer_button" });
    openPaywall("drawer_button");
  });
  contactBtn.addEventListener("click", () => {
    openExternalPage("/support");
  });
  accountActionBtn.addEventListener("click", () => {
    if (state.auth.signedIn) {
      void signOut();
      return;
    }
    authReturnScreen = "reader";
    void signInWithGoogle("account_button");
  });
  authGoogleBtn.addEventListener("click", () => {
    authReturnScreen = "paywall";
    void signInWithGoogle("paywall_google_button");
  });
  authSignOutBtn.addEventListener("click", () => {
    void signOut();
  });
  continueCheckoutMonthlyBtn.addEventListener("click", () => {
    void openCheckout("monthly", continueCheckoutMonthlyBtn);
  });
  continueCheckoutAnnualBtn.addEventListener("click", () => {
    void openCheckout("annual", continueCheckoutAnnualBtn);
  });
  profileTriggerBtn.addEventListener("click", () => {
    openDrawer();
  });
  closeDrawerBtn.addEventListener("click", () => {
    closeDrawer();
  });
  drawerBackdropEl.addEventListener("click", () => {
    closeDrawer();
  });
  backToReaderBtn.addEventListener("click", () => {
    setActiveScreen("reader");
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (!drawerBackdropEl.classList.contains("hidden")) {
        closeDrawer();
        return;
      }
      if (activeScreen === "paywall") {
        setActiveScreen("reader");
      }
    }
  });

  window.addEventListener("focus", () => {
    void refreshDictationState().then(() => {
      void autoOpenGoogleDocsIfNeeded();
    });
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") {
      return;
    }
    void refreshDictationState().then(() => {
      void autoOpenGoogleDocsIfNeeded();
    });
  });

  void showWelcomeOnFirstLaunch();
  updateUI();
  void Promise.all([loadAuthState(), loadSubscriptionStatus(), loadRecognitionLanguage(), refreshDictationState()]).then(() => {
    void autoOpenGoogleDocsIfNeeded();
    trackExtensionOpened();
  });
  setInterval(() => {
    void refreshDictationState();
  }, 1500);
  setInterval(() => {
    void loadSubscriptionStatus();
  }, 15000);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializePopup, { once: true });
} else {
  initializePopup();
}
