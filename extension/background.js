// background.js - Claude Auto-Continue v1.3
// Polls ALL claude.ai tabs across ALL windows: active, background, and
// separate browser windows. Uses scripting.executeScript which works
// regardless of tab focus state.

const POLL_MS = 3000;

// NOTE: COMPRESSION_PROMPT is also defined in content.js (self-poll fallback).
// If you change the wording here, update content.js to match.
const COMPRESSION_PROMPT =
  'Before continuing: in 3-5 bullet points, summarize exactly where you ' +
  'are in the current task, what you have already completed, and what the ' +
  'next concrete step is. Be maximally concise - no file contents, no ' +
  'command output, no prose. Then stop and wait.';

// Per-tab pending guard - prevents double-clicks when both background.js
// and content.js detect the limit simultaneously.
const tabPending = {};

// ── Service worker keepalive ───────────────────────────────────────────────
// MV3 service workers are killed after ~30s idle. chrome.alarms wakes
// the worker every 24s so polling continues uninterrupted.
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => {}); // wakes the worker

// ── Main poll loop ─────────────────────────────────────────────────────────

function startPolling() {
  setInterval(async () => {
    try {
      await pollAllClaudeTabs();
    } catch {
      // Swallow navigation errors - tab may have closed mid-poll
    }
  }, POLL_MS);
}

async function pollAllClaudeTabs() {
  const { paused, maxContinues, minimizeTokens } = await getSettings();
  if (paused) return;

  // Query across ALL windows: active + background + separate windows.
  // chrome.tabs.query with no windowId returns tabs from every open window.
  const tabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });

  for (const tab of tabs) {
    if (tabPending[tab.id]) continue;

    // Re-read continueCount fresh for each tab to avoid the multi-tab race
    // condition where two tabs both read the same stale count and both write
    // count + 1, causing an undercount.
    const { continueCount } = await getSettings();
    if (maxContinues > 0 && continueCount >= maxContinues) continue;

    // Claim the tab atomically before any await to prevent content.js
    // from also firing on the same detection event.
    tabPending[tab.id] = true;

    let detected = false;
    try {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: detectLimitMessage,
      });
      detected = r?.result === true;
    } catch {
      tabPending[tab.id] = false;
      continue; // Tab not ready or navigating away
    }

    if (!detected) {
      tabPending[tab.id] = false;
      continue;
    }

    // Tell content.js to stand down its own self-poll for this tab
    chrome.tabs.sendMessage(tab.id, { type: 'bgTakeover' }).catch(() => {});

    try {
      if (minimizeTokens) {
        await runCompressionFlow(tab.id);
      } else {
        await runContinueFlow(tab.id);
      }

      // Re-read before incrementing so we never overwrite a concurrent update
      const fresh = await getSettings();
      const newCount = fresh.continueCount + 1;
      await chrome.storage.local.set({ continueCount: newCount });

      chrome.tabs.sendMessage(tab.id, {
        type: 'backgroundContinued',
        count: newCount,
        max: fresh.maxContinues,
        minimizeTokens,
      }).catch(() => {});

    } catch (e) {
      console.warn('[AutoContinue] tab', tab.id, 'failed:', e.message);
    } finally {
      tabPending[tab.id] = false;
    }
  }
}

// ── Injected functions ─────────────────────────────────────────────────────
// Serialised and injected into tabs via scripting.executeScript.
// Must be fully self-contained - no references to outer scope variables.

function detectLimitMessage() {
  const PHRASES = [
    'tool-use limit',
    'tool use limit',
    'reached its tool',
    'exhausted the tool',
    'tool call limit',
    'continuation needed',
  ];

  // Require a visible Continue button as the primary trigger signal.
  // Checking body.innerText alone causes false positives when chat history
  // merely mentions these phrases (e.g. a conversation about this extension).
  const continueBtn = [...document.querySelectorAll('button, [role="button"]')]
    .find(el => {
      const t = (el.innerText || el.textContent || '').trim();
      return (t === 'Continue' || t.startsWith('Continue')) &&
             el.offsetParent !== null; // visible in the DOM
    });

  if (!continueBtn) return false;

  // Also confirm the phrase appears in the last assistant message only,
  // not anywhere in the full conversation history.
  const msgSelectors = [
    '[data-testid="assistant-message"]',
    '.font-claude-message',
    '[class*="AssistantMessage"]',
    '[class*="assistant-message"]',
  ];

  let searchEl = null;
  for (const sel of msgSelectors) {
    const all = document.querySelectorAll(sel);
    if (all.length) {
      searchEl = all[all.length - 1];
      break;
    }
  }

  // Fall back to last 2000 chars of body text if no message containers found
  const searchText = searchEl
    ? (searchEl.innerText || searchEl.textContent || '').toLowerCase()
    : (document.body?.innerText || '').slice(-2000).toLowerCase();

  return PHRASES.some(p => searchText.includes(p));
}

