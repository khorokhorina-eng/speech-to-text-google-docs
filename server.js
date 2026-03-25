const http = require("http");
const fs = require("fs");
const path = require("path");
const Stripe = require("stripe");

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      return;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  });
}

loadEnvFile();

const PORT = Number(process.env.PORT || 8787);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || "alloy";
const FREE_MINUTES = Math.max(1, Number(process.env.FREE_MINUTES || 5));
const CHAR_PER_MINUTE = Math.max(1, Number(process.env.CHAR_PER_MINUTE || 900));
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const STRIPE_MONTHLY_PRICE_ID =
  process.env.STRIPE_MONTHLY_PRICE_ID || process.env.STRIPE_PRICE_MONTHLY || "";
const STRIPE_ANNUAL_PRICE_ID =
  process.env.STRIPE_YEARLY_PRICE_ID || process.env.STRIPE_PRICE_ANNUAL || "";

const GOOGLE_OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || "";
const GOOGLE_OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || "";

const PLAN_DEFINITIONS = [
  {
    id: "monthly",
    name: "Monthly plan",
    description: "Unlimited playback and full access.",
    stripePriceId: STRIPE_MONTHLY_PRICE_ID,
    includedMinutes: Math.max(1, Number(process.env.MONTHLY_MINUTES || 300)),
  },
  {
    id: "annual",
    name: "Annual plan",
    description: "Unlimited playback and full access.",
    stripePriceId: STRIPE_ANNUAL_PRICE_ID,
    includedMinutes: Math.max(1, Number(process.env.ANNUAL_MINUTES || 3600)),
  },
];

const STATE_PATH = path.join(__dirname, "auth-stripe-state.json");
const GOOGLE_STATE_TTL_MS = 10 * 60 * 1000;

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix) {
  const chunk = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
  return `${prefix}_${chunk}`;
}

function createEmptyState() {
  return {
    accountsById: {},
    emailToAccountId: {},
    googleSubToAccountId: {},
    deviceToAccountId: {},
    deviceUsageByToken: {},
    accountUsageByPeriod: {},
    accountToCustomer: {},
    customerToAccount: {},
    sessionToAccount: {},
    googleStates: {},
  };
}

function ensureStateFile() {
  if (!fs.existsSync(STATE_PATH)) {
    fs.writeFileSync(STATE_PATH, JSON.stringify(createEmptyState(), null, 2));
  }
}

function cleanupState(state) {
  const now = Date.now();

  Object.entries(state.googleStates || {}).forEach(([token, entry]) => {
    const expiresAt = Date.parse(entry?.expiresAt || "");
    if (!Number.isFinite(expiresAt) || expiresAt < now) {
      delete state.googleStates[token];
    }
  });
}

function readState() {
  ensureStateFile();
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const state = {
      ...createEmptyState(),
      ...parsed,
    };
    cleanupState(state);
    return state;
  } catch (_error) {
    return createEmptyState();
  }
}

function writeState(state) {
  cleanupState(state);
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Stripe-Signature, x-device-token"
  );
}

