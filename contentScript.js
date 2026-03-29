const HAS_RECORDING_SUPPORT = Boolean(
  navigator.mediaDevices?.getUserMedia && window.MediaRecorder
);
const RECORDER_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
];
const REMOTE_API_BASE_URL = "https://voicetext.world";
const DEVICE_TOKEN_KEY = "deviceToken";
const MAX_RECORDING_SECONDS = 120;

const state = {
  connected: true,
  supported: HAS_RECORDING_SUPPORT,
  isDocsPage: location.href.startsWith("https://docs.google.com/document/"),
  status: HAS_RECORDING_SUPPORT ? "idle" : "unsupported",
  message: HAS_RECORDING_SUPPORT
    ? "Place the cursor in Google Docs, record your voice, then paste the transcript into the document."
    : "This browser does not support microphone recording for this extension.",
  transcript: "",
  interimTranscript: "",
  docTitle: document.title.replace(/\s*-\s*Google Docs\s*$/, ""),
  language: "Auto",
  insertedChars: 0,
  sessionSeconds: 0,
  cursorReady: false,
};

const VOICE_COMMANDS = [
  { pattern: /\bnew paragraph\b/gi, value: "\n\n" },
  { pattern: /\b(new line|next line)\b/gi, value: "\n" },
  { pattern: /\b(comma)\b/gi, value: "," },
  { pattern: /\b(period|full stop)\b/gi, value: "." },
  { pattern: /\b(question mark)\b/gi, value: "?" },
  { pattern: /\b(exclamation mark|exclamation point)\b/gi, value: "!" },
  { pattern: /\b(colon)\b/gi, value: ":" },
  { pattern: /\b(semicolon)\b/gi, value: ";" },
  { pattern: /\b(open quote)\b/gi, value: '"' },
  { pattern: /\b(close quote)\b/gi, value: '"' },
  { pattern: /\b(apostrophe)\b/gi, value: "'" },
  { pattern: /\b(open parenthesis)\b/gi, value: "(" },
  { pattern: /\b(close parenthesis)\b/gi, value: ")" },
  { pattern: /\b(open bracket)\b/gi, value: "[" },
  { pattern: /\b(close bracket)\b/gi, value: "]" },
  { pattern: /\b(dash|hyphen)\b/gi, value: " - " },
];

const COMMAND_PATTERNS = {
  undo: /^(undo|go back)$/i,
  deleteLastSentence: /^(delete last sentence|remove last sentence)$/i,
};

let mediaStream = null;
let mediaRecorder = null;
let desiredRunning = false;
let sessionStartedAtMs = 0;
let quotaTimer = null;
let sessionSecondsTimer = null;
let lastErrorMessage = "";
let unloadCommitStarted = false;
let usageCommittedForSession = false;
let lastFocusedTarget = null;
let lastKnownSelectionRange = null;
let iframeListenersBound = false;
let transcriptionQueue = Promise.resolve();
let pendingInsertionText = "";
let sessionAudioChunks = [];
let recorderStopPromise = null;
let transcriptOverlay = null;
const insertionHistory = [];

function withTimeout(promise, timeoutMs, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]);
}

function sendStateUpdate() {
  chrome.runtime.sendMessage({
    type: "dictationStateUpdate",
    state: {
      ...state,
      docTitle: document.title.replace(/\s*-\s*Google Docs\s*$/, ""),
    },
  });
}

function setStatus(status, message = "") {
  state.status = status;
  state.message = message;
  sendStateUpdate();
}

function clearQuotaTimer() {
  if (quotaTimer) {
    clearTimeout(quotaTimer);
    quotaTimer = null;
  }
}

function clearSessionSecondsTimer() {
  if (sessionSecondsTimer) {
    clearInterval(sessionSecondsTimer);
    sessionSecondsTimer = null;
  }
}

function isTextInputTarget(target) {
  return (
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLInputElement && /^(text|search|url|email|tel)$/i.test(target.type))
  );
}

