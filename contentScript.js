const HAS_RECORDING_SUPPORT = Boolean(
  navigator.mediaDevices?.getUserMedia && window.MediaRecorder
);
const RECORDER_TIMESLICE_MS = 4000;
const RECORDER_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
];

const state = {
  connected: true,
  supported: HAS_RECORDING_SUPPORT,
  isDocsPage: location.href.startsWith("https://docs.google.com/document/"),
  status: HAS_RECORDING_SUPPORT ? "idle" : "unsupported",
  message: HAS_RECORDING_SUPPORT
    ? "Place the cursor in Google Docs, then start AI dictation."
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
let lastFocusedTarget = null;
let iframeListenersBound = false;
let transcriptionQueue = Promise.resolve();
const insertionHistory = [];

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

function rememberFocusedTarget(target) {
  if (!target) {
    return;
  }

  lastFocusedTarget = target;
  state.cursorReady = true;
  sendStateUpdate();
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

function markSessionStart() {
  sessionStartedAtMs = Date.now();
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
  if (!sessionStartedAtMs) {
    return null;
  }

  const elapsedSeconds = Math.max(0, Math.ceil((Date.now() - sessionStartedAtMs) / 1000));
  sessionStartedAtMs = 0;
  state.sessionSeconds = 0;
  clearSessionSecondsTimer();

  if (!elapsedSeconds) {
    return null;
  }

  return sendRuntimeMessage({ type: "addDictationUsage", seconds: elapsedSeconds });
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
  if (active instanceof HTMLElement) {
    active.focus();
  }

  const editable = document.querySelector('[contenteditable="true"]');
  if (editable instanceof HTMLElement) {
    editable.focus();
    return editable;
  }

  return active instanceof HTMLElement ? active : null;
}

function ensureCollapsedSelection(target) {
  const ownerDocument = target.ownerDocument || document;
  const ownerWindow = ownerDocument.defaultView || window;
  const selection = ownerWindow.getSelection ? ownerWindow.getSelection() : null;
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

  const audioBase64 = await blobToBase64(blob);
  const response = await sendRuntimeMessage({
    type: "transcribeAudio",
    audioBase64,
    mimeType: blob.type || "audio/webm",
  });

  return typeof response.text === "string" ? response.text.trim() : "";
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
  if (!target || !text) {
    return false;
  }

  const ownerDocument = target.ownerDocument || document;
  const ownerWindow = ownerDocument.defaultView || window;

  if (
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLInputElement && /^(text|search|url|email|tel)$/i.test(target.type))
  ) {
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

async function handleTranscriptionText(text) {
  const normalizedTranscript = normalizeTranscriptChunk(text);
  if (!normalizedTranscript) {
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

  const inserted = insertTextIntoDocument(normalizedTranscript);
  if (!inserted) {
    desiredRunning = false;
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    }
    setStatus(
      "error",
      "Click inside the Google Docs editor first, then start dictation again."
    );
    return;
  }

  state.transcript = `${state.transcript} ${normalizedTranscript}`.trim();
  state.insertedChars += normalizedTranscript.length;
  state.interimTranscript = "";
  insertionHistory.push(normalizedTranscript);
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
      desiredRunning = false;
      lastErrorMessage = error.message || "OpenAI transcription failed.";
      state.interimTranscript = "";
      setStatus("error", lastErrorMessage);
      if (mediaRecorder && mediaRecorder.state !== "inactive") {
        mediaRecorder.stop();
      }
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

  mediaRecorder.ondataavailable = (event) => {
    if (!event.data?.size) {
      return;
    }
    void queueTranscription(event.data);
  };

  mediaRecorder.onerror = (event) => {
    desiredRunning = false;
    lastErrorMessage = event?.error?.message || "Microphone recording failed.";
    setStatus("error", lastErrorMessage);
  };

  mediaRecorder.onstop = () => {
    releaseMicrophone();
    mediaRecorder = null;
  };

  markSessionStart();
  quotaTimer = setTimeout(async () => {
    desiredRunning = false;
    try {
      if (mediaRecorder && mediaRecorder.state !== "inactive") {
        mediaRecorder.requestData();
        mediaRecorder.stop();
      }
    } catch (_error) {
      // No-op.
    }
    await transcriptionQueue.catch(() => null);
    await commitUsage().catch(() => null);
    setStatus("error", "Dictation limit reached. Upgrade to continue.");
  }, Number(quota.remainingSeconds) * 1000);

  setStatus("starting", "Starting AI dictation...");
  try {
    mediaRecorder.start(RECORDER_TIMESLICE_MS);
    setStatus("listening", "Listening and transcribing with OpenAI...");
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
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    try {
      mediaRecorder.requestData();
      mediaRecorder.stop();
    } catch (_error) {
      // No-op.
    }
  }

  await transcriptionQueue.catch(() => null);
  try {
    await commitUsage();
  } catch (_error) {
    // Keep the UX stable if the usage endpoint is unavailable.
  }

  state.interimTranscript = "";
  setStatus("idle", "Dictation stopped.");
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
      mediaRecorder.requestData();
      mediaRecorder.stop();
    } catch (_error) {
      // No-op.
    }
  }

  await transcriptionQueue.catch(() => null);
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
    stopDictation()
      .then(() => sendResponse({ ok: true, state }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Unable to stop dictation." }));
    return true;
  }

  return false;
});

document.addEventListener(
  "focusin",
  (event) => {
    rememberFocusedTarget(event.target);
  },
  true
);

document.addEventListener(
  "mouseup",
  (event) => {
    rememberFocusedTarget(event.target);
    bindIframeListeners();
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