function sendJson(res, status, payload) {
  setCorsHeaders(res);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendHtml(res, status, html) {
  setCorsHeaders(res);
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function redirect(res, location) {
  setCorsHeaders(res);
  res.writeHead(302, { Location: location });
  res.end();
}

function ensureStripeConfigured(res) {
  if (stripe) {
    return true;
  }
  sendJson(res, 500, { error: "STRIPE_SECRET_KEY is not set." });
  return false;
}

function getPublicUrl(pathname) {
  if (!PUBLIC_BASE_URL) {
    return `http://127.0.0.1:${PORT}${pathname}`;
  }
  return `${PUBLIC_BASE_URL}${pathname}`;
}

function sanitizeExtensionReturnUrl(value) {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "chrome-extension:") {
      return "";
    }
    parsed.hash = "";
    return parsed.toString();
  } catch (_error) {
    return "";
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalSize = 0;

    req.on("data", (chunk) => {
      totalSize += chunk.length;
      if (totalSize > 2 * 1024 * 1024) {
        reject(new Error("Payload too large."));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    req.on("error", (error) => {
      reject(error);
    });
  });
}

async function parseJsonBody(req) {
  const buffer = await readBody(req);
  if (!buffer.length) {
    return {};
  }
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch (_error) {
    throw new Error("Invalid JSON payload.");
  }
}

function getPlanById(planId) {
  if (!planId) {
    return null;
  }

  const normalized = planId === "yearly" ? "annual" : planId;
  return PLAN_DEFINITIONS.find((plan) => plan.id === normalized) || null;
}

function getPlanByStripePriceId(priceId) {
  return PLAN_DEFINITIONS.find((plan) => plan.stripePriceId === priceId) || null;
}

function getDeviceToken(req, parsedUrl, body) {
  return (
    req.headers["x-device-token"] ||
    parsedUrl.searchParams.get("device_token") ||
    body?.device_token ||
    body?.installId ||
    ""
  )
    .toString()
    .trim();
}

function getOrCreateAccount(state, email, options = {}) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail) {
    throw new Error("Email is required.");
  }

  const googleSub = String(options.googleSub || "").trim();
  let accountId = state.emailToAccountId[normalizedEmail] || "";

  if (!accountId && googleSub) {
    accountId = state.googleSubToAccountId[googleSub] || "";
  }

  if (!accountId) {
    accountId = randomId("acct");
    state.accountsById[accountId] = {
      id: accountId,
      email: normalizedEmail,
      googleSub: googleSub || null,
      method: options.method || "email",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
  } else {
    const existing = state.accountsById[accountId];
    existing.email = normalizedEmail;
    if (googleSub) {
      existing.googleSub = googleSub;
      existing.method = "google";
    } else if (!existing.method) {
      existing.method = options.method || "email";
    }
    existing.updatedAt = nowIso();
  }

  state.emailToAccountId[normalizedEmail] = accountId;
  if (googleSub) {
    state.googleSubToAccountId[googleSub] = accountId;
  }

  return state.accountsById[accountId];
}

function getOrCreateDeviceUsage(state, deviceToken) {
  if (!deviceToken) {
    return {
      minutesLeft: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
  }

  if (!state.deviceUsageByToken[deviceToken]) {
    state.deviceUsageByToken[deviceToken] = {
      minutesLeft: FREE_MINUTES,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
  }

  const usage = state.deviceUsageByToken[deviceToken];
  if (!Number.isFinite(Number(usage.minutesLeft))) {
    usage.minutesLeft = FREE_MINUTES;
  }
  usage.minutesLeft = Math.max(0, Math.floor(Number(usage.minutesLeft)));
  usage.updatedAt = usage.updatedAt || nowIso();
  usage.createdAt = usage.createdAt || nowIso();
  return usage;
}

function deductDeviceMinutes(state, deviceToken, minutes) {
  const usage = getOrCreateDeviceUsage(state, deviceToken);
  if (usage.minutesLeft < minutes) {
    return false;
  }
  usage.minutesLeft -= minutes;
  usage.updatedAt = nowIso();
  return true;
}

function addDeviceMinutes(state, deviceToken, minutes) {
  const usage = getOrCreateDeviceUsage(state, deviceToken);
  usage.minutesLeft += minutes;
  usage.updatedAt = nowIso();
}

function linkDeviceToAccount(state, deviceToken, accountId) {
  if (!deviceToken || !accountId) {
    return;
  }
  state.deviceToAccountId[deviceToken] = accountId;
  const account = state.accountsById[accountId];
  if (account) {
    account.updatedAt = nowIso();
  }
}

function unlinkDevice(state, deviceToken) {
  if (!deviceToken) {
    return;
  }
  delete state.deviceToAccountId[deviceToken];
}

function getAccountForDevice(state, deviceToken) {
  const accountId = state.deviceToAccountId[deviceToken] || "";
  return state.accountsById[accountId] || null;
}

function rememberAccountCustomer(state, accountId, customerId) {
  if (!accountId || !customerId) {
    return;
  }
  state.accountToCustomer[accountId] = customerId;
  state.customerToAccount[customerId] = accountId;
}

function getIncludedMinutesForPlan(planId) {
  return (
    PLAN_DEFINITIONS.find((plan) => plan.id === planId)?.includedMinutes || 0
  );
}

function getAccountUsagePeriodKey(subscription) {
  const subscriptionId = subscription?.plan?.subscriptionId || "";
  const periodEnd = subscription?.plan?.currentPeriodEnd || "open";
  return subscriptionId ? `${subscriptionId}:${periodEnd}` : "";
}

function getOrCreateAccountPeriodUsage(state, accountId, subscription) {
  const periodKey = getAccountUsagePeriodKey(subscription);
  if (!accountId || !periodKey) {
    return null;
  }

  const includedMinutes = getIncludedMinutesForPlan(subscription?.plan?.planId);
  if (!includedMinutes) {
    return null;
  }

  if (!state.accountUsageByPeriod[accountId]) {
    state.accountUsageByPeriod[accountId] = {};
  }

  if (!state.accountUsageByPeriod[accountId][periodKey]) {
    state.accountUsageByPeriod[accountId][periodKey] = {
      subscriptionId: subscription.plan.subscriptionId || null,
      planId: subscription.plan.planId || null,
      periodKey,
      periodEnd: subscription.plan.currentPeriodEnd || null,
      includedMinutes,
      minutesUsed: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
  }

  const usage = state.accountUsageByPeriod[accountId][periodKey];
  usage.includedMinutes = includedMinutes;
  usage.planId = subscription.plan.planId || usage.planId || null;
  usage.subscriptionId = subscription.plan.subscriptionId || usage.subscriptionId || null;
  usage.periodEnd = subscription.plan.currentPeriodEnd || usage.periodEnd || null;
  usage.minutesUsed = Math.max(0, Math.floor(Number(usage.minutesUsed) || 0));
  usage.updatedAt = usage.updatedAt || nowIso();
  usage.createdAt = usage.createdAt || nowIso();
  return usage;
}

function getPaidMinutesLeft(state, account, subscription) {
  if (!account || !subscription?.active) {
    return 0;
  }

  const usage = getOrCreateAccountPeriodUsage(state, account.id, subscription);
  if (!usage) {
    return Number.MAX_SAFE_INTEGER;
  }

  return Math.max(0, usage.includedMinutes - usage.minutesUsed);
}

function deductPaidMinutes(state, account, subscription, minutes) {
  const usage = getOrCreateAccountPeriodUsage(state, account?.id, subscription);
  if (!usage) {
    return true;
  }
  const minutesLeft = Math.max(0, usage.includedMinutes - usage.minutesUsed);
  if (minutesLeft < minutes) {
    return false;
  }
  usage.minutesUsed += minutes;
  usage.updatedAt = nowIso();
  return true;
}

function refundPaidMinutes(state, account, subscription, minutes) {
  const usage = getOrCreateAccountPeriodUsage(state, account?.id, subscription);
  if (!usage) {
    return;
  }
  usage.minutesUsed = Math.max(0, usage.minutesUsed - minutes);
  usage.updatedAt = nowIso();
}

async function ensureStripeCustomer(state, account) {
  const existingCustomerId = state.accountToCustomer[account.id];
  if (existingCustomerId) {
    return existingCustomerId;
  }

  const customer = await stripe.customers.create({
    email: account.email,
    metadata: {
      accountId: account.id,
    },
  });

  rememberAccountCustomer(state, account.id, customer.id);
  return customer.id;
}

async function lookupSubscriptionStatusForAccount(state, account) {
  if (!account) {
    return {
      active: false,
      status: "none",
      plan: null,
      customerId: null,
      email: null,
      signedIn: false,
    };
  }

  if (!stripe) {
    return {
      active: false,
      status: "none",
      plan: null,
      customerId: state.accountToCustomer[account.id] || null,
      email: account.email,
      signedIn: true,
    };
  }

  const customerId = state.accountToCustomer[account.id];
  if (!customerId) {
    return {
      active: false,
      status: "none",
      plan: null,
      customerId: null,
      email: account.email,
      signedIn: true,
    };
  }

  const subscriptions = await stripe.subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 20,
  });

  const activeSub = subscriptions.data.find(
    (sub) => sub.status === "active" || sub.status === "trialing"
  );

  if (!activeSub) {
    return {
      active: false,
      status: subscriptions.data[0]?.status || "none",
      plan: null,
      customerId,
      email: account.email,
      signedIn: true,
    };
  }

  const item = activeSub.items?.data?.[0];
  const plan = getPlanByStripePriceId(item?.price?.id || "");

  return {
    active: true,
    status: activeSub.status,
    customerId,
    email: account.email,
    signedIn: true,
    plan: {
      planId: plan?.id || activeSub.metadata?.planId || null,
      subscriptionId: activeSub.id,
      priceId: item?.price?.id || null,
      interval: item?.price?.recurring?.interval || null,
      currentPeriodStart: activeSub.current_period_start || null,
      currentPeriodEnd: activeSub.current_period_end || null,
    },
  };
}

async function fetchGoogleUserInfo(accessToken) {
  const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(details || "Failed to fetch Google profile.");
  }

  return response.json();
}

function handleHealth(res) {
  sendJson(res, 200, { ok: true });
}

async function handleAuthMe(req, res, parsedUrl) {
  const deviceToken = getDeviceToken(req, parsedUrl, null);
  if (!deviceToken) {
    sendJson(res, 200, {
      signedIn: false,
      email: "",
      method: null,
      subscriptionStatus: "none",
      plan: null,
      paid: false,
      minutesLeft: FREE_MINUTES,
    });
    return;
  }

  const state = readState();
  const account = getAccountForDevice(state, deviceToken);
  const subscription = await lookupSubscriptionStatusForAccount(state, account);
  const usage = getOrCreateDeviceUsage(state, deviceToken);
  const paidMinutesLeft = getPaidMinutesLeft(state, account, subscription);

  sendJson(res, 200, {
    signedIn: Boolean(account),
    email: account?.email || "",
    method: account?.method || null,
    signedInAt: account?.updatedAt || null,
    paid: subscription.active,
    subscriptionStatus: subscription.status || "none",
    plan: subscription.plan?.planId || null,
    minutesLeft: subscription.active ? paidMinutesLeft : usage.minutesLeft,
  });
}

function renderAuthCompletePage(title, message, returnUrl = "") {
  const safeReturn = sanitizeExtensionReturnUrl(returnUrl);
  const cta = safeReturn
    ? `<p><a href="${safeReturn}">Return to the extension</a></p>`
    : `<p>You can now return to the extension and continue.</p>`;

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>${title}</title>
    <style>
      body { font-family: Arial, sans-serif; padding: 32px; background: #f8fafc; color: #0f172a; }
      a { color: #2563eb; }
    </style>
  </head>
  <body>
    <h1>${title}</h1>
    <p>${message}</p>
    ${cta}
  </body>
</html>`;
}

async function handleGoogleStart(req, res, parsedUrl) {
  const deviceToken = getDeviceToken(req, parsedUrl, null);
  const returnUrl = sanitizeExtensionReturnUrl(parsedUrl.searchParams.get("return_url") || "");

  if (!deviceToken) {
    sendHtml(
      res,
      400,
      renderAuthCompletePage("Google sign-in unavailable", "device_token is required.")
    );
    return;
  }

  if (!GOOGLE_OAUTH_CLIENT_ID || !GOOGLE_OAUTH_CLIENT_SECRET || !PUBLIC_BASE_URL) {
    sendHtml(
      res,
      500,
      renderAuthCompletePage(
        "Google sign-in unavailable",
        "Google OAuth is not configured on the server yet."
      )
    );
    return;
  }

  const state = readState();
  const oauthState = randomId("google_state");
  state.googleStates[oauthState] = {
    deviceToken,
    returnUrl,
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + GOOGLE_STATE_TTL_MS).toISOString(),
  };
  writeState(state);

  const googleUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  googleUrl.searchParams.set("client_id", GOOGLE_OAUTH_CLIENT_ID);
  googleUrl.searchParams.set("redirect_uri", getPublicUrl("/auth/google/callback"));
  googleUrl.searchParams.set("response_type", "code");
  googleUrl.searchParams.set("scope", "openid email profile");
  googleUrl.searchParams.set("state", oauthState);
  googleUrl.searchParams.set("prompt", "select_account");

  redirect(res, googleUrl.toString());
}

async function exchangeGoogleCodeForProfile(code) {
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_OAUTH_CLIENT_ID,
      client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
      redirect_uri: getPublicUrl("/auth/google/callback"),
      grant_type: "authorization_code",
    }),
  });

  if (!tokenResponse.ok) {
    const details = await tokenResponse.text().catch(() => "");
    throw new Error(details || "Failed to exchange Google authorization code.");
  }

  const tokenData = await tokenResponse.json();
  if (!tokenData.access_token) {
    throw new Error("Google access token is missing.");
  }

  return fetchGoogleUserInfo(tokenData.access_token);
}

async function handleGoogleCallback(_req, res, parsedUrl) {
  const oauthState = parsedUrl.searchParams.get("state") || "";
  const code = parsedUrl.searchParams.get("code") || "";

  if (!oauthState || !code) {
    sendHtml(
      res,
      400,
      renderAuthCompletePage("Google sign-in failed", "Missing OAuth parameters.")
    );
    return;
  }

  const state = readState();
  const pending = state.googleStates[oauthState];
  if (!pending) {
    sendHtml(
      res,
      400,
      renderAuthCompletePage("Google sign-in failed", "This sign-in request is no longer valid.")
    );
    return;
  }

  try {
    const profile = await exchangeGoogleCodeForProfile(code);
    if (!profile?.email || profile?.email_verified === false) {
      throw new Error("Google did not return a verified email address.");
    }

    const account = getOrCreateAccount(state, profile.email, {
      method: "google",
      googleSub: profile.sub || "",
    });
    linkDeviceToAccount(state, pending.deviceToken, account.id);
    delete state.googleStates[oauthState];
    writeState(state);

    sendHtml(
      res,
      200,
      renderAuthCompletePage(
        "Google sign-in complete",
        `Signed in as ${account.email}.`,
        pending.returnUrl
      )
    );
  } catch (error) {
    delete state.googleStates[oauthState];
    writeState(state);
    sendHtml(
      res,
      500,
      renderAuthCompletePage("Google sign-in failed", error.message || "Unable to sign in.")
    );
  }
}

async function handleAuthLogout(req, res, parsedUrl) {
  let body = {};
  try {
    body = await parseJsonBody(req);
  } catch (_error) {
    body = {};
  }

  const deviceToken = getDeviceToken(req, parsedUrl, body);
  const state = readState();
  unlinkDevice(state, deviceToken);
  writeState(state);
  sendJson(res, 200, { ok: true });
}

async function handleCreateCheckoutSession(req, res, parsedUrl) {
  if (!ensureStripeConfigured(res)) {
    return;
  }

  let body;
  try {
    body = await parseJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error.message || "Invalid request body." });
    return;
  }

  const deviceToken = getDeviceToken(req, parsedUrl, body);
  const rawPlanId =
    typeof body.planId === "string"
      ? body.planId.trim()
      : typeof body.plan === "string"
      ? body.plan.trim()
      : "";
  const returnUrl = sanitizeExtensionReturnUrl(body.returnUrl || body.return_url || "");
  if (!deviceToken || !rawPlanId) {
    sendJson(res, 400, { error: "device_token and plan are required." });
    return;
  }

  const selectedPlan = getPlanById(rawPlanId);
  if (!selectedPlan) {
    sendJson(res, 400, { error: "Unknown paid plan." });
    return;
  }

  if (!selectedPlan.stripePriceId) {
    sendJson(res, 500, { error: `Stripe price ID is not configured for ${selectedPlan.id}.` });
    return;
  }

  const state = readState();
  let account = getAccountForDevice(state, deviceToken);

  if (!account) {
    sendJson(res, 401, { error: "Sign in is required before checkout." });
    return;
  }

  try {
    const customerId = await ensureStripeCustomer(state, account);
    const cancelUrl = returnUrl || getPublicUrl("/paywall/cancel");
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: selectedPlan.stripePriceId, quantity: 1 }],
      success_url: `${getPublicUrl("/paywall/success")}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl,
      customer: customerId,
      client_reference_id: account.id,
      metadata: {
        accountId: account.id,
        email: account.email,
        deviceToken,
        planId: selectedPlan.id,
      },
      allow_promotion_codes: true,
      subscription_data: {
        metadata: {
          accountId: account.id,
          email: account.email,
          deviceToken,
          planId: selectedPlan.id,
        },
      },
    });

    state.sessionToAccount[session.id] = account.id;
    rememberAccountCustomer(state, account.id, customerId);
    writeState(state);

    sendJson(res, 200, { url: session.url, sessionId: session.id });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Failed to create checkout session." });
  }
}

