# Agent Instructions

The strategic direction is a simulator-agnostic flight simulation engine with MSFS as the first aircraft/package adapter. MSFS loader/runtime work remains important, but it serves the engine and adapter roadmap.

**Important:** Do not implement, exit, or add anything heuristic or aircraft-specific. Engine, adapter, compatibility, loader, and runtime changes must be generic and authoritative, not patches tailored to one aircraft.

Always use `bun` as the package manager for this project unless told otherwise.

Heuristic or aircraft-specific tests are allowed for investigation only. Landed fixes must be generic and verified without aircraft-specific patches.

Use `aircrafts/` package data as test fixtures. Do not patch fixture package data to fix engine, adapter, loader, or runtime behavior unless explicitly asked.

Prefer canonical engine concepts in new work:

- `src/sim/engine/` owns simulator state, commands, subsystems, scheduler, canonical aircraft definitions, control-surface animation state such as flaps/spoilers, and future physics.
- `src/msfs/` owns MSFS loading and compatibility surfaces such as SimVars, LVars, RPN, key events, gauges, and MSFS behavior translation.
- Do not leak MSFS-shaped APIs into the engine core when a domain API can express the behavior.
- Use "canonical aircraft definition" for normalized aircraft data in user-facing docs.

All viewer capabilities should be available through the browser API, `window.__DevApi`; agents should prefer it over synthetic UI gestures when equivalent API functionality exists. When adding a user-facing viewer capability, add or update the matching `__DevApi` method in the same change.
When a requested verification can be run through `window.__DevApi`, run it directly and report the result instead of asking the user to run it, unless local browser/API access is blocked.
See `docs/devapi-reference.md` for callable methods, examples, wait/chaining patterns, and gauge notes.

Use `NOTES.md` for durable investigation observations, rejected experiments, and useful-but-not-active evidence. Do not turn notes into behavior changes unless the current user request and fresh verification show they address the active bug. Keep active task/checklist state in `docs/investigations/loader-todo.md`.

Future todo(Do not do this unless user asks): Continue implementation until everything in `docs/investigations/loader-todo.md#stock-support-todo` that is in scope for this repo is either checked off or explicitly documented as blocked with a reason. Treat that checklist as MSFS adapter/compatibility work serving the engine direction.

# Dev server URL

https://vanilla-3dtiles.localhost:3000

`bun scripts/kill-stale-agent-browsers.mjs --kill-all`

This command kills all agent-browsers; use it only if needed. It also runs automatically, so stale agent-browsers will be removed periodically. If an agent-browser instance stops responding, start another instance.

## Tips
- For routine checks, use bun typecheck, bun lint, and focused tests instead of bun run build
- src/main.ts and src/msfs/runtime.ts are repeatedly re-read and large; use targeted symbol/search reads or known line ranges instead of broad sed scans.
- When testing viewer or behavioural changes, assume dev server is running and test changes with `window.__DevApi`.
- As this codebase currently has 0 users, consider and suggest breaking changes(devapi formats/structures, etc.) if it benefits in code reduction, clean code, and future development. The user must approve before breaking changes are applied.
- Run the whole test suite instead of focused tests
