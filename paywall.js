const statusEl = document.getElementById("status");
const refreshBtn = document.getElementById("refresh");
const closeBtn = document.getElementById("close");
const planButtons = Array.from(document.querySelectorAll("button[data-plan-id]"));
const authMessageEl = document.getElementById("authMessage");
const authCopyEl = document.getElementById("authCopy");
const authSignedInEl = document.getElementById("authSignedIn");
const authGoogleBtn = document.getElementById("authGoogle");
const authSignedInTextEl = document.getElementById("authSignedInText");
const authSignOutBtn = document.getElementById("authSignOut");
const monthlyPriceEl = document.getElementById("monthlyPrice");
const monthlyPeriodEl = document.getElementById("monthlyPeriod");
const monthlyDescEl = document.getElementById("monthlyDesc");
const annualPriceEl = document.getElementById("annualPrice");
const annualPeriodEl = document.getElementById("annualPeriod");
const annualDescEl = document.getElementById("annualDesc");
const managePanelEl = document.getElementById("managePanel");
const manageMessageEl = document.getElementById("manageMessage");
const changePlanBtn = document.getElementById("changePlan");
const cancelSubscriptionBtn = document.getElementById("cancelSubscription");
const monthlyPlanCardEl = document.getElementById("monthlyPlanCard");
const annualPlanCardEl = document.getElementById("annualPlanCard");

let currentSubscription = { active: false, plan: null };
let authState = { signedIn: false, email: "", method: null };
let pricingPlans = [];

function getSafeReturnUrl() {
  return "https://docs.google.com/document/create";
}

function getPlanLabel(plan) {
  const planId = plan?.planId || "";
  if (planId === "annual") {
    return "Annual plan";
  }
  if (planId === "monthly") {
    return "Monthly plan";
  }
  return "Paid plan";
}

