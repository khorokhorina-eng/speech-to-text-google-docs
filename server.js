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
const FREE_TRIAL_SESSIONS = Math.max(1, Number(process.env.FREE_TRIAL_SESSIONS || 10));
const FREE_MINUTES = Math.max(1, Number(process.env.FREE_MINUTES || 2));
const FREE_TRIAL_SECONDS = Math.max(1, Math.floor(FREE_MINUTES * 60));
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const STRIPE_MONTHLY_PRICE_ID =
  process.env.STRIPE_MONTHLY_PRICE_ID || process.env.STRIPE_PRICE_MONTHLY || "";
const STRIPE_ANNUAL_PRICE_ID =
  process.env.STRIPE_YEARLY_PRICE_ID || process.env.STRIPE_PRICE_ANNUAL || "";
const PRODUCT_SLUG = "speech_to_text_google_docs";
const APP_STRIPE_PRICE_IDS = new Set(
  [STRIPE_MONTHLY_PRICE_ID, STRIPE_ANNUAL_PRICE_ID].filter(Boolean)
);

const GOOGLE_OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || "";
const GOOGLE_OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || "";
const GA4_MEASUREMENT_ID = process.env.GA4_MEASUREMENT_ID || "G-ZBJ96ZZ3BW";
const GA4_API_SECRET = process.env.GA4_API_SECRET || "";

const PLAN_DEFINITIONS = [
  {
    id: "monthly",
    name: "Monthly plan",
    description: "Unlimited dictation in Google Docs with monthly billing.",
    stripePriceId: STRIPE_MONTHLY_PRICE_ID,
    includedMinutes: Math.max(1, Number(process.env.MONTHLY_MINUTES || 300)),
  },
  {
    id: "annual",
    name: "Annual plan",
    description: "Unlimited dictation in Google Docs with annual billing.",
    stripePriceId: STRIPE_ANNUAL_PRICE_ID,
    includedMinutes: Math.max(1, Number(process.env.ANNUAL_MINUTES || 3600)),
  },
];

const STATE_PATH = path.join(__dirname, "auth-stripe-state.json");
const GOOGLE_STATE_TTL_MS = 10 * 60 * 1000;

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
const PLAN_PRICING_CACHE_MS = 5 * 60 * 1000;
let planPricingCache = {
  timestamp: 0,
  plans: null,
};

function roundUsageMinutes(value) {
  return Math.max(0, Math.round(Number(value || 0) * 100) / 100);
}

function normalizeSeconds(value, fallback = 0) {
  if (!Number.isFinite(Number(value))) {
    return Math.max(0, Math.floor(Number(fallback) || 0));
  }
  return Math.max(0, Math.floor(Number(value)));
}

function displayMinutesFromSeconds(seconds) {
  return Math.ceil(normalizeSeconds(seconds) / 60);
}

function nowIso() {
  return new Date().toISOString();
}

function renderGa4Snippet(pagePath, eventName = "", eventParams = null) {
  if (!GA4_MEASUREMENT_ID) {
    return "";
  }

  return `
    <script async src="https://www.googletagmanager.com/gtag/js?id=${GA4_MEASUREMENT_ID}"></script>
    <script>
      window.dataLayer = window.dataLayer || [];
      function gtag(){dataLayer.push(arguments);}
      gtag('js', new Date());
      gtag('config', ${JSON.stringify(GA4_MEASUREMENT_ID)}, ${JSON.stringify({
        page_path: pagePath || "/",
      })});
      ${eventName ? `gtag('event', ${JSON.stringify(eventName)}, ${JSON.stringify(eventParams || {})});` : ""}
    </script>`;
}

function sanitizeAnalyticsEventName(name) {
  const normalized = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return normalized || "";
}

function sanitizeAnalyticsParams(rawParams) {
  if (!rawParams || typeof rawParams !== "object" || Array.isArray(rawParams)) {
    return {};
  }

  const sanitized = {};
  for (const [key, value] of Object.entries(rawParams)) {
    const normalizedKey = String(key || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40);
    if (!normalizedKey) {
      continue;
    }

    if (typeof value === "string") {
      sanitized[normalizedKey] = value.slice(0, 100);
      continue;
    }
    if (typeof value === "boolean") {
      sanitized[normalizedKey] = value ? "true" : "false";
      continue;
    }
    if (Array.isArray(value)) {
      const normalizedItems = value
        .map((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            return null;
          }
          const nextEntry = {};
          for (const [itemKey, itemValue] of Object.entries(entry)) {
            const nextKey = String(itemKey || "")
              .trim()
              .toLowerCase()
              .replace(/[^a-z0-9_]+/g, "_")
              .replace(/^_+|_+$/g, "")
              .slice(0, 40);
            if (!nextKey) {
              continue;
            }
            if (typeof itemValue === "string") {
              nextEntry[nextKey] = itemValue.slice(0, 100);
            } else if (typeof itemValue === "boolean") {
              nextEntry[nextKey] = itemValue ? "true" : "false";
            } else if (Number.isFinite(Number(itemValue))) {
              nextEntry[nextKey] = Number(itemValue);
            }
          }
          return Object.keys(nextEntry).length ? nextEntry : null;
        })
        .filter(Boolean);
      if (normalizedItems.length) {
        sanitized[normalizedKey] = normalizedItems;
      }
      continue;
    }
    if (Number.isFinite(Number(value))) {
      sanitized[normalizedKey] = Number(value);
    }
  }

  return sanitized;
}