function isValidInsertionTarget(target) {
  if (!target) {
    return false;
  }

  if (isTextInputTarget(target)) {
    return true;
  }

  if (target instanceof HTMLElement && target.isContentEditable) {
    return true;
  }

  if (target.ownerDocument && target.ownerDocument !== document) {
    return true;
  }

  return false;
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

function getPreferredRecorderMimeType() {
  for (const candidate of RECORDER_MIME_CANDIDATES) {
    if (window.MediaRecorder?.isTypeSupported?.(candidate)) {
      return candidate;
    }
  }
  return "";
}

async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function releaseMicrophone() {
  if (!mediaStream) {
    return;
  }
  mediaStream.getTracks().forEach((track) => track.stop());
  mediaStream = null;
}

function getPendingInsertionText() {
  return pendingInsertionText.trim();
}

function enqueuePendingInsertion(text) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return;
  }
  pendingInsertionText = `${pendingInsertionText} ${normalized}`.trim();
}

function clearPendingInsertion() {
  pendingInsertionText = "";
  removeTranscriptOverlay();
}

function resetSessionAudio() {
  sessionAudioChunks = [];
}

function buildSessionAudioBlob() {
  if (!sessionAudioChunks.length) {
    return null;
  }
  const mimeType = sessionAudioChunks[0]?.type || "audio/webm";
  return new Blob(sessionAudioChunks, { type: mimeType });
}

function rememberFocusedTarget(target) {
  if (!target || !isValidInsertionTarget(target)) {
    return;
  }

  lastFocusedTarget = target;
  captureSelection(target);
  state.cursorReady = true;
  sendStateUpdate();
}

function captureSelection(target) {
  const ownerDocument = target?.ownerDocument || document;
  const ownerWindow = ownerDocument.defaultView || window;
  const selection = ownerWindow.getSelection ? ownerWindow.getSelection() : null;
  if (!selection || !selection.rangeCount) {
    return false;
  }

  try {
    lastKnownSelectionRange = selection.getRangeAt(0).cloneRange();
    return true;
  } catch (_error) {
    return false;
  }
}

function restoreSelection(target) {
  if (!lastKnownSelectionRange) {
    return null;
  }

  const ownerDocument =
    lastKnownSelectionRange.startContainer?.ownerDocument || target?.ownerDocument || document;
  const ownerWindow = ownerDocument.defaultView || window;
  const selection = ownerWindow.getSelection ? ownerWindow.getSelection() : null;
  if (!selection) {
    return null;
  }

  try {
    selection.removeAllRanges();
    selection.addRange(lastKnownSelectionRange.cloneRange());
    return selection;
  } catch (_error) {
    return null;
  }
}

function getIframeBody() {
  const iframe = document.querySelector(".docs-texteventtarget-iframe");
  return iframe?.contentDocument?.body || null;
}

function bindIframeListeners() {
  const iframe = document.querySelector(".docs-texteventtarget-iframe");
  const iframeDocument = iframe?.contentDocument || null;
  if (!iframeDocument || iframeListenersBound) {
    return;
  }

  const markReady = () => {
    const target = iframeDocument.activeElement || iframeDocument.body;
    rememberFocusedTarget(target);
    void flushPendingInsertion();
  };

  iframeDocument.addEventListener("focusin", markReady, true);
  iframeDocument.addEventListener("mouseup", markReady, true);
  iframeDocument.addEventListener("keyup", markReady, true);
  iframeListenersBound = true;
}

function dispatchSyntheticInput(target, text = "") {
  const ownerWindow = target?.ownerDocument?.defaultView || window;
  try {
    target?.dispatchEvent(
      new ownerWindow.InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        data: text,
        inputType: "insertText",
      })
    );
  } catch (_error) {
    // Older editors may not support InputEvent construction.
  }

  target?.dispatchEvent(new Event("input", { bubbles: true }));
}

