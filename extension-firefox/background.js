// background.js - Claude Auto-Continue v1.3 (Firefox MV2)
// Polls ALL claude.ai tabs across ALL windows: active, background, and
// separate browser windows. Uses browser.tabs.executeScript which works
// regardless of tab focus state.
//
// Firefox MV2 background pages are persistent - no keepalive alarm needed.

const _api = (typeof browser !== "undefined") ? browser : chrome;

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

// ── Injected code strings ──────────────────────────────────────────────────
// Firefox MV2 uses tabs.executeScript({ code }) instead of
// scripting.executeScript({ func }). Each snippet must be a self-contained
// expression that evaluates to the return value.

// ── Diagnostic detection snippet ───────────────────────────────────────────
// Returns an object with details about what was found, so the background
// script can log the exact failure point.

const CODE_DETECT_LIMIT = `
(function() {
  const PHRASES = [
    'tool-use limit', 'tool use limit', 'reached its tool',
    'exhausted the tool', 'tool call limit', 'continuation needed',
  ];

  function notHidden(el) {
    let node = el;
    while (node && node.nodeType === 1) {
      if (node.hidden) return false;
      if (node.style && node.style.display === 'none') return false;
      node = node.parentElement;
    }
    return true;
  }

  const allBtns = [...document.querySelectorAll('button, [role="button"]')];
  const btnTexts = allBtns.slice(-10).map(el => (el.textContent || '').trim().substring(0, 40));

  const continueBtn = allBtns.find(el => {
    const t = (el.textContent || '').trim();
    return (t === 'Continue' || t.startsWith('Continue')) && notHidden(el);
  });

  if (!continueBtn) {
    return { detected: false, stage: 'no-button', btnCount: allBtns.length, lastBtns: btnTexts };
  }

  // Strategy: search for the phrase in the vicinity of the Continue button.
  // Claude's UI structure changes frequently, so rather than relying on
  // specific CSS selectors for message containers, we:
  //   1. Walk up from the button looking for a sizeable ancestor
  //   2. Check the last known message-container selectors
  //   3. Fall back to a broad search of main/article/section containers
  //   4. Last resort: full document.body

  let searchText = '';
  let matchedStrategy = '';

  // Strategy 1: Known message selectors (may be outdated)
  const msgSelectors = [
    '[data-testid="assistant-message"]', '.font-claude-message',
    '[class*="AssistantMessage"]', '[class*="assistant-message"]',
  ];
  for (const sel of msgSelectors) {
    const all = document.querySelectorAll(sel);
    if (all.length) {
      searchText = (all[all.length - 1].textContent || '').toLowerCase();
      matchedStrategy = 'selector: ' + sel + ' (' + all.length + ')';
      break;
    }
  }

  // Strategy 2: Walk up from the Continue button to find a context container
  if (!searchText) {
    let ancestor = continueBtn.parentElement;
    let depth = 0;
    while (ancestor && ancestor !== document.body && depth < 15) {
      const text = (ancestor.textContent || '').toLowerCase();
      if (text.length > 200 && PHRASES.some(p => text.includes(p))) {
        searchText = text;
        matchedStrategy = 'ancestor-walk (depth ' + depth + ', tag: ' + ancestor.tagName + ')';
        break;
      }
      ancestor = ancestor.parentElement;
      depth++;
    }
  }

  // Strategy 3: Broad structural containers
  if (!searchText) {
    const containers = document.querySelectorAll('main, article, [role="main"], [role="log"], [class*="conversation"], [class*="chat"], [class*="message"]');
    for (const c of containers) {
      const text = (c.textContent || '').toLowerCase();
      if (text.length > 200) {
        searchText = text.slice(-5000);
        matchedStrategy = 'container: ' + c.tagName + (c.className ? '.' + (c.className.split(' ')[0] || '') : '');
        break;
      }
    }
  }

  // Strategy 4: Last resort - body, but only the last 5000 chars
  if (!searchText) {
    searchText = (document.body?.textContent || '').slice(-5000).toLowerCase();
    matchedStrategy = 'fallback-body';
  }

  const textLen = searchText.length;
  const phraseMatch = PHRASES.find(p => searchText.includes(p)) || null;

  if (!phraseMatch) {
    const tail = searchText.slice(-300);
    return {
      detected: false,
      stage: 'no-phrase',
      strategy: matchedStrategy,
      textLen: textLen,
      tail: tail,
    };
  }

  return { detected: true, stage: 'ok', strategy: matchedStrategy, phrase: phraseMatch };
})();
`;

const CODE_CLICK_CONTINUE = `
(function() {
  const btn = [...document.querySelectorAll('button, [role="button"]')]
    .find(el => {
      const t = (el.innerText || el.textContent || '').trim();
      return t === 'Continue' || t.startsWith('Continue');
    });
  if (btn) { btn.click(); return true; }
  return false;
})();
`;

