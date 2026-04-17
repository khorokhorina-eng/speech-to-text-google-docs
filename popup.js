const statusEl = document.getElementById("status");
const hintEl = document.getElementById("hint");
const docTitleEl = document.getElementById("docTitle");
const quotaEl = document.getElementById("quota");
const countdownEl = document.getElementById("countdown");
const countdownFillEl = document.getElementById("countdownFill");
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
    plan: null,
    minutesLeft: 10,
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

const MAX_RECORDING_SECONDS = 120;
let docsAutoOpenAttempted = false;
let activeScreen = "reader";
let isAuthenticating = false;
let authSuccessToastTimer = null;
let authPollingTimer = null;
let authReturnScreen = "paywall";

function getPlanLabel(plan) {
  const planId = plan?.planId || "";
  if (planId === "annual") return "Annual plan";
  if (planId === "monthly") return "Monthly plan";
  return "Paid plan";
}

function formatMinutesForDisplay(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.max(0, Math.ceil(numeric));
}

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

function getPlanPresentation() {
  if (state.subscription.active) {
    const activePlanId = state.subscription?.plan?.planId || "";
    const activePlanMeta = PLAN_META[activePlanId] || {};
    return {
      name: activePlanMeta.label || "Paid plan",
      meta: `${formatMinutesForDisplay(state.subscription.minutesLeft)} minutes left in your plan.`,
    };
  }

  return {
    name: "Free Trial",
    meta:
      formatMinutesForDisplay(state.subscription.minutesLeft) > 0
        ? `${formatMinutesForDisplay(state.subscription.minutesLeft)} free minutes remaining.`
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
    : "Use your free trial first. Sign in with Google when you want to buy a plan.";

  if (isAuthenticating && state.auth.signedIn) {
    setAuthenticating(false);
    showAuthSuccessToast();
    setActiveScreen(authReturnScreen);
  }
}

function updateQuotaUI() {
  const minutesLeft = formatMinutesForDisplay(state.subscription.minutesLeft);
  if (state.subscription.active) {
    quotaEl.textContent = `${getPlanLabel(state.subscription.plan)} · ${minutesLeft} minutes left`;
    return;
  }
  quotaEl.textContent = `${minutesLeft} free minutes left`;
}

function updateDictationUI() {
  const dictation = state.dictation;
  const minutesLeft = Number.isFinite(Number(state.subscription.minutesLeft))
    ? Math.max(0, Number(state.subscription.minutesLeft))
    : 0;
  const trialEnded = !state.subscription.active && minutesLeft <= 0;
  document.body.dataset.status = dictation.status;
  statusEl.textContent = STATUS_LABELS[dictation.status] || "Ready";
  hintEl.textContent = trialEnded
    ? "Your free trial has ended. Choose your plan to keep dictating."
    : dictation.message || " ";
  docTitleEl.textContent = dictation.docTitle || "No active Google Docs tab";

  const isRunning = dictation.status === "listening" || dictation.status === "starting";
  startBtn.disabled = trialEnded || !dictation.isDocsPage || !dictation.supported || isRunning;
  stopBtn.disabled = !isRunning;
  startBtn.classList.toggle("hidden", isRunning);
  stopBtn.classList.toggle("hidden", !isRunning);

  if (isRunning) {
    const elapsedSeconds = Math.max(0, Number(dictation.sessionSeconds) || 0);
    const progressRatio = MAX_RECORDING_SECONDS > 0 ? elapsedSeconds / MAX_RECORDING_SECONDS : 0;
    countdownFillEl.style.width = `${Math.max(0, Math.min(1, progressRatio)) * 100}%`;
    countdownEl.classList.remove("hidden");
  } else {
    countdownFillEl.style.width = "0%";
    countdownEl.classList.add("hidden");
  }

  trialEndedNoticeEl.classList.toggle("hidden", !trialEnded);

  if (trialEnded) {
    startBtn.disabled = true;
  } else if (!dictation.isDocsPage) {
    startBtn.disabled = true;
    hintEl.textContent = "Open a Google Docs document first.";
  } else if (dictation.status === "idle" && !dictation.cursorReady) {
    hintEl.textContent = "Click inside the Google Docs editor, then record your voice.";
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
      plan: result.plan || null,
      minutesLeft: Number.isFinite(Number(result.minutesLeft)) ? Number(result.minutesLeft) : 10,
    };
  } catch (_error) {
    state.subscription = {
      active: false,
      plan: null,
      minutesLeft: state.subscription.minutesLeft,
    };
  }

  if (activeScreen === "paywall") {
    if (state.subscription.active) {
      setPaywallStatus(`Subscription active on this account.`, true);
    } else {
      setPaywallStatus(
        state.auth.signedIn
          ? "No active subscription detected."
          : "Sign in before checkout to keep your paid plan attached to your account."
      );
    }
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
    await sendRuntimeMessage({ type: "startDictation" });
    await refreshDictationState();
  } catch (error) {
    state.dictation.status = "error";
    state.dictation.message = error.message || "Unable to start dictation.";
    updateUI();
    if ((error.message || "").toLowerCase().includes("upgrade")) {
      openPaywall();
    }
  }
}

