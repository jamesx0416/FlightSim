# Agent Instructions

**Important:** Do not implement, exit, or add anything that is heuristic or aircraft-specific. All bug fixes and changes must be generic loader/runtime fixes that apply broadly and authoritatively, not patches tailored to a specific aircraft.

Heuristic or aircraft-specific tests are allowed for investigation only; landed fixes must be generic and verified without such patches.

Use `aircrafts/` package data as test fixtures; do not patch it to fix loader/runtime behavior unless explicitly asked.

Continue implementation until everything in `docs/investigations/loader-todo.md#stock-support-todo` that is in scope for this repo is either checked off or explicitly documented as blocked with a reason.

Always use `bun` as the package manager for this project unless told otherwise.

All viewer capabilities should be available through the browser API, `window.__DevApi`; agents should prefer it over synthetic UI gestures when equivalent API functionality exists. When adding a user-facing viewer capability, add or update the matching `__DevApi` method in the same change. See `docs/devapi-reference.md` for callable methods, examples, wait/chaining patterns, and gauge notes.

Use `NOTES.md` for durable investigation observations, rejected experiments, and useful-but-not-active evidence. Do not turn notes into behavior changes unless the current user request and fresh verification show they address the active bug. Keep active task/checklist state in `docs/investigations/loader-todo.md`.

# Dev server URL
https://vanilla-3dtiles.localhost:3000

bun scripts/kill-stale-agent-browsers.mjs --kill-all
This command kills all agent-browsers; use it only if needed.
This also runs automatically, so stale agent-browsers will be removed periodically. If an agent-browser instance stops responding, start another instance.
