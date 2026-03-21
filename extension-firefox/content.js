// content.js - Claude Auto-Continue v1.3
// Self-polls as a fallback. Defers to background.js service worker when active.

// Firefox/Chrome compatibility shim
const _api = (typeof browser !== "undefined") ? browser : chrome;

(function () {
  'use strict';

  const LIMIT_PHRASES = [
    'tool-use limit',
    'tool use limit',
    'reached its tool',
    'exhausted the tool',
    'tool call limit',
    'continuation needed',
  ];

  const POLL_MS             = 2000;
  const CLICK_DELAY         = 1200;
  const TOAST_MS            = 3500;
  const COMPRESSION_WAIT_MS = 3000;
  const COMPRESSION_POLL_MS = 1500;
  const COMPRESSION_TIMEOUT = 45000;
  const BG_TAKEOVER_TIMEOUT = 60000; // max ms to wait for backgroundContinued before self-resuming

  // NOTE: COMPRESSION_PROMPT is also defined in background.js (service worker).
  // If you change the wording here, update background.js to match.
  const COMPRESSION_PROMPT =
    'Before continuing: in 3-5 bullet points, summarize exactly where you ' +
    'are in the current task, what you have already completed, and what the ' +
    'next concrete step is. Be maximally concise - no file contents, no ' +
    'command output, no prose. Then stop and wait.';

  // ── State ──────────────────────────────────────────────────────────────────
  let continueCount  = 0;
  let maxContinues   = 20;
  let paused         = false;
  let minimizeTokens = false;
  let intervalId     = null;
  let pendingAction  = false;

  // Set to true when background.js sends bgTakeover.
  // Cleared when backgroundContinued arrives or BG_TAKEOVER_TIMEOUT fires.
  let bgWorkerActive    = false;
  let bgTakeoverTimer   = null;

  // ── Init ───────────────────────────────────────────────────────────────────
  _api.storage.local.get(
    ['paused', 'maxContinues', 'continueCount', 'minimizeTokens'],
    (data) => {
      paused         = data.paused         ?? false;
      maxContinues   = data.maxContinues   ?? 20;
      continueCount  = data.continueCount  ?? 0;
      minimizeTokens = data.minimizeTokens ?? false;
      if (!paused) startPolling();
    }
  );

  // ── Messages ───────────────────────────────────────────────────────────────
  _api.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'setPaused') {
      paused = msg.value;
      paused ? stopPolling() : startPolling();
    }

    if (msg.type === 'setMax') {
      maxContinues = msg.value;
    }

    if (msg.type === 'setMinimizeTokens') {
      minimizeTokens = msg.value;
    }

    if (msg.type === 'reset') {
      continueCount  = 0;
      paused         = false;
      pendingAction  = false;
      bgWorkerActive = false;
      clearTimeout(bgTakeoverTimer);
      startPolling();
    }

    // Service worker has claimed this tab - stand down self-poll
    if (msg.type === 'bgTakeover') {
      bgWorkerActive = true;
      pendingAction  = true;

      // Safety net: if background.js crashes and never sends backgroundContinued,
      // release the lock after BG_TAKEOVER_TIMEOUT so self-polling can resume.
      clearTimeout(bgTakeoverTimer);
      bgTakeoverTimer = setTimeout(() => {
        bgWorkerActive = false;
        pendingAction  = false;
      }, BG_TAKEOVER_TIMEOUT);
    }

    // Service worker finished - update state, show toast, resume self-poll
    if (msg.type === 'backgroundContinued') {
      clearTimeout(bgTakeoverTimer);
      continueCount  = msg.count;
      maxContinues   = msg.max;
      minimizeTokens = msg.minimizeTokens;
      pendingAction  = false;
      bgWorkerActive = false;
      showToast(msg.count, msg.max);
      if (msg.max > 0 && msg.count >= msg.max) stopPolling();
    }
  });

  // ── DOM helpers ────────────────────────────────────────────────────────────

  // Visibility: avoid offsetParent and getComputedStyle - both are unreliable
  // in Firefox background tabs (layout is not computed). Instead just check
  // the hidden attribute and inline display:none up the tree. The two-signal
  // requirement (button + phrase in last message) already prevents false
  // positives, so this only needs to filter out truly hidden DOM nodes.
  function notHidden(el) {
    let node = el;
    while (node && node.nodeType === 1) {
      if (node.hidden) return false;
      if (node.style && node.style.display === 'none') return false;
      node = node.parentElement;
    }
    return true;
  }

  function pageContainsLimitMessage() {
    // Require a Continue button as the primary trigger signal.
    // Do NOT scan all body text: it includes chat history that may merely
    // mention these phrases (e.g. a conversation about this extension itself).
    const continueBtn = [...document.querySelectorAll('button, [role="button"]')]
      .find(el => {
        const t = (el.innerText || el.textContent || '').trim();
        return (t === 'Continue' || t.startsWith('Continue')) &&
               notHidden(el);
      });

    if (!continueBtn) return false;

    // Search for the limit phrase using multiple strategies, since Claude's
    // UI structure changes and class-based selectors go stale.

    // Strategy 1: Known message selectors
    const msgSelectors = [
      '[data-testid="assistant-message"]',
      '.font-claude-message',
      '[class*="AssistantMessage"]',
      '[class*="assistant-message"]',
    ];

    for (const sel of msgSelectors) {
      const all = document.querySelectorAll(sel);
      if (all.length) {
        const text = (all[all.length - 1].textContent || '').toLowerCase();
        if (LIMIT_PHRASES.some(p => text.includes(p))) return true;
        break; // Selector matched elements but phrase not found - keep trying
      }
    }

    // Strategy 2: Walk up from the Continue button
    let ancestor = continueBtn.parentElement;
    let depth = 0;
    while (ancestor && ancestor !== document.body && depth < 15) {
      const text = (ancestor.textContent || '').toLowerCase();
      if (text.length > 200 && LIMIT_PHRASES.some(p => text.includes(p))) return true;
      ancestor = ancestor.parentElement;
      depth++;
    }

    // Strategy 3: Broad structural containers
    const containers = document.querySelectorAll(
      'main, article, [role="main"], [role="log"], [class*="conversation"], [class*="chat"], [class*="message"]'
    );
    for (const c of containers) {
      const text = (c.textContent || '').toLowerCase();
      if (text.length > 200 && LIMIT_PHRASES.some(p => text.includes(p))) return true;
    }

    // Strategy 4: Last resort - body text
    const bodyText = (document.body?.textContent || '').slice(-5000).toLowerCase();
    return LIMIT_PHRASES.some(p => bodyText.includes(p));
  }

  function findContinueButton() {
    return [...document.querySelectorAll('button, [role="button"]')].find(el => {
      const t = (el.innerText || el.textContent || '').trim();
      return t === 'Continue' || t.startsWith('Continue');
    });
  }

  function findChatInput() {
    return (
      document.querySelector('div[contenteditable="true"][data-placeholder]') ||
      document.querySelector('div[contenteditable="true"].ProseMirror') ||
      document.querySelector('textarea[placeholder]') ||
      document.querySelector('div[contenteditable="true"]')
    );
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

  function typeIntoInput(text) {
    const el = findChatInput();
    if (!el) return false;

    el.focus();

    // execCommand is deprecated but remains the only reliable way to trigger
    // React/ProseMirror synthetic input events on Claude's editor.
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    document.execCommand('insertText', false, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));

    return true;
  }

  function submitMessage() {
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

    const input = findChatInput();
    if (input) {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true })
      );
      return true;
    }

    return false;
  }

  // ── Compression flow ───────────────────────────────────────────────────────

  function waitForResponseComplete(onDone, onTimeout) {
    const t0 = Date.now();
    setTimeout(() => {
      const iv = setInterval(() => {
        if (Date.now() - t0 > COMPRESSION_TIMEOUT) {
          clearInterval(iv);
          onTimeout();
          return;
        }
        if (!isClaudeResponding()) {
          clearInterval(iv);
          onDone();
        }
      }, COMPRESSION_POLL_MS);
    }, COMPRESSION_WAIT_MS);
  }

  // ── Core continuation ──────────────────────────────────────────────────────

  function performContinuation() {
    if (!minimizeTokens) {
      const btn = findContinueButton();
      if (btn) {
        btn.click();
        onContinued();
      } else {
        pendingAction = false;
      }
      return;
    }

    showToast(continueCount, maxContinues, false, 'compressing');

    if (!typeIntoInput(COMPRESSION_PROMPT)) {
      // Input not found - fall back to plain continue
      const btn = findContinueButton();
      if (btn) btn.click();
      onContinued();
      return;
    }

    setTimeout(() => {
      if (!submitMessage()) {
        pendingAction = false;
        return;
      }
      waitForResponseComplete(
        () => {
          setTimeout(() => {
            const b = findContinueButton();
            if (b) b.click();
            onContinued();
          }, 600);
        },
        () => {
          const b = findContinueButton();
          if (b) b.click();
          onContinued();
        }
      );
    }, 400);
  }

  function onContinued() {
    continueCount++;
    _api.storage.local.set({ continueCount });
    showToast(continueCount, maxContinues);
    if (maxContinues > 0 && continueCount >= maxContinues) stopPolling();
    pendingAction = false;
  }

  // ── Poll loop ──────────────────────────────────────────────────────────────

  function poll() {
    if (paused || pendingAction || bgWorkerActive) return;
    if (maxContinues > 0 && continueCount >= maxContinues) return;
    if (!pageContainsLimitMessage()) return;

    pendingAction = true;

    setTimeout(() => {
      if (paused || bgWorkerActive) {
        pendingAction = false;
        return;
      }
      performContinuation();
    }, CLICK_DELAY);
  }

  function startPolling() {
    if (!intervalId) intervalId = setInterval(poll, POLL_MS);
  }

  function stopPolling() {
    clearInterval(intervalId);
    intervalId = null;
  }

  // ── Toast ──────────────────────────────────────────────────────────────────

  function injectToastStyles() {
    if (document.getElementById('cac-styles')) return;
    const s = document.createElement('style');
    s.id = 'cac-styles';
    s.textContent = `
      #cac-toast {
        position: fixed; bottom: 24px; right: 24px; z-index: 2147483647;
        display: flex; align-items: center; gap: 10px;
        background: #16181c; color: #f0f2f5;
        font-family: 'DM Sans', system-ui, -apple-system, sans-serif;
        font-size: 12px; font-weight: 500;
        padding: 10px 14px; border-radius: 8px;
        border: 1px solid rgba(255,255,255,.08);
        box-shadow: 0 4px 24px rgba(0,0,0,.4);
        pointer-events: none; opacity: 0; transform: translateY(6px);
        transition: opacity .2s, transform .2s;
        max-width: 280px; line-height: 1.4;
      }
      #cac-toast.show { opacity: 1; transform: translateY(0); }
      #cac-toast.hide { opacity: 0; transform: translateY(4px); }
      .cac-icon {
        width: 18px; height: 18px; border-radius: 5px; background: #4f8ef7;
        flex-shrink: 0; display: flex; align-items: center; justify-content: center;
      }
      .cac-icon.warn   { background: #f59e0b; }
      .cac-icon.purple { background: #8b5cf6; }
      .cac-icon svg { width: 10px; height: 10px; fill: white; }
      .cac-title { color: #f0f2f5; }
      .cac-sub   { color: #555c6a; font-size: 11px; margin-top: 1px; }
      .cac-badge {
        margin-left: auto; font-size: 10px; font-weight: 600;
        padding: 2px 6px; border-radius: 4px; letter-spacing: .02em; flex-shrink: 0;
        background: rgba(79,142,247,.15); color: #4f8ef7;
      }
      .cac-badge.warn   { background: rgba(245,158,11,.15); color: #f59e0b; }
      .cac-badge.purple { background: rgba(139,92,246,.15); color: #8b5cf6; }
    `;
    document.head.appendChild(s);
  }

  let toastTimer = null;

  function showToast(count, max, isMax = false, mode) {
    injectToastStyles();

    let toast = document.getElementById('cac-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'cac-toast';
      document.body.appendChild(toast);
    }

    clearTimeout(toastTimer);

    const isWarn = !isMax && count / max >= 0.75;
    const isComp = mode === 'compressing';
    const iconClass  = isComp ? 'purple' : (isMax || isWarn ? 'warn' : '');
    const badgeClass = isComp ? 'purple' : (isMax || isWarn ? 'warn' : '');

    const title = isComp  ? 'Compressing context...'
                : isMax   ? 'Limit reached'
                :            'Continued automatically';

    const sub = isComp         ? 'Summarizing before resuming'
              : isMax          ? 'Increase max in the popup'
              : minimizeTokens ? 'Context compressed + resumed'
              :                  'Claude hit the tool-use cap';

    const badge = isComp ? 'tokens' : `${count}/${max === 0 ? 'inf' : max}`;

    // Using textContent for title/sub avoids XSS. Badge is always a safe number string.
    toast.innerHTML = `
      <div class="cac-icon ${iconClass}">
        <svg viewBox="0 0 24 24"><path d="M13 2L4.5 13.5H11L10 22L19.5 10.5H13L13 2Z"/></svg>
      </div>
      <div class="cac-body">
        <div class="cac-title"></div>
        <div class="cac-sub"></div>
      </div>
      <div class="cac-badge ${badgeClass}"></div>`;

    toast.querySelector('.cac-title').textContent = title;
    toast.querySelector('.cac-sub').textContent   = sub;
    toast.querySelector('.cac-badge').textContent = badge;

    toast.classList.remove('show', 'hide');
    void toast.offsetWidth; // force reflow
    toast.classList.add('show');

    // Keep compressing toast visible until replaced by the next one
    toastTimer = setTimeout(() => {
      toast.classList.replace('show', 'hide');
    }, isComp ? 60000 : TOAST_MS);
  }

})();
