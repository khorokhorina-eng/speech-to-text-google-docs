const statusEl = document.getElementById("status");
const hintEl = document.getElementById("hint");
const docTitleEl = document.getElementById("docTitle");
const quotaEl = document.getElementById("quota");
const startBtn = document.getElementById("start");
const stopBtn = document.getElementById("stop");
const openDocsBtn = document.getElementById("openDocs");
const upgradeBtn = document.getElementById("upgrade");
const pricingLinkBtn = document.getElementById("pricingLink");
const contactBtn = document.getElementById("contact");
const accountStateEl = document.getElementById("accountState");
const accountActionBtn = document.getElementById("accountAction");

const paywallModal = document.getElementById("paywallModal");
const closePaywallBtn = document.getElementById("closePaywall");
const paywallStatusEl = document.getElementById("paywallStatus");
const continueCheckoutBtn = document.getElementById("continueCheckout");
const planCardEls = Array.from(document.querySelectorAll(".plan-card"));
const authCopyEl = document.getElementById("authCopy");
const authMessageEl = document.getElementById("authMessage");
const authSignedInEl = document.getElementById("authSignedIn");
const authGoogleBtn = document.getElementById("authGoogle");
const authSignedInTextEl = document.getElementById("authSignedInText");
const authSignOutBtn = document.getElementById("authSignOut");

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
  },
  auth: {
    signedIn: false,
    email: "",
    method: null,
  },
  subscription: {
    active: false,
    plan: null,
    minutesLeft: 5,
  },
  selectedPlanId: "annual",
};

const PLAN_META = {
  monthly: {
    buttonText: "Continue with monthly plan",
  },
  annual: {
    buttonText: "Continue with annual plan",
  },
};

const STATUS_LABELS = {
  idle: "Ready",
  starting: "Starting",
  listening: "Listening",
  unsupported: "Unsupported",
  error: "Needs attention",
};

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

function setPaywallStatus(text, ok = false) {
  paywallStatusEl.textContent = text;
  paywallStatusEl.style.color = ok ? "#1f7a4e" : "#6a6257";
}

function updatePlanSelection() {
  planCardEls.forEach((card) => {
    const planId = card.dataset.planId || "";
    card.classList.toggle("selected", planId === state.selectedPlanId);
  });

  const activePlanId = state.subscription.plan?.planId || "";
  const isCurrentPlan = state.subscription.active && activePlanId === state.selectedPlanId;
  continueCheckoutBtn.textContent = isCurrentPlan
    ? "Current plan active"
    : state.auth.signedIn
    ? PLAN_META[state.selectedPlanId]?.buttonText || "Continue"
    : "Sign in to continue";
  continueCheckoutBtn.disabled = isCurrentPlan;
}

function updateAuthUI() {
  accountStateEl.textContent = state.auth.signedIn
    ? `Signed in as ${state.auth.email}`
    : "Not signed in";
  accountActionBtn.textContent = state.auth.signedIn ? "Plans" : "Sign in";

  authCopyEl.classList.toggle("hidden", state.auth.signedIn);
  authGoogleBtn.classList.toggle("hidden", state.auth.signedIn);
  authSignedInEl.classList.toggle("hidden", !state.auth.signedIn);
  authSignedInTextEl.textContent = state.auth.signedIn ? `Signed in as ${state.auth.email}` : "";
  authMessageEl.textContent = state.auth.signedIn
    ? ""
    : "Use your free trial first. Sign in with Google when you want to buy a plan.";
}

function updateQuotaUI() {
  const minutesLeft = Number.isFinite(Number(state.subscription.minutesLeft))
    ? Math.max(0, Number(state.subscription.minutesLeft))
    : 0;
  if (state.subscription.active) {
    quotaEl.textContent = `${minutesLeft} minutes left`;
    return;
  }
  quotaEl.textContent = `${minutesLeft} free minutes left`;
}

function updateDictationUI() {
  const dictation = state.dictation;
  document.body.dataset.status = dictation.status;
  statusEl.textContent = STATUS_LABELS[dictation.status] || "Ready";
  hintEl.textContent = dictation.message || " ";
  docTitleEl.textContent = dictation.docTitle || "No active Google Docs tab";

  const isRunning = dictation.status === "listening" || dictation.status === "starting";
  startBtn.disabled = !dictation.isDocsPage || !dictation.supported || isRunning;
  stopBtn.disabled = !isRunning;
  openDocsBtn.hidden = dictation.isDocsPage;

  if (!dictation.isDocsPage) {
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
  updatePlanSelection();
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
      minutesLeft: Number.isFinite(Number(result.minutesLeft)) ? Number(result.minutesLeft) : 5,
    };
  } catch (_error) {
    state.subscription = {
      active: false,
      plan: null,
      minutesLeft: state.subscription.minutesLeft,
    };
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
    await sendRuntimeMessage({
      type: "startDictation",
    });
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
  } catch (_error) {
    // The content script may have already stopped the session.
  }
  await Promise.all([refreshDictationState(), loadSubscriptionStatus()]);
}