// COMPRESSION_PROMPT is interpolated at build time below in
// runCompressionFlow via a template - the string is safe (no user input).
function makeTypePromptCode(prompt) {
  // Escape backticks/backslashes in the prompt for safe embedding
  const safe = prompt.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
  return `
(function() {
  const el =
    document.querySelector('div[contenteditable="true"][data-placeholder]') ||
    document.querySelector('div[contenteditable="true"].ProseMirror') ||
    document.querySelector('textarea[placeholder]') ||
    document.querySelector('div[contenteditable="true"]');
  if (!el) return false;
  el.focus();
  document.execCommand('selectAll', false, null);
  document.execCommand('delete', false, null);
  document.execCommand('insertText', false, \`${safe}\`);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})();
`;
}

const CODE_SUBMIT = `
(function() {
  const sendBtn = [...document.querySelectorAll('button, [role="button"]')]
    .find(el => {
      const label = (
        el.getAttribute('aria-label') || el.title || el.innerText || ''
      ).toLowerCase();
      return label.includes('send') || label.includes('submit');
    });
  if (sendBtn && !sendBtn.disabled) { sendBtn.click(); return true; }
  const input = document.querySelector('div[contenteditable="true"]');
  if (input) {
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true })
    );
    return true;
  }
  return false;
})();
`;

const CODE_IS_RESPONDING = `
(function() {
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
})();
`;

// ── Script execution wrapper ───────────────────────────────────────────────
// browser.tabs.executeScript returns an array of results.

async function execInTab(tabId, code) {
  try {
    const results = await _api.tabs.executeScript(tabId, { code });
    return results?.[0] ?? null;
  } catch {
    return null;
  }
}

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
  const tabs = await _api.tabs.query({ url: 'https://claude.ai/*' });

  if (tabs.length === 0) return; // nothing to do - don't spam the log

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

    let result = null;
    try {
      result = await execInTab(tab.id, CODE_DETECT_LIMIT);
    } catch (e) {
      console.warn('[AutoContinue] execInTab threw for tab', tab.id, ':', e.message);
      tabPending[tab.id] = false;
      continue;
    }

    // Diagnostic: log what detection found (throttled - only when interesting)
    if (result && typeof result === 'object') {
      if (result.detected) {
        console.log('[AutoContinue] DETECTED in tab', tab.id, result);
      } else if (result.stage !== 'no-button') {
        // Log when we found a button but not the phrase - that's the interesting case
        console.log('[AutoContinue] tab', tab.id, 'stage:', result.stage, result);
      }
      // 'no-button' is normal idle state - don't log to avoid spam
    } else if (result === null) {
      console.warn('[AutoContinue] tab', tab.id, 'returned null (injection may have failed)');
    }

    const detected = result && typeof result === 'object' && result.detected === true;

    if (!detected) {
      tabPending[tab.id] = false;
      continue;
    }

    // Tell content.js to stand down its own self-poll for this tab
    _api.tabs.sendMessage(tab.id, { type: 'bgTakeover' }).catch(() => {});

    try {
      if (minimizeTokens) {
        await runCompressionFlow(tab.id);
      } else {
        await runContinueFlow(tab.id);
      }

      // Re-read before incrementing so we never overwrite a concurrent update
      const fresh = await getSettings();
      const newCount = fresh.continueCount + 1;
      await _api.storage.local.set({ continueCount: newCount });

      _api.tabs.sendMessage(tab.id, {
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

// ── Continuation flows ─────────────────────────────────────────────────────

async function runContinueFlow(tabId) {
  await sleep(1200);
  await execInTab(tabId, CODE_CLICK_CONTINUE);
}

async function runCompressionFlow(tabId) {
  await sleep(1200);
  await execInTab(tabId, makeTypePromptCode(COMPRESSION_PROMPT));
  await sleep(400);
  await execInTab(tabId, CODE_SUBMIT);
  await waitForResponseIdle(tabId, 45000);
  await sleep(600);
  await execInTab(tabId, CODE_CLICK_CONTINUE);
}

async function waitForResponseIdle(tabId, timeoutMs) {
  const t0 = Date.now();
  await sleep(3000); // initial grace period before polling starts

  while (Date.now() - t0 < timeoutMs) {
    const responding = await execInTab(tabId, CODE_IS_RESPONDING);
    if (!responding) return; // Claude has finished responding
    await sleep(1500);
  }
  // Timed out - proceed anyway rather than leaving the flow stuck
}

// ── Helpers ────────────────────────────────────────────────────────────────

function getSettings() {
  return new Promise((resolve) => {
    _api.storage.local.get(
      ['paused', 'maxContinues', 'continueCount', 'minimizeTokens'],
      (d) => resolve({
        paused:         d.paused         ?? false,
        maxContinues:   d.maxContinues   ?? 20,   // 0 means unlimited
        continueCount:  d.continueCount  ?? 0,
        minimizeTokens: d.minimizeTokens ?? false,
      })
    );
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Event listeners ────────────────────────────────────────────────────────

_api.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'reset') {
    Object.keys(tabPending).forEach(k => delete tabPending[k]);
  }
});

_api.tabs.onRemoved.addListener((tabId) => {
  delete tabPending[tabId];
});

_api.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    delete tabPending[tabId];
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
startPolling();