async function handleSubscriptionStatus(req, res, parsedUrl) {
  if (!ensureStripeConfigured(res)) {
    return;
  }

  const deviceToken = getDeviceToken(req, parsedUrl, null);
  if (!deviceToken) {
    sendJson(res, 200, {
      active: false,
      status: "none",
      plan: null,
      customerId: null,
      email: null,
      signedIn: false,
    });
    return;
  }

  try {
    const state = readState();
    const account = getAccountForDevice(state, deviceToken);
    const status = await lookupSubscriptionStatusForAccount(state, account);
    const usage = getOrCreateDeviceUsage(state, deviceToken);
    const paidMinutesLeft = getPaidMinutesLeft(state, account, status);
    sendJson(res, 200, {
      deviceToken,
      ...status,
      minutesLeft: status.active ? paidMinutesLeft : usage.minutesLeft,
      paid: status.active,
      subscriptionStatus: status.status || "none",
    });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Failed to read subscription status." });
  }
}

async function handleStripeWebhook(req, res) {
  if (!ensureStripeConfigured(res)) {
    return;
  }
  if (!STRIPE_WEBHOOK_SECRET) {
    sendJson(res, 500, { error: "STRIPE_WEBHOOK_SECRET is not set." });
    return;
  }

  let rawBody;
  try {
    rawBody = await readBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error.message || "Unable to read webhook body." });
    return;
  }

  const signature = req.headers["stripe-signature"];
  if (!signature) {
    sendJson(res, 400, { error: "Missing Stripe-Signature header." });
    return;
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    sendJson(res, 400, { error: `Webhook signature verification failed: ${error.message}` });
    return;
  }

  const state = readState();

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const accountId =
        session.client_reference_id ||
        session.metadata?.accountId ||
        state.sessionToAccount?.[session.id] ||
        "";
      const customerId = typeof session.customer === "string" ? session.customer : "";
      rememberAccountCustomer(state, accountId, customerId);
    }

    if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      const sub = event.data.object;
      const customerId = typeof sub.customer === "string" ? sub.customer : "";
      const accountId = sub.metadata?.accountId || state.customerToAccount?.[customerId] || "";
      rememberAccountCustomer(state, accountId, customerId);
    }

    writeState(state);
    sendJson(res, 200, { received: true });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Webhook handler failed." });
  }
}

