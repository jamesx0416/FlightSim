# Agent Instructions

**Important:** Do not implement, exit, or add anything that is heuristic or aircraft-specific. All bug fixes and changes must be generic MSFS loader fixes that apply broadly and authoritatively, not patches tailored to a specific aircraft.

Continue implementation until everything in `stock-support-todo.md` that is in scope for this repo is either checked off or explicitly documented as blocked with a reason.

Always use `bun` as the package manager for this project unless told otherwise.

All viewer capabilities should be available through the browser API, `window.__DevApi`; agents should prefer it over synthetic UI gestures when equivalent API functionality exists. When adding a user-facing viewer capability, add or update the matching `__DevApi` method in the same change. See `docs/devapi-reference.md` for callable methods, examples, wait/chaining patterns, and gauge notes.

# Dev server URL
https://vanilla-3dtiles.localhost:3000

bun scripts/kill-stale-agent-browsers.mjs --kill-all
This command kills all agent-browsers, use only if you need too.
This also runs automaticly, so stale agent-browsers will be removed after 10 mins.
