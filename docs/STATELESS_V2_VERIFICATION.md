# Stateless V2 verification — 2026-11-04

Ported the server-side approach from [upstream PR #1](https://github.com/hueyexe/opencode-auto-permissions/pull/1)
onto the fork's `0.2.15` baseline (`a15e6fd91b729a01a2f7e7fce771043f8035d251`),
without changing the package version or dependency lockfile.

## Automated checks

Toolchain: Bun 1.3.14 via `mise x bun@1.3.14 --`.

- `bun run verify`: TypeScript, 152 tests, rebuilt bundles, package smoke tests.
- Read-only correctness, simplicity, and instruction-compliance reviews completed.
- Review caught child-session model precedence; a regression now verifies requesting-session
  message model → requesting-session selection → root fallback, including fallback variants.

## Live OpenCode 2.2.5 proof

Used a task-owned private server and isolated XDG config so the published plugin could
not load alongside the fork. Provider credentials stayed in the existing credential store.
No global permission rules or saved approvals were changed.

1. **Without a TUI:** an inert permission API request for a zero-byte `/dev/null` operation
   resolved to `allow`. Diagnostics showed one `openai/gpt-6-luna`, `medium` model attempt.
2. **With two connected TUI clients:** repeated the test with an event observer connected
   before the request. The server returned `allow` and diagnostics showed:

   ```text
   model_attempt: openai/gpt-6-luna, variant medium, attempt 1
   decision: allow_session, source model, elapsed 1922 ms
   reviewer sessions created: 0
   permission prompts broadcast: 0
   ```

   Session approval here is the guarded in-memory exact-resource behavior, not a persisted grant.
3. **Policy denial:** a separate inert permission evaluation for catastrophic root deletion
   resolved to `deny`, without executing a command or broadcasting a permission prompt.

All requests were permission evaluations only; the harness did not execute their proposed
commands. The disposable sessions were deleted and all task-owned clients/servers were stopped.

## Verification boundary

This proves native server ownership, selected model/variant, absence of reviewer sessions,
and prompt suppression on 2.2.5. Timeout/fallback, shadow mode, cancellation, legacy API
compatibility, concurrency, and sensitive approval cases are covered by automated tests;
not every one was re-exercised against a live provider.

The native hook deliberately leaves requests as `ask` when shadowing or disposed. Such
requests can still reach compatibility TUI handlers. A runtime without native hooks retains
the older compatibility path and its multi-client limitations.