function dispatchEditorTextInsertion(target, text) {
  const ownerDocument = target?.ownerDocument || document;
  const ownerWindow = ownerDocument.defaultView || window;
  const eventTarget = target instanceof HTMLElement ? target : ownerDocument.body;

  try {
    eventTarget.dispatchEvent(
      new ownerWindow.InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        data: text,
        inputType: "insertText",
      })
    );
  } catch (_error) {
    // Ignore unsupported constructor environments.
  }

  try {
    const textInputEvent = ownerDocument.createEvent("TextEvent");
    textInputEvent.initTextEvent("textInput", true, true, ownerWindow, text);
    eventTarget.dispatchEvent(textInputEvent);
  } catch (_error) {
    // Ignore unsupported TextEvent environments.
  }

  try {
    eventTarget.dispatchEvent(
      new ownerWindow.InputEvent("input", {
        bubbles: true,
        data: text,
        inputType: "insertText",
      })
    );
  } catch (_error) {
    eventTarget.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

function dispatchEditorPaste(target, text) {
  const ownerDocument = target?.ownerDocument || document;
  const ownerWindow = ownerDocument.defaultView || window;
  const eventTarget = target instanceof HTMLElement ? target : ownerDocument.body;

  try {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/plain", text);
    const pasteEvent = new ownerWindow.ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: dataTransfer,
    });
    eventTarget.dispatchEvent(pasteEvent);
    return true;
  } catch (_error) {
    return false;
  }
}

function dispatchEditorTyping(target, text) {
  const ownerDocument = target?.ownerDocument || document;
  const ownerWindow = ownerDocument.defaultView || window;
  const eventTarget = target instanceof HTMLElement ? target : ownerDocument.body;

  for (const char of text) {
    const key =
      char === "\n" ? "Enter" : char === " " ? " " : char;
    const code =
      char === "\n"
        ? "Enter"
        : /^[a-z]$/i.test(char)
        ? `Key${char.toUpperCase()}`
        : "Unidentified";

    try {
      eventTarget.dispatchEvent(
        new ownerWindow.KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key,
          code,
        })
      );
    } catch (_error) {
      // No-op.
    }

    dispatchEditorTextInsertion(eventTarget, char);

    try {
      eventTarget.dispatchEvent(
        new ownerWindow.KeyboardEvent("keyup", {
          bubbles: true,
          cancelable: true,
          key,
          code,
        })
      );
    } catch (_error) {
      // No-op.
    }
  }
}

async function copyTextToClipboard(text) {
  const normalized = String(text || "");
  if (!normalized.trim()) {
    return false;
  }

  try {
    await navigator.clipboard.writeText(normalized);
    return true;
  } catch (_error) {
    return false;
  }
}

function removeTranscriptOverlay() {
  if (transcriptOverlay?.isConnected) {
    transcriptOverlay.remove();
  }
  transcriptOverlay = null;
}

function ensureTranscriptOverlay() {
  if (transcriptOverlay?.isConnected) {
    return transcriptOverlay;
  }

  const overlay = document.createElement("div");
  overlay.style.position = "fixed";
  overlay.style.right = "16px";
  overlay.style.bottom = "16px";
  overlay.style.zIndex = "2147483647";
  overlay.style.width = "320px";
  overlay.style.maxWidth = "calc(100vw - 32px)";
  overlay.style.padding = "14px";
  overlay.style.borderRadius = "16px";
  overlay.style.background = "#fffdf8";
  overlay.style.border = "1px solid rgba(24, 20, 13, 0.12)";
  overlay.style.boxShadow = "0 18px 40px rgba(24, 20, 13, 0.18)";
  overlay.style.fontFamily = "Arial, sans-serif";
  overlay.style.color = "#1f1b16";

  const title = document.createElement("div");
  title.textContent = "Dictation text is ready";
  title.style.fontSize = "14px";
  title.style.fontWeight = "700";
  title.style.marginBottom = "8px";

  const body = document.createElement("div");
  body.style.fontSize = "13px";
  body.style.lineHeight = "1.45";
  body.style.whiteSpace = "pre-wrap";
  body.style.maxHeight = "180px";
  body.style.overflowY = "auto";
  body.style.marginBottom = "10px";
  body.dataset.role = "transcript-body";

  const actions = document.createElement("div");
  actions.style.display = "flex";
  actions.style.gap = "8px";

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.textContent = "Copy text";
  copyBtn.style.flex = "1";
  copyBtn.style.border = "0";
  copyBtn.style.borderRadius = "10px";
  copyBtn.style.background = "#1f1b16";
  copyBtn.style.color = "#fff";
  copyBtn.style.padding = "10px 12px";
  copyBtn.style.cursor = "pointer";
  copyBtn.addEventListener("click", async () => {
    const text = body.textContent || "";
    const copied = await copyTextToClipboard(text);
    copyBtn.textContent = copied ? "Copied" : "Copy failed";
  });

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.textContent = "Close";
  closeBtn.style.border = "1px solid rgba(24, 20, 13, 0.12)";
  closeBtn.style.borderRadius = "10px";
  closeBtn.style.background = "#fff";
  closeBtn.style.color = "#1f1b16";
  closeBtn.style.padding = "10px 12px";
  closeBtn.style.cursor = "pointer";
  closeBtn.addEventListener("click", () => {
    removeTranscriptOverlay();
  });

  actions.append(copyBtn, closeBtn);
  overlay.append(title, body, actions);
  document.documentElement.appendChild(overlay);
  transcriptOverlay = overlay;
  return overlay;
}