function clickContinueButton() {
  const btn = [...document.querySelectorAll('button, [role="button"]')]
    .find(el => {
      const t = (el.innerText || el.textContent || '').trim();
      return t === 'Continue' || t.startsWith('Continue');
    });
  if (btn) {
    btn.click();
    return true;
  }
  return false;
}

function typeCompressionPrompt(prompt) {
  const el =
    document.querySelector('div[contenteditable="true"][data-placeholder]') ||
    document.querySelector('div[contenteditable="true"].ProseMirror') ||
    document.querySelector('textarea[placeholder]') ||
    document.querySelector('div[contenteditable="true"]');

  if (!el) return false;

  el.focus();

  // execCommand is deprecated but remains the only reliable way to trigger
  // React/ProseMirror synthetic input events on Claude's editor. Direct value
  // assignment and the Clipboard API do not fire the events the input listens to.
  document.execCommand('selectAll', false, null);
  document.execCommand('delete', false, null);
  document.execCommand('insertText', false, prompt);
  el.dispatchEvent(new Event('input', { bubbles: true }));

  return true;
}

function submitChatInput() {
  const sendBtn = [...document.querySelectorAll('button, [role="button"]')]
    .find(el => {
      const label = (
        el.getAttribute('aria-label') || el.title || el.innerText || ''
      ).toLowerCase();
      return label.includes('send') || label.includes('submit');
    });

  if (sendBtn && !sendBtn.disabled) {
    sendBtn.click();
    return true;
  }

  // Fallback: Enter keydown on the contenteditable input
  const input = document.querySelector('div[contenteditable="true"]');
  if (input) {
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true })
    );
    return true;
  }

  return false;
}

function isClaudeResponding() {
  const stopBtn = [...document.querySelectorAll('button, [role="button"]')]
    .find(el =>
      (el.getAttribute('aria-label') || el.innerText || '').toLowerCase().includes('stop')
    );
  const sendBtn = [...document.querySelectorAll('button, [role="button"]')]
    .find(el => {
      const label = (
        el.getAttribute('aria-label') || el.title || el.innerText || ''
      ).toLowerCase();
      return label.includes('send') || label.includes('submit');
    });
  return !!stopBtn || sendBtn?.disabled === true;
}

// ── Continuation flows ─────────────────────────────────────────────────────

async function runContinueFlow(tabId) {
  await sleep(1200);
  await chrome.scripting.executeScript({
    target: { tabId },
    func: clickContinueButton,
  });
}

async function runCompressionFlow(tabId) {
  await sleep(1200);
  await chrome.scripting.executeScript({
    target: { tabId },
    func: typeCompressionPrompt,
    args: [COMPRESSION_PROMPT],
  });
  await sleep(400);
  await chrome.scripting.executeScript({ target: { tabId }, func: submitChatInput });
  await waitForResponseIdle(tabId, 45000);
  await sleep(600);
  await chrome.scripting.executeScript({ target: { tabId }, func: clickContinueButton });
}

async function waitForResponseIdle(tabId, timeoutMs) {
  const t0 = Date.now();
  await sleep(3000); // initial grace period before polling starts

  while (Date.now() - t0 < timeoutMs) {
    try {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId },
        func: isClaudeResponding,
      });
      if (!r?.result) return; // Claude has finished responding
    } catch {
      return; // Tab closed or navigated - exit gracefully
    }
    await sleep(1500);
  }
  // Timed out - proceed anyway rather than leaving the flow stuck
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function getSettings() {
  const d = await chrome.storage.local.get([
    'paused', 'maxContinues', 'continueCount', 'minimizeTokens',
  ]);
  return {
    paused:         d.paused         ?? false,
    maxContinues:   d.maxContinues   ?? 20,   // 0 means unlimited
    continueCount:  d.continueCount  ?? 0,
    minimizeTokens: d.minimizeTokens ?? false,
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Event listeners ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'reset') {
    Object.keys(tabPending).forEach(k => delete tabPending[k]);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabPending[tabId];
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    delete tabPending[tabId];
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
startPolling();