async function handleTts(req, res, parsedUrl) {
  if (!OPENAI_API_KEY) {
    sendJson(res, 500, { error: "OPENAI_API_KEY is not set." });
    return;
  }

  let body;
  try {
    body = await parseJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error.message || "Invalid request body." });
    return;
  }

  const text =
    typeof body.input === "string" && body.input.trim()
      ? body.input.trim()
      : typeof body.text === "string"
      ? body.text.trim()
      : "";
  const speed = Number(body.speed);

  if (!text) {
    sendJson(res, 400, { error: "Text is required." });
    return;
  }

  const deviceToken = getDeviceToken(req, parsedUrl, body);
  if (!deviceToken) {
    sendJson(res, 400, { error: "Missing device token." });
    return;
  }

  const state = readState();
  const account = getAccountForDevice(state, deviceToken);
  const subscription = await lookupSubscriptionStatusForAccount(state, account);
  const usageCost = Math.max(1, Math.ceil(text.length / CHAR_PER_MINUTE));
  const shouldChargeTrial = !subscription.active;
  const shouldChargePaidPlan = subscription.active;

  if (shouldChargeTrial) {
    if (!deductDeviceMinutes(state, deviceToken, usageCost)) {
      sendJson(res, 402, { error: "not-enough-queries" });
      return;
    }
    writeState(state);
  }

  if (shouldChargePaidPlan) {
    if (!deductPaidMinutes(state, account, subscription, usageCost)) {
      sendJson(res, 402, { error: "paid-plan-limit-reached" });
      return;
    }
    writeState(state);
  }

  const payload = {
    model: OPENAI_TTS_MODEL,
    voice: OPENAI_TTS_VOICE,
    input: text,
    response_format: "mp3",
  };

  if (Number.isFinite(speed)) {
    payload.speed = Math.min(4, Math.max(0.25, speed));
  }

  try {
    const upstream = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!upstream.ok) {
      const details = await upstream.text().catch(() => "");
      if (shouldChargeTrial) {
        addDeviceMinutes(state, deviceToken, usageCost);
        writeState(state);
      }
      if (shouldChargePaidPlan) {
        refundPaidMinutes(state, account, subscription, usageCost);
        writeState(state);
      }
      sendJson(res, upstream.status, {
        error: details || "OpenAI TTS request failed.",
      });
      return;
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    setCorsHeaders(res);
    res.writeHead(200, {
      "Content-Type": upstream.headers.get("content-type") || "audio/mpeg",
      "Cache-Control": "no-store",
    });
    res.end(buffer);
  } catch (error) {
    if (shouldChargeTrial) {
      addDeviceMinutes(state, deviceToken, usageCost);
      writeState(state);
    }
    if (shouldChargePaidPlan) {
      refundPaidMinutes(state, account, subscription, usageCost);
      writeState(state);
    }
    sendJson(res, 502, { error: error.message || "Failed to call OpenAI TTS." });
  }
}