function showTranscriptOverlay(text) {
  const overlay = ensureTranscriptOverlay();
  const body = overlay.querySelector('[data-role="transcript-body"]');
  if (body) {
    body.textContent = text;
  }
}

function markSessionStart() {
  sessionStartedAtMs = Date.now();
  usageCommittedForSession = false;
  unloadCommitStarted = false;
  recorderStopPromise = null;
  clearSessionSecondsTimer();
  sessionSecondsTimer = setInterval(() => {
    if (!sessionStartedAtMs) {
      return;
    }
    state.sessionSeconds = Math.max(0, Math.floor((Date.now() - sessionStartedAtMs) / 1000));
    sendStateUpdate();
  }, 1000);
}

async function commitUsage() {
  if (!sessionStartedAtMs || usageCommittedForSession) {
    return null;
  }

  const elapsedSeconds = Math.max(0, Math.ceil((Date.now() - sessionStartedAtMs) / 1000));
  if (!elapsedSeconds) {
    sessionStartedAtMs = 0;
    state.sessionSeconds = 0;
    clearSessionSecondsTimer();
    return null;
  }

  try {
    const result = await sendRuntimeMessage({ type: "addDictationUsage", seconds: elapsedSeconds });
    usageCommittedForSession = true;
    sessionStartedAtMs = 0;
    state.sessionSeconds = 0;
    clearSessionSecondsTimer();
    return result;
  } catch (error) {
    throw error;
  }
}

function focusGoogleDocsSurface() {
  bindIframeListeners();

  if (lastFocusedTarget?.isConnected) {
    if (lastFocusedTarget instanceof HTMLElement) {
      lastFocusedTarget.focus();
    }
    return lastFocusedTarget;
  }

  const iframeBody = getIframeBody();
  if (iframeBody) {
    iframeBody.focus();
    return iframeBody;
  }

  const active = document.activeElement;
  if (active instanceof HTMLElement && isValidInsertionTarget(active)) {
    active.focus();
  }

  const editable = document.querySelector('[contenteditable="true"]');
  if (editable instanceof HTMLElement) {
    editable.focus();
    return editable;
  }

  return active instanceof HTMLElement && isValidInsertionTarget(active) ? active : null;
}

function ensureCollapsedSelection(target) {
  const ownerDocument = target.ownerDocument || document;
  const ownerWindow = ownerDocument.defaultView || window;
  const selection =
    restoreSelection(target) || (ownerWindow.getSelection ? ownerWindow.getSelection() : null);
  if (!selection) {
    return null;
  }

  if (selection.rangeCount > 0) {
    return selection;
  }

  const range = ownerDocument.createRange();
  if (target.nodeType === Node.TEXT_NODE) {
    range.setStart(target, target.textContent?.length || 0);
  } else {
    range.selectNodeContents(target);
    range.collapse(false);
  }
  selection.removeAllRanges();
  selection.addRange(range);
  captureSelection(target);
  return selection;
}

