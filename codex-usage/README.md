# Лимиты Codex

Sidebar companion to the installed `dsh-openai-codex-auth` 0.6.4.

- Adds a clickable percentage ring to `sidebar.footer.action`, beside Settings near the account launcher, without replacing built-in controls.
- Reads the existing `remote.openaiCodex.snapshot()` service. Does not read credentials or create a second provider.
- **Details** beside the reset count expands the available cards, earliest expiry first. **Apply** opens an inline confirmation; Cancel receives initial focus. Escape cancels confirmation.
- Only the explicit **Confirm reset** button calls the provider's `consumeReset` method. Polling never applies resets, and no agent redemption tool is added.
- Uses the provider UI's pending-request storage contract plus an independent sessionStorage journal. Unknown results retain the same card and UUID across retries/reloads; other cards stay blocked. Retry is manual and confirmed. Do not start another reset in another window while a result is uncertain.
- Known provider results are shown explicitly. Card counts/limits refresh from the returned provider snapshot rather than being decremented optimistically.
- Tests run the pure request-state helper with fake storage and a fake RPC, without React/DOM emulation or any real reset requests: `node reset-flow.test.cjs`.
- The ring shows **used**, not remaining, percentage of the most consumed main Codex window. Green below 70%, amber from 70%, red from 90%.
- Details list all provider-supplied windows, available resets and exact reset dates in the browser's local time zone. Unknown values remain unknown.
- Hides when the provider is unavailable or signed out. Failed/stale reads are visibly marked; expired windows are never locally reset to zero.
- Refreshes once per minute while the page is visible; short bounded follow-up reads collect asynchronous usage results. The provider owns its own request cache and proxy settings.
- Uses the native browser popover: outside click / Escape dismiss it; no second application root or DOM access outside its own controls.

Private OpenAI usage API reference (handled by the existing provider, not this companion): https://raw.githubusercontent.com/PowerUserZ/OpenTokenUsage/main/docs/providers/codex.md

The icon is original artwork created for this plugin. No build step or install scripts.
