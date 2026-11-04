# Agent memory: opencode-auto-permissions

- Run tools via `mise x bun@1.3.14 --` (matches `@types/bun`). Always `CI=true` for git.
- Gate: `bun install --frozen-lockfile` then `bun run verify` (check, test, build, test:package). `dist/` is tracked and Git-package consumers load it; regenerate with `bun run build`, never hand-edit. A fresh frozen install bundles a much larger `dist/server.js` (~24k lines) than older commits; that is toolchain drift, not a source change.
- V2 native path: `src/native.ts` registers `ctx.permission.hook("evaluate")` from `src/server.ts` setup. It mutates `event.effect`/`message` before OpenCode broadcasts the request (so no TUI duplicates). It feature-detects hook, `session.context/get`, and `experimental.generate.text` (preferred) or `generate.text`; otherwise the TUI `installReviewer` path remains.
- Shared engine lives in `src/reviewer.ts` (`decideReview`, `ReviewState`, `rememberApproval`, model fallback in `modelDecision`). Do not duplicate it; the native hook has no `always`/`save` patterns, so session reuse is exact-resource only (`always = resources`) behind the same guardrails.
- Stateless generation has no hidden agent, so `generateStatelessDecision` (`src/opencode-client.ts`) puts `REVIEWER_SYSTEM_PROMPT` in the prompt. The TUI `OpenCodeClientAdapter` also prefers `client.generate.text` when present.
- Shadow mode must leave `event.effect === "ask"` even on failures.
- Native tests: `test/native.test.ts` (mock `NativeContext`; no live runtime). Live harness: `bun run test:v2` / `bun run test:stable`.
- 2026-11-04 live2.2.5 proof passed in an isolated private server: no-TUI approval and two-TUI approval each used one Luna/medium attempt; two-client SSE observed zero reviewer sessions and zero permission prompts; inert catastrophic-delete evaluation denied. See `docs/STATELESS_V2_VERIFICATION.md`. Temporary processes/sessions cleaned, global saved permissions untouched.