async function openGoogleDocs() {
  try {
    await sendRuntimeMessage({ type: "openGoogleDocs" });
  } catch (_error) {
    chrome.tabs.create({ url: "https://docs.google.com/document/u/0/" });
  }
}

async function signInWithGoogle() {
  authGoogleBtn.disabled = true;
  authGoogleBtn.textContent = "Opening Google...";
  try {
    await sendRuntimeMessage({
      type: "startGoogleSignIn",
      returnUrl: chrome.runtime.getURL("paywall.html"),
    });
    setPaywallStatus("Complete Google sign-in in the opened tab, then return here.");
  } catch (error) {
    setPaywallStatus(error.message || "Unable to start Google sign-in.");
  } finally {
    authGoogleBtn.disabled = false;
    authGoogleBtn.textContent = "Continue with Google";
  }
}

async function signOut() {
  try {
    await sendRuntimeMessage({ type: "signOut" });
    await loadAuthState();
    setPaywallStatus("Signed out. Sign in again before checkout.");
  } catch (error) {
    setPaywallStatus(error.message || "Unable to sign out.");
  }
}

function openPaywall() {
  paywallModal.classList.remove("hidden");
  void Promise.all([loadAuthState(), loadSubscriptionStatus()]).then(() => {
    if (state.subscription.active) {
      const currentPlanId = state.subscription.plan?.planId || "";
      if (currentPlanId) {
        state.selectedPlanId = currentPlanId;
      }
      setPaywallStatus("Subscription active on this account.", true);
    } else {
      setPaywallStatus(
        state.auth.signedIn
          ? "No active subscription detected."
          : "Sign in before checkout to keep your paid plan attached to your account."
      );
    }
    updateUI();
  });
}

function closePaywall() {
  paywallModal.classList.add("hidden");
}

async function openCheckoutForSelectedPlan() {
  await loadAuthState();
  if (!state.auth.signedIn) {
    setPaywallStatus("Sign in before continuing to Stripe.");
    return;
  }

  continueCheckoutBtn.disabled = true;
  setPaywallStatus("Creating Stripe Checkout session...");
  try {
    const result = await sendRuntimeMessage({
      type: "createCheckoutSession",
      planId: state.selectedPlanId,
      returnUrl: chrome.runtime.getURL("paywall.html"),
    });
    if (!result.url) {
      throw new Error("Checkout URL is missing.");
    }
    chrome.tabs.create({ url: result.url });
    setPaywallStatus("Stripe Checkout opened in a new tab.");
  } catch (error) {
    setPaywallStatus(error.message || "Unable to open checkout.");
  } finally {
    continueCheckoutBtn.disabled = false;
    updatePlanSelection();
  }
}

function openExternalPage(pathname) {
  const base = "https://voicetext.world";
  chrome.tabs.create({ url: `${base}${pathname}` });
}

startBtn.addEventListener("click", () => {
  startDictation();
});

stopBtn.addEventListener("click", () => {
  stopDictation();
});

openDocsBtn.addEventListener("click", () => {
  openGoogleDocs();
});

upgradeBtn.addEventListener("click", () => {
  openPaywall();
});

pricingLinkBtn.addEventListener("click", () => {
  openExternalPage("/pricing");
});

contactBtn.addEventListener("click", () => {
  openExternalPage("/support");
});

accountActionBtn.addEventListener("click", () => {
  if (state.auth.signedIn) {
    openPaywall();
    return;
  }
  signInWithGoogle();
});

closePaywallBtn.addEventListener("click", () => {
  closePaywall();
});

continueCheckoutBtn.addEventListener("click", () => {
  openCheckoutForSelectedPlan();
});

planCardEls.forEach((card) => {
  card.addEventListener("click", () => {
    state.selectedPlanId = card.dataset.planId || "annual";
    updatePlanSelection();
  });
});

authGoogleBtn.addEventListener("click", () => {
  signInWithGoogle();
});

authSignOutBtn.addEventListener("click", () => {
  signOut();
});

updateUI();
void Promise.all([loadAuthState(), loadSubscriptionStatus(), refreshDictationState()]);
setInterval(() => {
  refreshDictationState();
}, 1500);
setInterval(() => {
  loadSubscriptionStatus();
}, 15000);
