const SpeechRecognitionCtor =
  window.SpeechRecognition || window.webkitSpeechRecognition || null;

const state = {
  connected: true,
  supported: Boolean(SpeechRecognitionCtor),
  isDocsPage: location.href.startsWith("https://docs.google.com/document/"),
  status: SpeechRecognitionCtor ? "idle" : "unsupported",
  message: SpeechRecognitionCtor
    ? "Place the cursor in Google Docs, then start dictation."
    : "This browser does not support speech recognition for this extension.",
  transcript: "",
  interimTranscript: "",
  docTitle: document.title.replace(/\s*-\s*Google Docs\s*$/, ""),
  language: "en-US",
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
  { pattern: /\b(dash|hyphen)\b/gi, value: " - " },
];

let recognition = null;
let desiredRunning = false;
let manualStopInProgress = false;
let sessionStartedAtMs = 0;
let quotaTimer = null;
let sessionSecondsTimer = null;
let lastErrorMessage = "";
let unloadCommitStarted = false;

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

  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: "addDictationUsage", seconds: elapsedSeconds },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response?.ok) {
          reject(new Error(response?.error || "Unable to save usage."));
          return;
        }
        resolve(response);
      }
    );
  });
}

function focusGoogleDocsSurface() {
  const iframe = document.querySelector(".docs-texteventtarget-iframe");
  const iframeBody = iframe?.contentDocument?.body || null;
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
    state.cursorReady = true;
    return true;
  }

  const docsSurface = focusGoogleDocsSurface();
  if (docsSurface && insertTextWithSelection(docsSurface, normalized)) {
    state.cursorReady = true;
    return true;
  }

  state.cursorReady = false;
  return false;
}

function createRecognition() {
  if (!SpeechRecognitionCtor) {
    return null;
  }

  const instance = new SpeechRecognitionCtor();
  instance.continuous = true;
  instance.interimResults = true;
  instance.maxAlternatives = 1;

  instance.onstart = () => {
    lastErrorMessage = "";
    setStatus("listening", "Listening for your voice...");
  };

  instance.onresult = (event) => {
    let interimTranscript = "";
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const transcript = result?.[0]?.transcript || "";
      if (!transcript) {
        continue;
      }

      if (result.isFinal) {
        const inserted = insertTextIntoDocument(transcript);
        if (!inserted) {
          desiredRunning = false;
          manualStopInProgress = true;
          instance.stop();
          setStatus(
            "error",
            "Click inside the Google Docs editor first, then start dictation again."
          );
          return;
        }
        const normalizedTranscript = normalizeTranscriptChunk(transcript);
        state.transcript = `${state.transcript}${normalizedTranscript}`.trim();
        state.insertedChars += normalizedTranscript.length;
      } else {
        interimTranscript += ` ${normalizeTranscriptChunk(transcript)}`;
      }
    }

    state.interimTranscript = interimTranscript.trim();
    sendStateUpdate();
  };

  instance.onerror = (event) => {
    const code = event?.error || "unknown";
    if (code === "no-speech") {
      lastErrorMessage = "No speech detected. Keep talking or start again.";
      return;
    }
    if (code === "aborted") {
      return;
    }
    if (code === "not-allowed" || code === "service-not-allowed") {
      desiredRunning = false;
      lastErrorMessage = "Allow microphone access in Chrome to use dictation.";
      setStatus("error", lastErrorMessage);
      return;
    }
    lastErrorMessage = `Speech recognition error: ${code}.`;
  };

  instance.onend = () => {
    if (manualStopInProgress) {
      manualStopInProgress = false;
      return;
    }

    if (desiredRunning) {
      setStatus("starting", lastErrorMessage || "Restarting speech recognition...");
      setTimeout(() => {
        try {
          instance.start();
        } catch (_error) {
          setStatus("error", "Unable to restart dictation. Try again.");
          desiredRunning = false;
        }
      }, 200);
      return;
    }

    if (state.status !== "error") {
      setStatus("idle", "Dictation stopped.");
    }
  };

  return instance;
}

async function startDictation(language) {
  if (!SpeechRecognitionCtor) {
    setStatus("unsupported", "Speech recognition is not available in this browser.");
    return;
  }

  const target = focusGoogleDocsSurface();
  if (!target) {
    setStatus("error", "Click inside a Google Docs document first.");
    return;
  }

  if (!recognition) {
    recognition = createRecognition();
  }

  if (!recognition) {
    setStatus("error", "Unable to initialize speech recognition.");
    return;
  }

  if (state.status === "listening" || state.status === "starting") {
    return;
  }

  state.language = typeof language === "string" && language.trim() ? language.trim() : "en-US";
  recognition.lang = state.language;
  desiredRunning = true;
  state.interimTranscript = "";
  markSessionStart();
  clearQuotaTimer();

  const quota = await new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "getDictationQuota" }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "Unable to read quota."));
        return;
      }
      resolve(response);
    });
  }).catch((error) => {
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

  quotaTimer = setTimeout(async () => {
    desiredRunning = false;
    manualStopInProgress = true;
    try {
      recognition.stop();
    } catch (_error) {
      // No-op.
    }
    await commitUsage().catch(() => null);
    setStatus("error", "Dictation limit reached. Upgrade to continue.");
  }, Number(quota.remainingSeconds) * 1000);

  setStatus("starting", "Starting speech recognition...");
  try {
    recognition.start();
  } catch (error) {
    desiredRunning = false;
    clearQuotaTimer();
    clearSessionSecondsTimer();
    sessionStartedAtMs = 0;
    setStatus("error", error.message || "Unable to start dictation.");
  }
}

async function stopDictation() {
  desiredRunning = false;
  clearQuotaTimer();
  clearSessionSecondsTimer();

  if (recognition) {
    manualStopInProgress = true;
    try {
      recognition.stop();
    } catch (_error) {
      // No-op.
    }
  }

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
  clearSessionSecondsTimer();

  if (recognition) {
    try {
      recognition.stop();
    } catch (_error) {
      // No-op.
    }
  }

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
    startDictation(message.language)
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
  () => {
    state.cursorReady = true;
    sendStateUpdate();
  },
  true
);

window.addEventListener("pagehide", () => {
  void flushUsageOnUnload();
});

window.addEventListener("beforeunload", () => {
  void flushUsageOnUnload();
});

sendStateUpdate();