async function sendGa4Measurement({
  clientId,
  userId = "",
  sessionId = "",
  eventName,
  params = {},
}) {
  if (!GA4_MEASUREMENT_ID || !GA4_API_SECRET) {
    return { ok: false, skipped: true, reason: "ga4_not_configured" };
  }

  const safeEventName = sanitizeAnalyticsEventName(eventName);
  if (!safeEventName || !clientId) {
    return { ok: false, skipped: true, reason: "invalid_payload" };
  }

  const payload = {
    client_id: String(clientId),
    events: [
      {
        name: safeEventName,
        params: {
          session_id: String(sessionId || Date.now()),
          engagement_time_msec: 1,
          ...sanitizeAnalyticsParams(params),
        },
      },
    ],
  };

  if (userId) {
    payload.user_id = String(userId);
  }

  const response = await fetch(
    `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(GA4_MEASUREMENT_ID)}&api_secret=${encodeURIComponent(GA4_API_SECRET)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }
  );

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(details || `GA4 request failed with ${response.status}`);
  }

  return { ok: true };
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
    sessionToReturnUrl: {},
    purchaseEventsSent: {},
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

  Object.entries(state.purchaseEventsSent || {}).forEach(([sessionId, sentAt]) => {
    const timestamp = Date.parse(sentAt || "");
    if (!Number.isFinite(timestamp) || timestamp < now - 1000 * 60 * 60 * 24 * 30) {
      delete state.purchaseEventsSent[sessionId];
    }
  });
}

function buildPurchaseAnalyticsParamsFromSession(session, planLookup, fallbackPlanId, fallbackPlanName) {
  const planId =
    session?.metadata?.planId ||
    session?.subscription_details?.metadata?.planId ||
    fallbackPlanId;
  const planName = planLookup(planId)?.name || fallbackPlanName;
  const amount = Number(session?.amount_total || 0) / 100;
  return {
    transaction_id: String(session?.id || ""),
    value: amount,
    currency: String(session?.currency || "usd").toUpperCase(),
    items: [
      {
        item_id: String(planId || fallbackPlanId),
        item_name: String(planName),
        price: amount,
        quantity: 1,
      },
    ],
  };
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

function getSubscriptionOverrideForAccount(state, account) {
  const normalizedEmail = String(account?.email || "").trim().toLowerCase();
  if (!normalizedEmail) {
    return null;
  }

  const override = state.subscriptionOverridesByEmail?.[normalizedEmail];
  if (!override || override.active !== true) {
    return null;
  }

  const planId = String(override.planId || "monthly");
  const periodEndIso = override.currentPeriodEnd || null;
  const periodEndMs = periodEndIso ? Date.parse(periodEndIso) : NaN;
  if (Number.isFinite(periodEndMs) && periodEndMs <= Date.now()) {
    delete state.subscriptionOverridesByEmail[normalizedEmail];
    return null;
  }

  const plan = PLAN_DEFINITIONS.find((entry) => entry.id === planId) || PLAN_DEFINITIONS[0] || null;
  const interval = planId === "annual" ? "year" : "month";
  const currentPeriodStart =
    override.currentPeriodStart ||
    new Date(Date.now() - 1000 * 60 * 60).toISOString();
  const currentPeriodEnd =
    periodEndIso ||
    new Date(
      Date.now() + (interval === "year" ? 1000 * 60 * 60 * 24 * 365 : 1000 * 60 * 60 * 24 * 31)
    ).toISOString();

  return {
    active: true,
    status: "active",
    customerId: state.accountToCustomer[account.id] || null,
    email: normalizedEmail,
    signedIn: true,
    plan: {
      planId: plan?.id || planId,
      subscriptionId: String(override.subscriptionId || `override_${planId}_${normalizedEmail}`),
      priceId: String(override.priceId || ""),
      interval,
      currentPeriodStart,
      currentPeriodEnd,
      cancelAtPeriodEnd: Boolean(override.cancelAtPeriodEnd),
      cancelAt: override.cancelAt || null,
    },
  };
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Stripe-Signature, x-device-token, x-audio-mime"
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
    if (!["chrome-extension:", "https:", "http:", "file:"].includes(parsed.protocol)) {
      return "";
    }
    parsed.hash = "";
    return parsed.toString();
  } catch (_error) {
    return "";
  }
}

function sanitizeReturnUrl(value) {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  try {
    const parsed = new URL(trimmed);
    if (!["chrome-extension:", "https:"].includes(parsed.protocol)) {
      return "";
    }
    parsed.hash = "";
    return parsed.toString();
  } catch (_error) {
    return "";
  }
}

function readBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalSize = 0;

    req.on("data", (chunk) => {
      totalSize += chunk.length;
      if (totalSize > maxBytes) {
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

async function readBinaryBody(req, maxBytes = 12 * 1024 * 1024) {
  return readBody(req, maxBytes);
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

function isRelevantStripePriceId(priceId) {
  return Boolean(priceId) && APP_STRIPE_PRICE_IDS.has(String(priceId));
}

function subscriptionBelongsToThisProduct(subscription) {
  if (!subscription || typeof subscription !== "object") {
    return false;
  }
  if (subscription.metadata?.productSlug === PRODUCT_SLUG) {
    return true;
  }
  return Boolean(
    subscription.items?.data?.some((item) => isRelevantStripePriceId(item?.price?.id || ""))
  );
}

async function checkoutSessionBelongsToThisProduct(session) {
  if (!session || typeof session !== "object") {
    return false;
  }
  if (
    session.metadata?.productSlug === PRODUCT_SLUG ||
    session.subscription_details?.metadata?.productSlug === PRODUCT_SLUG
  ) {
    return true;
  }
  if (isRelevantStripePriceId(session.line_items?.data?.[0]?.price?.id || "")) {
    return true;
  }
  if (!stripe || !session.id) {
    return false;
  }
  const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 10 });
  return Boolean(lineItems.data?.some((item) => isRelevantStripePriceId(item?.price?.id || "")));
}

function formatCurrencyAmount(amountCents, currency = "usd") {
  if (!Number.isFinite(Number(amountCents))) {
    return "";
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: String(currency || "usd").toUpperCase(),
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(amountCents) / 100);
}

function getPlanPeriodMeta(interval = "") {
  if (interval === "year") {
    return {
      perLabel: "per year",
      billingLabel: "Billed annually",
      dailyDivisor: 365,
    };
  }
  return {
    perLabel: "per month",
    billingLabel: "Billed monthly",
    dailyDivisor: 30,
  };
}

async function resolvePricingPlans() {
  const now = Date.now();
  if (planPricingCache.plans && now - planPricingCache.timestamp < PLAN_PRICING_CACHE_MS) {
    return planPricingCache.plans;
  }

  const plans = await Promise.all(
    PLAN_DEFINITIONS.map(async (plan) => {
      let amountCents = null;
      let currency = "usd";
      let interval = plan.id === "annual" ? "year" : "month";

      if (stripe && plan.stripePriceId) {
        try {
          const stripePrice = await stripe.prices.retrieve(plan.stripePriceId);
          amountCents = Number.isFinite(Number(stripePrice?.unit_amount))
            ? Number(stripePrice.unit_amount)
            : null;
          currency = String(stripePrice?.currency || currency);
          interval = String(stripePrice?.recurring?.interval || interval);
        } catch (_error) {
          amountCents = null;
        }
      }

      const periodMeta = getPlanPeriodMeta(interval);
      const dailyAmount =
        amountCents !== null ? amountCents / 100 / periodMeta.dailyDivisor : null;

      return {
        planId: plan.id,
        name: plan.name,
        description: plan.description,
        currency: currency.toUpperCase(),
        amountCents,
        amount: amountCents !== null ? amountCents / 100 : null,
        displayPrice: amountCents !== null ? formatCurrencyAmount(amountCents, currency) : "",
        periodLabel: periodMeta.perLabel,
        billingNote:
          amountCents !== null
            ? `${periodMeta.billingLabel} ${formatCurrencyAmount(amountCents, currency)} ${interval === "year" ? "/ year" : "/ month"}`
            : "",
        dailyPrice:
          dailyAmount !== null
            ? `${formatCurrencyAmount(dailyAmount * 100, currency).replace(/\.00$/, "")}`
            : "",
        dailyUnit: "/day",
        interval,
      };
    })
  );

  planPricingCache = {
    timestamp: now,
    plans,
  };
  return plans;
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
      remainingSeconds: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
  }

  if (!state.deviceUsageByToken[deviceToken]) {
    state.deviceUsageByToken[deviceToken] = {
      minutesLeft: FREE_MINUTES,
      remainingSeconds: FREE_TRIAL_SECONDS,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
  }

  const usage = state.deviceUsageByToken[deviceToken];
  const fallbackSeconds = Number.isFinite(Number(usage.minutesLeft))
    ? Math.ceil(Math.max(0, Number(usage.minutesLeft)) * 60)
    : FREE_TRIAL_SECONDS;
  if (!Number.isFinite(Number(usage.remainingSeconds))) {
    usage.remainingSeconds = fallbackSeconds;
  }
  usage.remainingSeconds = Math.min(
    FREE_TRIAL_SECONDS,
    normalizeSeconds(usage.remainingSeconds, FREE_TRIAL_SECONDS)
  );
  usage.minutesLeft = displayMinutesFromSeconds(usage.remainingSeconds);
  usage.updatedAt = usage.updatedAt || nowIso();
  usage.createdAt = usage.createdAt || nowIso();
  return usage;
}

function hasClaimedAccountTrial(account) {
  if (!account) {
    return false;
  }
  return (
    Number.isFinite(Number(account.trialRemainingSeconds)) ||
    Boolean(account.trialClaimedAt)
  );
}

function setDeviceUsageRemainingSeconds(state, deviceToken, remainingSeconds) {
  if (!deviceToken) {
    return;
  }
  const usage = getOrCreateDeviceUsage(state, deviceToken);
  usage.remainingSeconds = Math.min(FREE_TRIAL_SECONDS, normalizeSeconds(remainingSeconds));
  usage.minutesLeft = displayMinutesFromSeconds(usage.remainingSeconds);
  usage.updatedAt = nowIso();
}

function syncDeviceUsageToAccountTrial(state, deviceToken, account) {
  if (!deviceToken || !account || !hasClaimedAccountTrial(account)) {
    return;
  }
  setDeviceUsageRemainingSeconds(state, deviceToken, account.trialRemainingSeconds);
}

function claimOrSyncAccountTrial(state, account, deviceToken) {
  if (!account) {
    return {
      remainingSeconds: null,
      previousAccountSeconds: null,
      deviceRemainingSeconds: null,
      reducedByAccount: false,
    };
  }

  const deviceUsage = getOrCreateDeviceUsage(state, deviceToken);
  const deviceRemainingSeconds = deviceUsage.remainingSeconds;
  const previousAccountSeconds = hasClaimedAccountTrial(account)
    ? normalizeSeconds(account.trialRemainingSeconds)
    : null;

  if (!hasClaimedAccountTrial(account)) {
    account.trialRemainingSeconds = normalizeSeconds(
      deviceRemainingSeconds,
      FREE_TRIAL_SECONDS
    );
    account.trialClaimedAt = nowIso();
  } else {
    account.trialRemainingSeconds = Math.min(
      FREE_TRIAL_SECONDS,
      normalizeSeconds(account.trialRemainingSeconds, FREE_TRIAL_SECONDS),
      normalizeSeconds(deviceRemainingSeconds, FREE_TRIAL_SECONDS)
    );
  }

  account.updatedAt = nowIso();
  syncDeviceUsageToAccountTrial(state, deviceToken, account);

  return {
    remainingSeconds: account.trialRemainingSeconds,
    previousAccountSeconds,
    deviceRemainingSeconds,
    reducedByAccount:
      Number.isFinite(previousAccountSeconds) &&
      previousAccountSeconds < deviceRemainingSeconds &&
      account.trialRemainingSeconds === previousAccountSeconds,
  };
}

function getFreeTrialRemainingSeconds(state, account, deviceToken) {
  if (!account) {
    return getOrCreateDeviceUsage(state, deviceToken).remainingSeconds;
  }
  return claimOrSyncAccountTrial(state, account, deviceToken).remainingSeconds;
}

function deductDeviceSeconds(state, deviceToken, seconds) {
  const usage = getOrCreateDeviceUsage(state, deviceToken);
  const normalizedSeconds = normalizeSeconds(seconds);
  if (usage.remainingSeconds < normalizedSeconds) {
    return false;
  }
  usage.remainingSeconds -= normalizedSeconds;
  usage.minutesLeft = displayMinutesFromSeconds(usage.remainingSeconds);
  usage.updatedAt = nowIso();
  return true;
}

function addDeviceSeconds(state, deviceToken, seconds) {
  const usage = getOrCreateDeviceUsage(state, deviceToken);
  usage.remainingSeconds = Math.min(
    FREE_TRIAL_SECONDS,
    usage.remainingSeconds + normalizeSeconds(seconds)
  );
  usage.minutesLeft = displayMinutesFromSeconds(usage.remainingSeconds);
  usage.updatedAt = nowIso();
}

function deductFreeTrialSeconds(state, account, deviceToken, seconds) {
  const normalizedSeconds = normalizeSeconds(seconds);
  if (!normalizedSeconds) {
    return true;
  }
  if (!account) {
    return deductDeviceSeconds(state, deviceToken, normalizedSeconds);
  }

  const remainingSeconds = claimOrSyncAccountTrial(state, account, deviceToken).remainingSeconds;
  if (remainingSeconds < normalizedSeconds) {
    return false;
  }

  account.trialRemainingSeconds = remainingSeconds - normalizedSeconds;
  account.updatedAt = nowIso();
  syncDeviceUsageToAccountTrial(state, deviceToken, account);
  return true;
}

function refundFreeTrialSeconds(state, account, deviceToken, seconds) {
  const normalizedSeconds = normalizeSeconds(seconds);
  if (!normalizedSeconds) {
    return;
  }
  if (!account) {
    addDeviceSeconds(state, deviceToken, normalizedSeconds);
    return;
  }

  const remainingSeconds = claimOrSyncAccountTrial(state, account, deviceToken).remainingSeconds;
  account.trialRemainingSeconds = Math.min(FREE_TRIAL_SECONDS, remainingSeconds + normalizedSeconds);
  account.updatedAt = nowIso();
  syncDeviceUsageToAccountTrial(state, deviceToken, account);
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

function forgetAccountCustomer(state, accountId, customerId = "") {
  if (accountId && state.accountToCustomer[accountId]) {
    delete state.accountToCustomer[accountId];
  }
  if (customerId && state.customerToAccount[customerId]) {
    delete state.customerToAccount[customerId];
  }
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
  usage.minutesUsed = roundUsageMinutes(usage.minutesUsed);
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
    try {
      await stripe.customers.retrieve(existingCustomerId);
      return existingCustomerId;
    } catch (error) {
      if (error?.code !== "resource_missing") {
        throw error;
      }
      forgetAccountCustomer(state, account.id, existingCustomerId);
    }
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

  const override = getSubscriptionOverrideForAccount(state, account);
  if (override) {
    return override;
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

  let subscriptions;
  try {
    subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 20,
    });
  } catch (error) {
    if (error?.code !== "resource_missing") {
      throw error;
    }
    forgetAccountCustomer(state, account.id, customerId);
    return {
      active: false,
      status: "none",
      plan: null,
      customerId: null,
      email: account.email,
      signedIn: true,
    };
  }

  const relevantSubscriptions = subscriptions.data.filter(subscriptionBelongsToThisProduct);
  const activeSub = relevantSubscriptions.find(
    (sub) => sub.status === "active" || sub.status === "trialing"
  );

  if (!activeSub) {
    return {
      active: false,
      status: relevantSubscriptions[0]?.status || "none",
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
      cancelAtPeriodEnd: Boolean(activeSub.cancel_at_period_end),
      cancelAt: activeSub.cancel_at || null,
    },
  };
}

async function resolveSubscriptionStatusForAccount(state, account) {
  const override = getSubscriptionOverrideForAccount(state, account);
  if (override) {
    return override;
  }
  return lookupSubscriptionStatusForAccount(state, account);
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

function guessAudioExtension(mimeType) {
  const normalized = String(mimeType || "").toLowerCase();
  if (normalized.includes("webm")) {
    return "webm";
  }
  if (normalized.includes("mp4") || normalized.includes("m4a")) {
    return "m4a";
  }
  if (normalized.includes("mpeg") || normalized.includes("mp3")) {
    return "mp3";
  }
  if (normalized.includes("wav")) {
    return "wav";
  }
  return "webm";
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
      sessionsLeft: FREE_TRIAL_SESSIONS,
      freeTrialSessions: FREE_TRIAL_SESSIONS,
    });
    return;
  }

  try {
    const state = readState();
    const account = getAccountForDevice(state, deviceToken);
    const subscription = await lookupSubscriptionStatusForAccount(state, account);
    if (!subscription.active) {
      getFreeTrialRemainingSeconds(state, account, deviceToken);
    }

    writeState(state);
    sendJson(res, 200, {
      signedIn: Boolean(account),
      email: account?.email || "",
      method: account?.method || null,
      signedInAt: account?.updatedAt || null,
      paid: subscription.active,
      subscriptionStatus: subscription.status || "none",
      plan: subscription.plan || null,
      sessionsLeft: subscription.active ? null : FREE_TRIAL_SESSIONS,
      freeTrialSessions: FREE_TRIAL_SESSIONS,
    });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Failed to read auth state." });
  }
}

function renderAuthCompletePage(title, message, returnUrl = "", analyticsEvent = null) {
  const normalizedTitle = String(title || "").toLowerCase();
  const isSuccess =
    normalizedTitle.includes("successful") ||
    normalizedTitle.includes("success") ||
    normalizedTitle.includes("complete");
  const accentLabel = isSuccess ? "SIGNED IN SUCCESSFULLY" : "SIGN-IN STATUS";
  const helperText = isSuccess ? "Redirecting you back now." : "";
  const bodyText = message;
  const safeReturnUrl = sanitizeReturnUrl(returnUrl);
  const ga4 = renderGa4Snippet(
    isSuccess ? "/reg-complete" : "/auth-status",
    analyticsEvent?.name || "",
    analyticsEvent?.params || null
  );
  const redirectScript =
    isSuccess && safeReturnUrl
      ? `<script>
          window.setTimeout(() => {
            window.location.assign(${JSON.stringify(safeReturnUrl)});
          }, 2200);
        </script>`
      : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    ${ga4}
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: Manrope, "Avenir Next", "Segoe UI", "Helvetica Neue", Arial, sans-serif;
        background:
          radial-gradient(circle at top, rgba(95, 132, 255, 0.18), transparent 30%),
          radial-gradient(circle at top left, rgba(53, 95, 216, 0.1), transparent 26%),
          linear-gradient(180deg, #fbfcff 0%, #f5f7ff 100%);
        color: #191c24;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
      }
      .card {
        width: min(760px, 100%);
        background: rgba(255, 255, 255, 0.96);
        border: 1px solid rgba(223, 230, 244, 0.96);
        border-radius: 30px;
        padding: 30px;
        box-shadow: 0 22px 54px rgba(25, 28, 36, 0.08);
      }
      .eyebrow {
        margin: 0 0 8px;
        font: 700 12px/1.3 Manrope, "Avenir Next", "Segoe UI", "Helvetica Neue", Arial, sans-serif;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: #7388bf;
      }
      h1 {
        margin: 0 0 14px;
        font-size: clamp(24px, 4vw, 34px);
        line-height: 1;
        letter-spacing: -0.03em;
        font-weight: 620;
      }
      .message {
        margin: 0;
        font-size: 16px;
        line-height: 1.5;
        color: #72798b;
      }
      .next-title {
        margin: 0;
        font-size: 20px;
        line-height: 1.2;
        letter-spacing: -0.02em;
        font-weight: 620;
      }
      .next-copy {
        margin: 6px 0 0;
        font-size: 14px;
        line-height: 1.45;
        color: #72798b;
      }
      .redirect-note {
        margin: 12px 0 0;
        font-size: 13px;
        line-height: 1.45;
        color: #8a95b0;
      }
      @media (max-width: 640px) {
        .card {
          padding: 22px 20px 24px;
          border-radius: 26px;
        }
      }
    </style>
  </head>
  <body>
    <main class="card">
      <p class="eyebrow">${accentLabel}</p>
      <h1>${title}</h1>
      <h2 class="next-title">${helperText}</h2>
      <p class="next-copy">${bodyText}</p>
      ${isSuccess && safeReturnUrl ? '<p class="redirect-note">You will be redirected back in a moment.</p>' : ""}
    </main>
    ${redirectScript}
  </body>
</html>`;
}

async function handleGoogleStart(req, res, parsedUrl) {
  const deviceToken = getDeviceToken(req, parsedUrl, null);
  const returnUrl = sanitizeReturnUrl(parsedUrl.searchParams.get("return_url") || "");

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
    const trialSync = claimOrSyncAccountTrial(state, account, pending.deviceToken);
    delete state.googleStates[oauthState];
    writeState(state);

    const trialMessage = trialSync.reducedByAccount
      ? " This Google account already used part of the free trial, so your remaining free dictations were updated."
      : "";

    const completeUrl = new URL(getPublicUrl("/reg-complete"));
    completeUrl.searchParams.set("message", `Signed in as ${account.email}.${trialMessage}`);
    if (pending.returnUrl) {
      completeUrl.searchParams.set("return_url", pending.returnUrl);
    }
    redirect(res, completeUrl.toString());
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

function handleRegistrationComplete(res, parsedUrl) {
  const returnUrl = sanitizeReturnUrl(parsedUrl.searchParams.get("return_url") || "");
  const message = parsedUrl.searchParams.get("message") || "Signed in successfully.";
  sendHtml(
    res,
    200,
    renderAuthCompletePage("Login is successful", message, returnUrl, {
      name: "login",
      params: {
        method: "Google",
        destination: "speech_to_text_google_docs_extension",
      },
    })
  );
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
  const account = getAccountForDevice(state, deviceToken);
  if (account) {
    claimOrSyncAccountTrial(state, account, deviceToken);
    syncDeviceUsageToAccountTrial(state, deviceToken, account);
  }
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
  const returnUrl = sanitizeReturnUrl(body.returnUrl || body.return_url || "");
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
        productSlug: PRODUCT_SLUG,
      },
      allow_promotion_codes: true,
      subscription_data: {
        metadata: {
          accountId: account.id,
          email: account.email,
          deviceToken,
          planId: selectedPlan.id,
          productSlug: PRODUCT_SLUG,
        },
      },
    });

    state.sessionToAccount[session.id] = account.id;
    state.sessionToReturnUrl[session.id] = returnUrl || "";
    rememberAccountCustomer(state, account.id, customerId);
    writeState(state);

    sendJson(res, 200, { url: session.url, sessionId: session.id });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Failed to create checkout session." });
  }
}