function handleSuccessPage(res) {
  sendHtml(
    res,
    200,
    renderAuthCompletePage(
      "Payment successful",
      "Your subscription is active. Return to the extension and refresh your account state."
    )
  );
}

function handleCancelPage(res) {
  sendHtml(
    res,
    200,
    renderAuthCompletePage(
      "Checkout canceled",
      "No changes were made. You can return to the extension and try again anytime."
    )
  );
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    setCorsHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === "GET" && parsedUrl.pathname === "/health") {
    handleHealth(res);
    return;
  }

  if (req.method === "GET" && parsedUrl.pathname === "/auth/me") {
    await handleAuthMe(req, res, parsedUrl);
    return;
  }

  if (req.method === "GET" && parsedUrl.pathname === "/me") {
    await handleAuthMe(req, res, parsedUrl);
    return;
  }

  if (req.method === "GET" && parsedUrl.pathname === "/auth/google/start") {
    await handleGoogleStart(req, res, parsedUrl);
    return;
  }

  if (req.method === "GET" && parsedUrl.pathname === "/auth/google/callback") {
    await handleGoogleCallback(req, res, parsedUrl);
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/auth/logout") {
    await handleAuthLogout(req, res, parsedUrl);
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/tts") {
    await handleTts(req, res, parsedUrl);
    return;
  }

  if (
    req.method === "POST" &&
    (parsedUrl.pathname === "/stripe/checkout-session" || parsedUrl.pathname === "/checkout")
  ) {
    await handleCreateCheckoutSession(req, res, parsedUrl);
    return;
  }

  if (
    req.method === "GET" &&
    (parsedUrl.pathname === "/stripe/subscription-status" || parsedUrl.pathname === "/auth/subscription")
  ) {
    await handleSubscriptionStatus(req, res, parsedUrl);
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/stripe/webhook") {
    await handleStripeWebhook(req, res);
    return;
  }

  if (req.method === "GET" && parsedUrl.pathname === "/paywall/success") {
    handleSuccessPage(res);
    return;
  }

  if (req.method === "GET" && parsedUrl.pathname === "/paywall/cancel") {
    handleCancelPage(res);
    return;
  }

  sendJson(res, 404, { error: "Not found." });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Proxy server is running on http://127.0.0.1:${PORT}`);
  console.log(
    "Required env: OPENAI_API_KEY, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_MONTHLY_PRICE_ID, STRIPE_YEARLY_PRICE_ID, PUBLIC_BASE_URL"
  );
  console.log(
    "Optional auth env: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET"
  );
  console.log(
    "Optional quota env: FREE_MINUTES, CHAR_PER_MINUTE, MONTHLY_MINUTES, ANNUAL_MINUTES"
  );
});
