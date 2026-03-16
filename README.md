# Claude Auto-Continue


A browser extension that automatically resumes Claude when it hits the per-turn tool-use limit. Works across all tabs and windows - active, background, and separate browser windows.

![Version](https://img.shields.io/badge/version-1.3.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Manifest](https://img.shields.io/badge/manifest-v3-green)
![Firefox](https://img.shields.io/badge/firefox-MV2-orange)

---

## The problem

Claude has an undocumented per-turn tool-call cap (around 20 calls). When it is hit, Claude stops mid-task and shows a **Continue** button. This interrupts automated workflows, forces manual intervention, and inflates usage costs because each forced continuation re-sends the full conversation context.

---

## What this extension does

- Detects the tool-use limit message and clicks **Continue** automatically
- Works in active tabs, background tabs, and separate browser windows
- Optional **Minimize tokens** mode: asks Claude to write a compact summary of its current state before resuming, reducing context re-sent on each continuation
- Shows a small toast notification on each continuation
- Configurable max continuations (1-999) or unlimited mode
- Pause / resume at any time from the popup

---

## Install

### Chrome / Edge (Developer Mode)

1. Download and unzip the latest release from the [Releases](https://github.com/timothy22000/claude-autocontinue/releases) page
2. Open `chrome://extensions/` (or `edge://extensions/`)
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** and select the `extension/` folder
5. Open or reload claude.ai

### Firefox

1. Open `about:debugging` in Firefox
2. Click **This Firefox** then **Load Temporary Add-on**
3. Select any file inside the `extension-firefox/` folder

For a permanent Firefox install, upload the `extension-firefox/` folder to [addons.mozilla.org](https://addons.mozilla.org/developers/) for free signing, then distribute the `.xpi` directly.

---

## Popup controls

| Control | Description |
|---|---|
| Auto-continue toggle | Enable or disable the extension |
| Minimize tokens | Before resuming, ask Claude to summarize its state (reduces context re-sent) |
| Max continuations | Cap the number of auto-continuations (1-999). Set to "No limit" for unlimited. |
| Pause / Resume button | Temporarily pause without changing settings |
| Reset counter | Reset the continuation count back to zero |

---

## Permissions

| Permission | Why it is needed |
|---|---|
| `scripting` | Inject detection and click scripts into claude.ai tabs |
| `tabs` | Query all open claude.ai tabs across every window |
| `storage` | Persist settings (pause state, max count, etc.) across sessions |
| `alarms` | Keep the service worker alive every 24s so background polling continues |
| `activeTab` | Access the currently active tab for popup controls |
| `host_permissions: claude.ai` | Limit all of the above to claude.ai only |

---

## How it works

### Detection (two-part gate)

The extension only fires when **both** conditions are true:

1. A visible **Continue** button is present in the DOM
2. The tool-use limit phrase appears in the **last assistant message only** (not in conversation history)

This prevents false positives from conversations that merely mention "tool-use limit" in their text.

### Architecture

```
background.js (service worker)
  - Polls all claude.ai tabs every 3s via scripting.executeScript
  - Works regardless of tab focus, window state, or minimized status
  - Sends bgTakeover to content.js to prevent double-clicks
  - Kept alive by chrome.alarms every 24s

content.js (injected into every claude.ai tab)
  - Self-polls as a fallback (for cases where service worker has not started)
  - Defers to background.js when bgTakeover is received
  - Shows toast notifications
  - Has a 60s safety timeout on bgTakeover in case background.js crashes
```

### Minimize tokens mode

When enabled, instead of clicking Continue immediately:

1. The extension types a compression prompt into the chat input
2. Waits for Claude to respond with a compact state summary
3. Then clicks Continue

This reduces the token cost of each continuation because the next turn starts from a short summary rather than the full unprocessed tool-call history.

---

## Development

```
claude-autocontinue/
  extension/              Chrome / Edge (Manifest V3)
    background.js         Service worker - polls all tabs
    content.js            In-page script - toast, self-poll fallback
    popup.html            Extension popup UI
    popup.js              Popup logic
    manifest.json
    icon{16,48,128}.png
  extension-firefox/      Firefox (Manifest V2)
    (same files, browser/* shim, MV2 manifest)
  test/
    test.html             Self-contained test harness (open in browser)
```

### Running tests

Open `test/test.html` directly in a browser (no server needed - just double-click the file). No extension installed is required.

The harness has two suites:

**Unit tests (10 tests)** - run entirely in the page, no popups needed:

| Test | What it covers |
|---|---|
| Detects tool-use limit phrase | Core detection returns true |
| Detects all phrase variants | All 6 trigger phrases work |
| No false positive on clean page | Does not fire without the phrase |
| Finds Continue button | Button selector works |
| Clicks Continue after detection | Full end-to-end flow with 1.2s delay |
| Finds chat input | contenteditable selector works |
| Types compression prompt | Token-minimize typing works |
| Respects max cap | Stops at configured limit |
| Respects paused state | Honours the pause toggle |
| Toast renders correctly | Visual notification appears |

**Background tab tests (10 tests)** - open real child windows to simulate different tab states. Allow popups when prompted.

| Test | What it covers |
|---|---|
| Open 3 test windows | Active tab, background tab, separate window all spawn |
| [Active] Detects limit | Detection works in a focused tab |
| [Active] Clicks Continue | Click fires in a focused tab |
| [Background] Detects limit | Detection works while tab is not focused |
| [Background] Clicks Continue | Click fires while tab is not focused |
| [Separate window] Detects limit | Detection works in a different browser window |
| [Separate window] Clicks Continue | Click fires across browser windows |
| [Multi] All 3 simultaneously | All three tabs continued in one pass |
| [Background] 4s throttle delay | Still fires after simulated browser timer throttle |
| Close all test windows | Cleanup |

> **Note on the background tab tests:** browsers block popups by default. When the tests run you will see a permission banner with step-by-step instructions for Chrome, Firefox, Safari, and Edge. The popup is only used for testing - the extension itself never opens popups.

---

## Known limitations

- **Discarded tabs**: Chrome can unload a tab's renderer entirely when memory is low. The extension detects this and skips the tab silently. The tab resumes normally when you open it again.
- **`document.execCommand` deprecation**: The compression prompt typing uses `execCommand('insertText')` because it is the only reliable way to trigger React/ProseMirror synthetic input events on Claude's editor. It still works in all browsers but may need updating if Claude changes its input implementation.
- **Claude UI changes**: The extension uses CSS selectors and button text to find UI elements. If Anthropic updates the claude.ai interface, selectors may need updating.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

---

## License

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

