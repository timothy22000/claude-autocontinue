# Contributing

Thanks for wanting to improve Claude Auto-Continue.

---

## Before you open a PR

- Check the open issues to see if someone is already working on it
- For large changes, open an issue first to discuss the approach
- Keep PRs focused on one thing - small and reviewable beats large and sprawling

---

## Setup

No build step. The extension is plain HTML, CSS, and JavaScript.

```bash
git clone https://github.com/timothy22000/claude-autocontinue
cd claude-autocontinue
```

Load unpacked in Chrome:
1. `chrome://extensions/` - enable Developer mode
2. Load unpacked - select the `extension/` folder

---

## Testing

Open `test/test.html` in a browser. No server needed - just double-click it.

- **Unit tests** cover detection logic, DOM helpers, toast rendering, and guard conditions
- **Background tab tests** open three child windows to simulate active tab, background tab, and separate window scenarios. Allow popups when prompted.

All tests should pass before submitting a PR.

---

## What to work on

Good first issues:
- Improve selector resilience when Anthropic updates the claude.ai UI
- Add support for Claude mobile web
- Improve the compression prompt wording

Harder:
- Replace `document.execCommand` with a non-deprecated input method that still triggers ProseMirror events
- Add per-conversation continuation tracking (reset count when conversation changes)

---

## Code style

- No build tools, no bundler, no TypeScript
- Plain ES2020+ for extension files
- Comments explain *why*, not *what*
- Injected functions in background.js must be self-contained (no outer scope references)
- Version number lives in `manifest.json`, `popup.html` footer, and the comment header of each JS file - keep them in sync

---

## Submitting

1. Fork the repo
2. Create a branch: `git checkout -b fix/your-thing`
3. Make your changes
4. Run the test harness and confirm all tests pass
5. Open a pull request with a clear description of what changed and why