async function stopDictation() {
  try {
    await sendRuntimeMessage({ type: "stopDictation" });
  } catch (_error) {}
  await Promise.all([refreshDictationState(), loadSubscriptionStatus()]);
}

async function autoOpenGoogleDocsIfNeeded() {
  if (docsAutoOpenAttempted || state.dictation.isDocsPage) {
    return;
  }
  docsAutoOpenAttempted = true;
  state.dictation.message = "Opening Google Docs...";
  updateUI();
  try {
    await sendRuntimeMessage({ type: "openGoogleDocs" });
  } catch (_error) {
    chrome.tabs.create({ url: "https://docs.google.com/document/create" });
  }
}

async function signInWithGoogle() {
  authGoogleBtn.disabled = true;
  authGoogleBtn.textContent = "Opening Google...";
  setAuthenticating(true);
  try {
    await sendRuntimeMessage({
      type: "startGoogleSignIn",
      returnUrl: chrome.runtime.getURL("paywall.html"),
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

function openPaywall() {
  authReturnScreen = "paywall";
  setActiveScreen("paywall");
  closeDrawer();
  void Promise.all([loadAuthState(), loadSubscriptionStatus()]).then(() => {
    if (state.subscription.active) {
      setPaywallStatus("Subscription active on this account.", true);
    } else {
      setPaywallStatus(
        state.auth.signedIn
          ? "No active subscription detected."
          : "Sign in before checkout to keep your paid plan attached to your account."
      );
    }
  });
}

async function openCheckout(planId, button) {
  await loadAuthState();
  if (!state.auth.signedIn) {
    authReturnScreen = "paywall";
    setPaywallStatus("Sign in with Google to continue.");
    await signInWithGoogle();
    return;
  }

  const initialLabel = button.textContent;
  button.disabled = true;
  button.textContent = "Opening checkout...";
  setPaywallStatus("Creating Stripe Checkout session...");
  try {
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

startBtn.addEventListener("click", () => { void startDictation(); });
stopBtn.addEventListener("click", () => { void stopDictation(); });
upgradeBtn.addEventListener("click", () => { openPaywall(); });
trialUpgradeBtn?.addEventListener("click", () => { openPaywall(); });
drawerUpgradeBtn.addEventListener("click", () => { openPaywall(); });
contactBtn.addEventListener("click", () => { openExternalPage("/support"); });
accountActionBtn.addEventListener("click", () => {
  if (state.auth.signedIn) {
    void signOut();
    return;
  }
  authReturnScreen = "reader";
  void signInWithGoogle();
});
authGoogleBtn.addEventListener("click", () => { authReturnScreen = "paywall"; void signInWithGoogle(); });
authSignOutBtn.addEventListener("click", () => { void signOut(); });
continueCheckoutMonthlyBtn.addEventListener("click", () => { void openCheckout("monthly", continueCheckoutMonthlyBtn); });
continueCheckoutAnnualBtn.addEventListener("click", () => { void openCheckout("annual", continueCheckoutAnnualBtn); });
profileTriggerBtn.addEventListener("click", () => { openDrawer(); });
closeDrawerBtn.addEventListener("click", () => { closeDrawer(); });
drawerBackdropEl.addEventListener("click", () => { closeDrawer(); });
backToReaderBtn.addEventListener("click", () => { setActiveScreen("reader"); });

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

void showWelcomeOnFirstLaunch();
updateUI();
void Promise.all([loadAuthState(), loadSubscriptionStatus(), refreshDictationState()]).then(() => {
  void autoOpenGoogleDocsIfNeeded();
});
setInterval(() => { void refreshDictationState(); }, 1500);
setInterval(() => { void loadSubscriptionStatus(); }, 15000);
