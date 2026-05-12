# Agent Instructions

**Important:** Do not implement, exit, or add anything that is heuristic or aircraft-specific. All bug fixes and changes must be generic MSFS loader fixes that apply broadly and authoritatively, not patches tailored to a specific aircraft.

Continue implementation until everything in `stock-support-todo.md` that is in scope for this repo is either checked off or explicitly documented as blocked with a reason.

Always use `bun` as the package manager for this project unless told otherwise.

All possible things in the viewer should be able to be done by the API. The browser API is `window.__DevApi`; agents should prefer it over synthetic UI gestures when equivalent API functionality exists. When adding a new user-facing viewer capability, add or update the matching `__DevApi` method in the same change so agents can do anything a user can do.

For cockpit/gauge verification, wait for settled state through DevApi instead of sampling immediately after entering the cockpit. Use `await window.__DevApi.waitFor({ kind: "gaugesReady", captured: true }, 45000)` when the check depends on loaded and captured VCockpit gauges.

For behavior-trigger checks, use `window.__DevApi.list({ kind: "animationTriggers" })` to inspect compiled stock `AnimationTriggers` bindings and `window.__DevApi.events({ kind: "effect", limit: 10 })` or `window.__DevApi.events({ kind: "sound", limit: 10 })` to inspect runtime trigger dispatch.

For generic mouse-interaction checks, pass stock mouse variables through `window.__DevApi.click(target, options)`: `mouseEvent` maps to `(M:Event)`, and `inputType`, `relativeX`, `relativeY`, `relativeZ`, and `dragPercent` map to their matching numeric `M:` variables. For example, `await window.__DevApi.click("LEVER_FLAPS", { mouseEvent: "WheelUp" })`.

For stock drag/callback interaction checks, prefer `window.__DevApi.drag(target, options)` over manually sequencing events. It emits `Lock`, `LeftSingle`, repeated `LeftDrag`, `LeftRelease`, and `Unlock` with configurable `axis`, `start`, `end`, `startPercent`, `endPercent`, `steps`, and `inputType`.

# Dev server URL
https://msfs-combined-375b8e3b-fresh-local.vanilla-3dtiles.localhost:3000

bun scripts/kill-stale-agent-browsers.mjs --kill-all
This command kills all agent-browsers, use only if you need too.
This also runs automaticly, so stale agent-browsers will be removed after 10 mins.