function normalizeTranscriptChunk(text) {
  if (!text) {
    return "";
  }

  let normalized = text.replace(/\s+/g, " ").trim();
  VOICE_COMMANDS.forEach(({ pattern, value }) => {
    normalized = normalized.replace(pattern, value);
  });

  normalized = normalized
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([(\[{])\s+/g, "$1")
    .replace(/\s+([)\]}])/g, "$1")
    .replace(/"\s+/g, '" ')
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ");

  const previous = state.transcript.trim();
  const shouldCapitalize = !previous || /[.!?\n]\s*$/.test(previous);
  if (shouldCapitalize && /^[a-z]/.test(normalized)) {
    normalized = normalized[0].toUpperCase() + normalized.slice(1);
  }

  return normalized;
}

async function transcribeAudioChunk(blob) {
  if (!blob?.size) {
    return "";
  }

  const deviceToken = await getOrCreateDeviceToken();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 50000);

  try {
    const response = await fetch(`${REMOTE_API_BASE_URL}/transcribe-raw`, {
      method: "POST",
      headers: {
        "x-device-token": deviceToken,
        "x-audio-mime": blob.type || "audio/webm",
      },
      body: blob,
      signal: controller.signal,
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.error || `Transcription failed with ${response.status}`);
    }

    return typeof payload.text === "string" ? payload.text.trim() : "";
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("Transcription timed out. Please try a shorter recording.");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function isVoiceCommand(text, pattern) {
  return Boolean(text && pattern.test(text.trim()));
}

function dispatchUndoShortcut(target) {
  const eventTarget = target instanceof HTMLElement ? target : document.activeElement || document.body;
  const isMac = /Mac/i.test(navigator.platform);
  const shortcut = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: "z",
    code: "KeyZ",
    ctrlKey: !isMac,
    metaKey: isMac,
  });
  eventTarget.dispatchEvent(shortcut);
}