function formatPeriodEndLabel(value) {
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

function renderPortalReturnPage({ title, message, ctaLabel = "Back to Google Docs", returnUrl = "" }) {
  const safeReturn = sanitizeExtensionReturnUrl(returnUrl) || "https://docs.google.com/document/";
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: Manrope, "Avenir Next", "Segoe UI", "Helvetica Neue", Arial, sans-serif;
        min-height: 100vh;
        padding: 28px 18px;
        background:
          radial-gradient(circle at top, rgba(95, 132, 255, 0.18), transparent 30%),
          radial-gradient(circle at top left, rgba(53, 95, 216, 0.1), transparent 28%),
          linear-gradient(180deg, #fbfcff 0%, #f5f7ff 100%);
        color: #191c24;
      }
      .card {
        max-width: 760px;
        margin: 0 auto;
        background: rgba(255, 255, 255, 0.94);
        border: 1px solid #dfe6f4;
        border-radius: 28px;
        padding: 28px;
        box-shadow: 0 18px 42px rgba(27, 27, 27, 0.06);
      }
      .eyebrow {
        margin: 0 0 10px;
        font-size: 12px;
        font-weight: 650;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: #5f84ff;
      }
      h1 {
        margin: 0 0 12px;
        font-size: clamp(32px, 6vw, 52px);
        line-height: 1;
        letter-spacing: -0.025em;
        font-weight: 620;
        color: #232835;
      }
      p {
        margin: 0 0 20px;
        font-size: 18px;
        line-height: 1.45;
        color: #3d4558;
      }
      .cta {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 54px;
        padding: 0 22px;
        border-radius: 999px;
        text-decoration: none;
        background: linear-gradient(180deg, #5f84ff 0%, #365fd8 100%);
        color: #f7f9ff;
        font-size: 16px;
        font-weight: 700;
      }
    </style>
  </head>
  <body>
    <section class="card">
      <p class="eyebrow">Subscription updated</p>
      <h1>${title}</h1>
      <p>${message}</p>
      <a class="cta" href="${safeReturn}">${ctaLabel}</a>
    </section>
  </body>
</html>`;
}

async function handleCreateBillingPortalSession(req, res, parsedUrl) {
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
  const returnUrl = sanitizeExtensionReturnUrl(body.returnUrl || body.return_url || "");
  if (!deviceToken) {
    sendJson(res, 400, { error: "device_token is required." });
    return;
  }

  const state = readState();
  const account = getAccountForDevice(state, deviceToken);
  if (!account) {
    sendJson(res, 401, { error: "Sign in is required before managing a subscription." });
    return;
  }

  const customerId = state.accountToCustomer[account.id];
  if (!customerId) {
    sendJson(res, 404, { error: "No Stripe customer found for this account." });
    return;
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl || getPublicUrl("/paywall/cancel"),
    });
    sendJson(res, 200, { ok: true, url: session.url });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Unable to create billing portal session." });
  }
}

async function handleBillingPortalStart(req, res, parsedUrl) {
  if (!ensureStripeConfigured(res)) {
    return;
  }

  const deviceToken = getDeviceToken(req, parsedUrl, null);
  const requestedReturnUrl = sanitizeExtensionReturnUrl(parsedUrl.searchParams.get("return_url") || "");
  const returnUrl =
    requestedReturnUrl ||
    `${getPublicUrl("/portal/return")}?device_token=${encodeURIComponent(deviceToken)}`;
  if (!deviceToken) {
    sendJson(res, 400, { error: "device_token is required." });
    return;
  }

  const state = readState();
  const account = getAccountForDevice(state, deviceToken);
  if (!account) {
    sendHtml(
      res,
      200,
      renderPortalReturnPage({
        title: "Sign-in required",
        message: "Please sign in to the account with an active subscription before opening billing settings.",
        returnUrl,
      })
    );
    return;
  }

  const customerId = state.accountToCustomer[account.id];
  if (!customerId) {
    sendHtml(
      res,
      200,
      renderPortalReturnPage({
        title: "No active subscription found",
        message: "This account does not have an active paid plan to manage in Stripe.",
        returnUrl,
      })
    );
    return;
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
    redirect(res, session.url);
  } catch (error) {
    sendHtml(
      res,
      500,
      renderAuthCompletePage(
        "Billing unavailable",
        error.message || "Unable to open subscription settings.",
        returnUrl
      )
    );
  }
}

async function handlePortalReturn(req, res, parsedUrl) {
  const deviceToken = getDeviceToken(req, parsedUrl, null);
  const state = readState();
  const account = getAccountForDevice(state, deviceToken);
  const subscription = await resolveSubscriptionStatusForAccount(state, account);
  const returnUrl = "https://docs.google.com/document/";
  const periodEndLabel = formatPeriodEndLabel(subscription.plan?.currentPeriodEnd);

  if (!account) {
    sendHtml(
      res,
      200,
      renderPortalReturnPage({
        title: "Subscription settings updated",
        message: "Return to the extension to refresh your current access status.",
        returnUrl,
      })
    );
    return;
  }

  if (subscription.active && subscription.plan?.cancelAtPeriodEnd) {
    sendHtml(
      res,
      200,
      renderPortalReturnPage({
        title: "Subscription canceled",
        message: periodEndLabel
          ? `Your access stays active until ${periodEndLabel}. After that, your plan will not renew.`
          : "Your plan will stay active until the end of the current billing period and will not renew.",
        returnUrl,
      })
    );
    return;
  }

  if (subscription.active) {
    sendHtml(
      res,
      200,
      renderPortalReturnPage({
        title: "Subscription active",
        message: periodEndLabel
          ? `Your current plan renews on ${periodEndLabel}.`
          : "Your current plan is active on this account.",
        returnUrl,
      })
    );
    return;
  }

  sendHtml(
    res,
    200,
    renderPortalReturnPage({
      title: "No active subscription",
      message: "This account does not have an active paid plan right now.",
      returnUrl,
    })
  );
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
      sessionsLeft: FREE_TRIAL_SESSIONS,
      freeTrialSessions: FREE_TRIAL_SESSIONS,
    });
    return;
  }

  try {
    const state = readState();
    const account = getAccountForDevice(state, deviceToken);
    const status = await lookupSubscriptionStatusForAccount(state, account);
    if (!status.active) {
      getFreeTrialRemainingSeconds(state, account, deviceToken);
    }
    writeState(state);
    sendJson(res, 200, {
      deviceToken,
      ...status,
      sessionsLeft: status.active ? null : FREE_TRIAL_SESSIONS,
      freeTrialSessions: FREE_TRIAL_SESSIONS,
      paid: status.active,
      subscriptionStatus: status.status || "none",
    });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Failed to read subscription status." });
  }
}

async function handlePlans(_req, res) {
  try {
    const plans = await resolvePricingPlans();
    sendJson(res, 200, { plans });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Failed to load plans." });
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
      const belongsToThisProduct = await checkoutSessionBelongsToThisProduct(session);
      if (!belongsToThisProduct) {
        sendJson(res, 200, { received: true, ignored: true });
        return;
      }
      const accountId =
        session.client_reference_id ||
        session.metadata?.accountId ||
        state.sessionToAccount?.[session.id] ||
        "";
      const customerId = typeof session.customer === "string" ? session.customer : "";
      rememberAccountCustomer(state, accountId, customerId);
      if (!state.purchaseEventsSent?.[session.id]) {
        const purchaseParams = buildPurchaseAnalyticsParamsFromSession(
          session,
          getPlanById,
          "speech-to-text-google-docs-plan",
          "Speech to Text Google Docs plan"
        );
        await sendGa4Measurement({
          clientId: session.metadata?.deviceToken || customerId || session.id,
          userId: accountId || "",
          sessionId: session.id,
          eventName: "purchase",
          params: {
            product: "speech_to_text_google_docs",
            signed_in: Boolean(accountId),
            ...purchaseParams,
          },
        });
        console.log(
          `[analytics] purchase sent to GA4 product=speech_to_text_google_docs session_id=${session.id} account_id=${accountId || "none"}`
        );
        state.purchaseEventsSent[session.id] = nowIso();
      }
    }

    if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      const sub = event.data.object;
      if (!subscriptionBelongsToThisProduct(sub)) {
        sendJson(res, 200, { received: true, ignored: true });
        return;
      }
      const customerId = typeof sub.customer === "string" ? sub.customer : "";
      const accountId = sub.metadata?.accountId || state.customerToAccount?.[customerId] || "";
      rememberAccountCustomer(state, accountId, customerId);
    }

    writeState(state);
    sendJson(res, 200, { received: true });
  } catch (error) {
    if (event?.type === "checkout.session.completed") {
      const sessionId = event?.data?.object?.id || "unknown";
      console.error(
        `[analytics] purchase failed to send to GA4 product=speech_to_text_google_docs session_id=${sessionId}: ${error.message || error}`
      );
    }
    sendJson(res, 500, { error: error.message || "Webhook handler failed." });
  }
}

async function handleAnalyticsEvent(req, res, parsedUrl) {
  let body = {};
  try {
    body = await parseJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error.message || "Invalid request body." });
    return;
  }

  const deviceToken = getDeviceToken(req, parsedUrl, body);
  const eventName = sanitizeAnalyticsEventName(body.name || body.event || "");
  const sessionId = String(body.sessionId || body.session_id || Date.now());

  if (!deviceToken) {
    sendJson(res, 400, { error: "Missing device token." });
    return;
  }

  if (!eventName) {
    sendJson(res, 400, { error: "Missing event name." });
    return;
  }

  const state = readState();
  const account = getAccountForDevice(state, deviceToken);

  try {
    const result = await sendGa4Measurement({
      clientId: deviceToken,
      userId: account?.id || "",
      sessionId,
      eventName,
      params: {
        product: "speech_to_text_google_docs",
        signed_in: Boolean(account?.id),
        ...sanitizeAnalyticsParams(body.params),
      },
    });
    sendJson(res, 200, result);
  } catch (error) {
    sendJson(res, 502, { error: error.message || "Failed to send analytics event." });
  }
}

async function handleSuccessPage(res, parsedUrl) {
  const state = readState();
  const sessionId = parsedUrl.searchParams.get("session_id") || "";
  const mappedReturnUrl = sessionId ? state.sessionToReturnUrl?.[sessionId] || "" : "";
  const returnUrl =
    sanitizeReturnUrl(parsedUrl.searchParams.get("return_url") || "") ||
    sanitizeReturnUrl(mappedReturnUrl);
  sendHtml(
      res,
      200,
      renderAuthCompletePage(
      "Payment successful",
      "Unlimited dictation is active on this account. Return to the extension to keep working.",
      returnUrl,
      null
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

  if (req.method === "GET" && parsedUrl.pathname === "/plans") {
    await handlePlans(req, res, parsedUrl);
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

  if (req.method === "GET" && parsedUrl.pathname === "/reg-complete") {
    handleRegistrationComplete(res, parsedUrl);
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/auth/logout") {
    await handleAuthLogout(req, res, parsedUrl);
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/analytics/event") {
    await handleAnalyticsEvent(req, res, parsedUrl);
    return;
  }

  if (
    req.method === "POST" &&
    (parsedUrl.pathname === "/stripe/checkout-session" || parsedUrl.pathname === "/checkout")
  ) {
    await handleCreateCheckoutSession(req, res, parsedUrl);
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/billing/portal") {
    await handleCreateBillingPortalSession(req, res, parsedUrl);
    return;
  }

  if (req.method === "GET" && parsedUrl.pathname === "/billing/portal/start") {
    await handleBillingPortalStart(req, res, parsedUrl);
    return;
  }

  if (req.method === "GET" && parsedUrl.pathname === "/portal/start") {
    await handleBillingPortalStart(req, res, parsedUrl);
    return;
  }

  if (req.method === "GET" && parsedUrl.pathname === "/portal/return") {
    await handlePortalReturn(req, res, parsedUrl);
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
    await handleSuccessPage(res, parsedUrl);
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
    "Required env: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_MONTHLY_PRICE_ID, STRIPE_YEARLY_PRICE_ID, PUBLIC_BASE_URL"
  );
  console.log(
    "Optional auth env: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET"
  );
  console.log(
    "Optional quota env: FREE_TRIAL_SESSIONS, FREE_MINUTES, MONTHLY_MINUTES, ANNUAL_MINUTES"
  );
});