function formatPlanDateLabel(value) {
  if (!value) {
    return "";
  }
  const raw = Number(value);
  const date =
    Number.isFinite(raw) && raw > 0
      ? new Date(raw * 1000)
      : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function setStatus(text, ok = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("ok", ok);
}

function sendMessage(message) {
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

function updateButtons() {
  const activePlanId = currentSubscription?.plan?.planId || "";

  planButtons.forEach((button) => {
    const planId = button.dataset.planId || "";
    const isCurrentPlan = currentSubscription?.active && activePlanId === planId;
    button.disabled = currentSubscription?.active || isCurrentPlan;
    button.textContent = currentSubscription?.active
      ? planId === "monthly"
        ? "Current monthly plan"
        : "Current yearly plan"
      : authState.signedIn
      ? "Upgrade"
      : "Sign in first";
  });
}

function getPricingPlan(planId) {
  return pricingPlans.find((plan) => plan.planId === planId) || null;
}

function applyPricingPlan(planId, priceEl, periodEl, descEl) {
  const plan = getPricingPlan(planId);
  if (!plan) {
    return;
  }
  if (priceEl && plan.displayPrice) {
    priceEl.textContent = plan.displayPrice;
  }
  if (periodEl && plan.periodLabel) {
    periodEl.textContent = plan.periodLabel;
  }
  if (descEl && plan.description) {
    descEl.textContent = plan.description;
  }
}

function updatePricingUI() {
  applyPricingPlan("monthly", monthlyPriceEl, monthlyPeriodEl, monthlyDescEl);
  applyPricingPlan("annual", annualPriceEl, annualPeriodEl, annualDescEl);
}

async function loadPricingPlans(forceRefresh = false) {
  try {
    const result = await sendMessage({ type: "getPricingPlans", forceRefresh });
    pricingPlans = Array.isArray(result?.plans) ? result.plans : [];
    updatePricingUI();
  } catch (_error) {
    pricingPlans = [];
  }
}

async function loadAuthState() {
  const result = await sendMessage({ type: "getAuthState" });
  authState = {
    signedIn: !!result.signedIn,
    email: result.email || "",
    method: result.method || null,
  };
  authCopyEl.hidden = authState.signedIn;
  authGoogleBtn.hidden = authState.signedIn;
  authSignedInEl.hidden = !authState.signedIn;
  authSignedInTextEl.textContent = authState.signedIn ? `Signed in as ${authState.email}` : "";
  authMessageEl.textContent = authState.signedIn
    ? ""
    : "Sign in with Google to choose a plan.";
  updateButtons();
}

async function signInWithGoogle() {
  authGoogleBtn.disabled = true;
  authGoogleBtn.textContent = "Opening Google...";
  try {
    await sendMessage({
      type: "startGoogleSignIn",
      returnUrl: getSafeReturnUrl(),
    });
    setStatus("Complete Google sign-in in the opened tab, then refresh this page.");
  } catch (error) {
    setStatus(error.message || "Unable to start Google sign-in.");
  } finally {
    authGoogleBtn.disabled = false;
    authGoogleBtn.textContent = "Continue with Google";
  }
}

async function signOut() {
  try {
    await sendMessage({ type: "signOut" });
    await loadAuthState();
    setStatus("Signed out. Sign in again before checkout.");
  } catch (error) {
    setStatus(error.message || "Unable to sign out.");
  }
}

async function openCheckout(planId, button) {
  if (!planId) {
    return;
  }
  await loadAuthState();
  if (!authState.signedIn) {
    setStatus("Sign in with Google to continue.");
    await signInWithGoogle();
    return;
  }

  if (currentSubscription?.active) {
    await openBillingPortal();
    return;
  }

  const initialLabel = button.textContent;
  button.disabled = true;
  button.textContent = "Creating checkout...";
  setStatus("Creating Stripe Checkout session...");

  try {
    const result = await sendMessage({
      type: "createCheckoutSession",
      planId,
      returnUrl: getSafeReturnUrl(),
    });

    if (!result.url) {
      throw new Error("Checkout URL is missing.");
    }

    setStatus("Redirecting to Stripe Checkout...");
    window.location.assign(result.url);
  } catch (error) {
    setStatus(error.message || "Unable to open checkout.");
  } finally {
    if (button.textContent === "Creating checkout...") {
      button.textContent = initialLabel;
    }
    updateButtons();
  }
}

async function openBillingPortal() {
  if (!authState.signedIn) {
    setStatus("Sign in before managing your subscription.");
    return;
  }
  if (!currentSubscription?.active) {
    setStatus("No active subscription found on this account.");
    return;
  }

  changePlanBtn.disabled = true;
  cancelSubscriptionBtn.disabled = true;
  try {
    const result = await sendMessage({
      type: "createBillingPortalSession",
      returnUrl: "https://docs.google.com/document/",
    });
    if (!result.url) {
      throw new Error("Billing portal URL is missing.");
    }
    setStatus("Opening Stripe billing portal...");
    window.location.assign(result.url);
  } catch (error) {
    setStatus(error.message || "Unable to open billing portal.");
  } finally {
    changePlanBtn.disabled = false;
    cancelSubscriptionBtn.disabled = false;
  }
}

async function loadSubscriptionStatus() {
  setStatus("Checking subscription status...");

  try {
    await loadAuthState();
    const result = await sendMessage({ type: "refreshSubscriptionStatus" });
    currentSubscription = result || { active: false, plan: null };
    updateButtons();
    managePanelEl.hidden = !currentSubscription.active;
    monthlyPlanCardEl.hidden = currentSubscription.active;
    annualPlanCardEl.hidden = currentSubscription.active;

    if (currentSubscription.active) {
      const endLabel = formatPlanDateLabel(currentSubscription.plan?.currentPeriodEnd);
      manageMessageEl.textContent =
        currentSubscription.plan?.cancelAtPeriodEnd && endLabel
          ? `Your ${getPlanLabel(currentSubscription.plan).toLowerCase()} ends on ${endLabel}.`
          : endLabel
          ? `Your ${getPlanLabel(currentSubscription.plan).toLowerCase()} renews on ${endLabel}.`
          : "Your paid plan is active on this account.";
    }

    if (currentSubscription.active) {
      setStatus(`Subscription active. Current plan: ${getPlanLabel(currentSubscription.plan)}.`, true);
      return;
    }

    setStatus(
      authState.signedIn
        ? "No active subscription detected."
        : "Sign in before checkout to keep your paid plan attached to your account."
    );
  } catch (error) {
    currentSubscription = { active: false, plan: null };
    updateButtons();
    setStatus(error.message || "Failed to refresh subscription status.");
  }
}

planButtons.forEach((button) => {
  button.addEventListener("click", () => {
    openCheckout(button.dataset.planId || "", button);
  });
});

refreshBtn.addEventListener("click", () => {
  loadSubscriptionStatus();
});

authGoogleBtn.addEventListener("click", () => {
  signInWithGoogle();
});

authSignOutBtn.addEventListener("click", () => {
  signOut();
});

changePlanBtn.addEventListener("click", () => {
  openBillingPortal();
});

cancelSubscriptionBtn.addEventListener("click", () => {
  openBillingPortal();
});

closeBtn.addEventListener("click", () => {
  window.close();
});

updateButtons();
void loadPricingPlans();
loadSubscriptionStatus();