function trimTranscriptByChunk(chunk) {
  if (!chunk) {
    return;
  }
  if (state.transcript.endsWith(chunk)) {
    state.transcript = state.transcript.slice(0, -chunk.length).trimEnd();
    return;
  }
  state.transcript = state.transcript.replace(new RegExp(`${chunk.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), "").trimEnd();
}

function undoLastInsertion() {
  const lastInserted = insertionHistory.pop();
  if (!lastInserted) {
    setStatus("error", "Nothing to undo yet.");
    return false;
  }

  const target = focusGoogleDocsSurface();
  if (target && typeof document.execCommand === "function") {
    try {
      if (document.execCommand("undo")) {
        trimTranscriptByChunk(lastInserted);
        state.insertedChars = Math.max(0, state.insertedChars - lastInserted.length);
        state.interimTranscript = "";
        setStatus("idle", "Undid the last dictated text.");
        return true;
      }
    } catch (_error) {
      // Fall through to shortcut dispatch.
    }
  }

  dispatchUndoShortcut(target);
  trimTranscriptByChunk(lastInserted);
  state.insertedChars = Math.max(0, state.insertedChars - lastInserted.length);
  state.interimTranscript = "";
  setStatus("idle", "Requested undo for the last dictated text.");
  return true;
}

function insertTextWithSelection(target, text) {
  if (!target || !text || !isValidInsertionTarget(target)) {
    return false;
  }

  const ownerDocument = target.ownerDocument || document;
  const ownerWindow = ownerDocument.defaultView || window;

  if (isTextInputTarget(target)) {
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? target.value.length;
    target.focus();
    target.setRangeText(text, start, end, "end");
    dispatchSyntheticInput(target, text);
    return true;
  }

  target.focus();

  if (typeof ownerDocument.execCommand === "function") {
    try {
      if (ownerDocument.execCommand("insertText", false, text)) {
        captureSelection(target);
        dispatchSyntheticInput(target, text);
        return true;
      }
    } catch (_error) {
      // Fall through to manual range insertion.
    }
  }

  const selection = ensureCollapsedSelection(target) || (ownerWindow.getSelection ? ownerWindow.getSelection() : null);
  if (!selection || !selection.rangeCount) {
    return false;
  }

  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = ownerDocument.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  captureSelection(node);
  dispatchSyntheticInput(target, text);
  return true;
}

function insertTextIntoDocument(text) {
  if (!text) {
    return false;
  }

  const normalizedTranscript = normalizeTranscriptChunk(text);
  if (!normalizedTranscript) {
    return false;
  }

  const appendTrailingSpace = !/[\n,.;:!?"]$/.test(normalizedTranscript);
  const normalized = appendTrailingSpace ? `${normalizedTranscript} ` : normalizedTranscript;

  const activeElement = document.activeElement;
  if (activeElement && insertTextWithSelection(activeElement, normalized)) {
    rememberFocusedTarget(activeElement);
    return true;
  }

  const docsSurface = focusGoogleDocsSurface();
  if (docsSurface && insertTextWithSelection(docsSurface, normalized)) {
    rememberFocusedTarget(docsSurface);
    return true;
  }

  state.cursorReady = false;
  return false;
}

async function insertTextIntoGoogleDocs(text) {
  if (!text) {
    return false;
  }

  const normalizedTranscript = normalizeTranscriptChunk(text);
  if (!normalizedTranscript) {
    return false;
  }

  const appendTrailingSpace = !/[\n,.;:!?"]$/.test(normalizedTranscript);
  const normalized = appendTrailingSpace ? `${normalizedTranscript} ` : normalizedTranscript;

  try {
    const response = await sendRuntimeMessage({
      type: "nativeTypeText",
      text: normalized,
    });
    if (response?.inserted) {
      return true;
    }
  } catch (_error) {
    // Fall back to content-script insertion below.
  }

  return insertTextIntoDocument(normalizedTranscript);
}

async function flushPendingInsertion() {
  const pending = getPendingInsertionText();
  if (!pending) {
    return false;
  }

  const inserted = await insertTextIntoGoogleDocs(pending);
  if (!inserted) {
    showTranscriptOverlay(pending);
    setStatus("idle", "Transcript ready. Copy it from the page card and paste it into Google Docs.");
    sendStateUpdate();
    return false;
  }

  clearPendingInsertion();
  state.transcript = `${state.transcript} ${pending}`.trim();
  state.insertedChars += pending.length;
  state.interimTranscript = "";
  insertionHistory.push(pending);
  setStatus(
    desiredRunning && mediaRecorder ? "listening" : "idle",
    desiredRunning && mediaRecorder
      ? "Listening and transcribing with OpenAI..."
      : "Pending text inserted."
  );
  return true;
}

async function handleTranscriptionText(text) {
  const normalizedTranscript = normalizeTranscriptChunk(text);
  if (!normalizedTranscript) {
    setStatus("idle", "No speech detected. Try again.");
    return;
  }

  if (isVoiceCommand(normalizedTranscript, COMMAND_PATTERNS.undo)) {
    undoLastInsertion();
    return;
  }
  if (isVoiceCommand(normalizedTranscript, COMMAND_PATTERNS.deleteLastSentence)) {
    undoLastInsertion();
    return;
  }

  const inserted = await insertTextIntoGoogleDocs(normalizedTranscript);
  if (!inserted) {
    enqueuePendingInsertion(normalizedTranscript);
    showTranscriptOverlay(normalizedTranscript);
    setStatus(
      desiredRunning && mediaRecorder ? "listening" : "idle",
      "Transcript ready. Copy it from the page card and paste it into Google Docs."
    );
    return;
  }

  state.transcript = `${state.transcript} ${normalizedTranscript}`.trim();
  state.insertedChars += normalizedTranscript.length;
  state.interimTranscript = "";
  insertionHistory.push(normalizedTranscript);
  setStatus("idle", "Text inserted into Google Docs.");
  sendStateUpdate();
}

function queueTranscription(blob) {
  if (!blob?.size) {
    return transcriptionQueue;
  }

  state.interimTranscript = "Transcribing...";
  sendStateUpdate();

  transcriptionQueue = transcriptionQueue
    .then(async () => {
      const text = await transcribeAudioChunk(blob);
      if (text) {
        await handleTranscriptionText(text);
      } else {
        state.interimTranscript = "";
        sendStateUpdate();
      }
    })
    .catch((error) => {
      lastErrorMessage = error.message || "OpenAI transcription failed.";
      state.interimTranscript = "";
      setStatus(
        desiredRunning && mediaRecorder ? "listening" : "error",
        desiredRunning && mediaRecorder
          ? `Transcription issue: ${lastErrorMessage}`
          : lastErrorMessage
      );
      sendStateUpdate();
    });

  return transcriptionQueue;
}

async function startDictation() {
  if (!HAS_RECORDING_SUPPORT) {
    setStatus("unsupported", "Microphone recording is not available in this browser.");
    return;
  }

  const target = focusGoogleDocsSurface();
  if (!target) {
    setStatus("error", "Click inside a Google Docs document first.");
    return;
  }

  if (state.status === "listening" || state.status === "starting" || mediaRecorder) {
    return;
  }
  state.language = "Auto";
  desiredRunning = true;
  state.interimTranscript = "";
  clearQuotaTimer();

  const quota = await sendRuntimeMessage({ type: "getDictationQuota" }).catch((error) => {
    desiredRunning = false;
    clearSessionSecondsTimer();
    sessionStartedAtMs = 0;
    setStatus("error", error.message || "Unable to read quota.");
    return null;
  });

  if (!quota) {
    return;
  }

  if (Number(quota.remainingSeconds) <= 0) {
    desiredRunning = false;
    clearSessionSecondsTimer();
    sessionStartedAtMs = 0;
    setStatus("error", "Free trial used. Upgrade to continue dictation.");
    return;
  }

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (error) {
    desiredRunning = false;
    setStatus("error", "Allow microphone access in Chrome to use AI dictation.");
    return;
  }

  const mimeType = getPreferredRecorderMimeType();
  try {
    mediaRecorder = mimeType
      ? new MediaRecorder(mediaStream, { mimeType })
      : new MediaRecorder(mediaStream);
  } catch (error) {
    desiredRunning = false;
    releaseMicrophone();
    setStatus("error", error.message || "Unable to start microphone recording.");
    return;
  }

  mediaRecorder.onerror = (event) => {
    desiredRunning = false;
    lastErrorMessage = event?.error?.message || "Microphone recording failed.";
    setStatus("error", lastErrorMessage);
  };

  mediaRecorder.onstop = async () => {
    releaseMicrophone();
    const audioBlob = buildSessionAudioBlob();
    resetSessionAudio();
    mediaRecorder = null;
    if (!audioBlob?.size) {
      recorderStopPromise = null;
      return;
    }

    state.interimTranscript = "Transcribing...";
    sendStateUpdate();
    await queueTranscription(audioBlob).catch(() => null);
    recorderStopPromise = null;
  };

  markSessionStart();
  const recordingSecondsLimit = Math.min(Number(quota.remainingSeconds), MAX_RECORDING_SECONDS);

  quotaTimer = setTimeout(async () => {
    desiredRunning = false;
    try {
      if (mediaRecorder && mediaRecorder.state !== "inactive") {
        recorderStopPromise =
          recorderStopPromise ||
          new Promise((resolve) => {
            const previousOnStop = mediaRecorder.onstop;
            mediaRecorder.onstop = async (...args) => {
              try {
                if (typeof previousOnStop === "function") {
                  await previousOnStop.apply(mediaRecorder, args);
                }
              } finally {
                resolve();
              }
            };
          });
        mediaRecorder.stop();
      }
    } catch (_error) {
      // No-op.
    }
    if (recorderStopPromise) {
      await withTimeout(
        recorderStopPromise.catch(() => null),
        10000,
        "Stopping the microphone took too long. Please try again."
      ).catch((error) => {
        setStatus("error", error.message || "Unable to stop dictation.");
      });
    }
    await withTimeout(
      transcriptionQueue.catch(() => null),
      60000,
      "Transcription took too long. Please try a shorter recording."
    ).catch((error) => {
      setStatus("error", error.message || "Unable to finish transcription.");
    });
    await commitUsage().catch(() => null);
    setStatus("error", "2-minute recording limit reached. Transcribe and start a new recording.");
  }, recordingSecondsLimit * 1000);

  setStatus("starting", "Starting AI dictation...");
  try {
    mediaRecorder.start();
    resetSessionAudio();
    mediaRecorder.ondataavailable = (event) => {
      if (!event.data?.size) {
        return;
      }
      sessionAudioChunks.push(event.data);
    };
    setStatus("listening", "Recording your voice. Each recording can be up to 2 minutes.");
  } catch (error) {
    desiredRunning = false;
    clearQuotaTimer();
    clearSessionSecondsTimer();
    sessionStartedAtMs = 0;
    releaseMicrophone();
    mediaRecorder = null;
    setStatus("error", error.message || "Unable to start AI dictation.");
  }
}

async function stopDictation() {
  desiredRunning = false;
  clearQuotaTimer();
  state.interimTranscript = "";
  setStatus("starting", "Transcribing your recording...");
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    recorderStopPromise =
      recorderStopPromise ||
      new Promise((resolve) => {
        const previousOnStop = mediaRecorder.onstop;
        mediaRecorder.onstop = async (...args) => {
          try {
            if (typeof previousOnStop === "function") {
              await previousOnStop.apply(mediaRecorder, args);
            }
          } finally {
            resolve();
          }
        };
      });
    try {
      mediaRecorder.stop();
    } catch (_error) {
      // No-op.
    }
  }

  if (recorderStopPromise) {
    await withTimeout(
      recorderStopPromise.catch(() => null),
      10000,
      "Stopping the microphone took too long. Please try again."
    ).catch((error) => {
      setStatus("error", error.message || "Unable to stop dictation.");
    });
  }
  await withTimeout(
    transcriptionQueue.catch(() => null),
    60000,
    "Transcription took too long. Please try a shorter recording."
  ).catch((error) => {
    setStatus("error", error.message || "Unable to finish transcription.");
  });
  try {
    await commitUsage();
  } catch (_error) {
    // Keep the UX stable if the usage endpoint is unavailable.
  }
}

async function flushUsageOnUnload() {
  if (unloadCommitStarted || !sessionStartedAtMs) {
    return;
  }

  unloadCommitStarted = true;
  desiredRunning = false;
  clearQuotaTimer();
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    try {
      mediaRecorder.stop();
    } catch (_error) {
      // No-op.
    }
  }

  if (recorderStopPromise) {
    await withTimeout(
      recorderStopPromise.catch(() => null),
      10000,
      "Stopping the microphone took too long. Please try again."
    ).catch(() => null);
  }
  await withTimeout(
    transcriptionQueue.catch(() => null),
    60000,
    "Transcription took too long. Please try a shorter recording."
  ).catch(() => null);
  try {
    await commitUsage();
  } catch (_error) {
    // Ignore unload-time failures.
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message?.type) {
    return false;
  }

  if (message.type === "getDictationState") {
    sendResponse({ ok: true, state });
    return false;
  }

  if (message.type === "startDictation") {
    startDictation()
      .then(() => sendResponse({ ok: true, state }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Unable to start dictation." }));
    return true;
  }

  if (message.type === "stopDictation") {
    sendResponse({ ok: true, state });
    stopDictation().catch((error) => {
      lastErrorMessage = error.message || "Unable to stop dictation.";
      setStatus("error", lastErrorMessage);
    });
    return true;
  }

  return false;
});

document.addEventListener(
  "focusin",
  (event) => {
    rememberFocusedTarget(event.target);
    void flushPendingInsertion();
  },
  true
);

document.addEventListener(
  "mouseup",
  (event) => {
    rememberFocusedTarget(event.target);
    bindIframeListeners();
    void flushPendingInsertion();
  },
  true
);

setInterval(() => {
  bindIframeListeners();
  const iframeBody = getIframeBody();
  if (!state.cursorReady && iframeBody) {
    const iframeSelection = iframeBody.ownerDocument?.defaultView?.getSelection?.();
    if (iframeSelection?.rangeCount) {
      rememberFocusedTarget(iframeBody);
    }
  }
}, 1500);

window.addEventListener("pagehide", () => {
  void flushUsageOnUnload();
});

window.addEventListener("beforeunload", () => {
  void flushUsageOnUnload();
});

sendStateUpdate();
