# Changelog

All notable changes to this project are documented here.

---

## [1.3.0] - 2026-03-15

### Added
- Background tab support: service worker polls all claude.ai tabs across all windows using `scripting.executeScript`, regardless of focus state
- Separate browser window support: `chrome.tabs.query` with no `windowId` covers every open window
- `chrome.alarms` keepalive every 24s to prevent MV3 service worker from dying after 30s idle
- `bgTakeover` message so content.js defers to background.js when the service worker fires first
- 60s safety timeout on `bgTakeover` so content.js recovers if background.js crashes mid-flow
- No limit option (set `maxContinues` to 0) alongside the increased 1-999 range
- Comprehensive test harness (`test/test.html`) with 10 unit tests and 10 background tab tests across 3 window types

### Fixed
- Multi-tab race condition: `continueCount` is now re-read from storage before each increment rather than using a stale value read once at the top of the poll loop
- False positive detections: detection now requires a visible Continue button AND the phrase in the last assistant message only, not anywhere in conversation history
- `tab` null guard in popup.js for when popup is opened from a non-tab context
- Double-click prevention via atomic `tabPending` claim before any `await`

### Changed
- Version strings unified to 1.3.0 across all files
- Injected functions in background.js reformatted for readability
- `innerHTML` in toast replaced with `textContent` assignments to eliminate any XSS surface
- `test.html` moved from `extension/` to `test/` folder
- Issue URL in popup.html updated to point to this repository

---

## [1.2.0]

### Added
- Minimize tokens mode: types a compression prompt before clicking Continue
- No limit checkbox in popup
- Max continuations raised to 999

---

## [1.1.0]

### Added
- Firefox build with MV2 manifest and `browser`/`chrome` shim
- Professional popup UI with stats, progress bar, and toggle switches
- Double chevron icon

---

## [1.0.0]

### Added
- Initial release
- Auto-detects tool-use limit message and clicks Continue
- Toast notification on each continuation
- Configurable max continuations and pause/resume
