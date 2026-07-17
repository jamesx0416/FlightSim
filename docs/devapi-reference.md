# DevApi Reference

The browser API is `window.__DevApi`. Prefer DevApi calls over synthetic UI gestures when equivalent API functionality exists. When adding a user-facing viewer capability, add or update the matching `__DevApi` method in the same change.

## Basics

- `ready()` waits for the full viewer runtime: `await window.__DevApi.ready()`.
- `status()` returns current load/runtime counts: `window.__DevApi.status()`.
- `help()` lists examples and methods: `window.__DevApi.help()`.
- `schema()` lists supported options/kinds: `window.__DevApi.schema()`.
- `report()` returns a broad debug report: `window.__DevApi.report()`.
- `reset(options?)` clears transient state; use cold-and-dark startup state with `window.__DevApi.reset({ coldAndDark: true })`.

## Discovery And Inspection

- `find(query, options?)` searches nodes/components/gauges/variables/diagnostics: `window.__DevApi.find("baro")`.
- `list(options?)` lists structured records: `window.__DevApi.list({ kind: "gauges" })`, `list({ kind: "animationTriggers" })`, `list({ kind: "nodeAnimations" })`.
- `list({ kind: "canonicalVisuals", filter?, limit? })` lists canonical state-to-animation/visibility/material bindings, canonical-backed compiled MSFS bindings, and current output values.
- `list({ kind: "state", filter?, limit? })` lists canonical engine state keys, definitions, and current selected entries: `window.__DevApi.list({ kind: "state", filter: "surfaces" })`.
- `list({ kind: "commands", filter?, limit? })` lists canonical engine command types and payload examples: `window.__DevApi.list({ kind: "commands", filter: "apu" })`.
- `checkComponent(target)` inspects a component/interaction match: `window.__DevApi.checkComponent("PUSH_AP_MASTER")`.
- `checkMaterial(target, options?)` inspects scene materials: `window.__DevApi.checkMaterial("PUSH_OVHD_HYD_ENG1PUMP_SEQ1")`.
- `checkGauge(key?, options?)` inspects a VCockpit gauge and can include a screenshot: `window.__DevApi.checkGauge("mcdu", { screenshot: true })`.
- `inspectWasm(key?, options?)` fetches and compiles a resolved gauge `.wasm` for imports/exports without native MSFS ABI execution: `await window.__DevApi.inspectWasm("systems", { source: "SystemsHost" })`.
- `diagnostics(options?)` filters loader/runtime diagnostics: `window.__DevApi.diagnostics({ severity: "warning", includeGauges: true })`.
- `perf()` returns FPS/renderer/runtime performance data: `window.__DevApi.perf()`.

## Package Asset Cache

- `assetCache.snapshot()` reports package revisions/version checks, behavior XML document counts, DDS range hits and misses, and package/XML resource transfer totals: `window.__DevApi.assetCache.snapshot()`.
- `assetCache.refreshPackageVersions()` rechecks loaded package roots. If a revision changed, parsed behavior documents and DDS ranges are invalidated; reload the viewer to rebuild compiled behavior state: `await window.__DevApi.assetCache.refreshPackageVersions()`.
- `assetCache.clearDdsRanges()` clears only the app-managed IndexedDB DDS range cache: `await window.__DevApi.assetCache.clearDdsRanges()`.
- In immutable mode, a warm reload can still show cached XML `fetch()` entries in DevTools. `transferBytes: 0` in `assetCache.snapshot().data.resources.xml` confirms that they did not revalidate or transfer response bodies.

## Runtime State

- `readVar(name, unit?)` reads a runtime variable. Mapped SimVars and LVars
  read through canonical engine compatibility aliases first:
  `window.__DevApi.readVar("A:SPOILERS HANDLE POSITION")`.
- `writeVar(name, value, unit?)` writes a runtime variable. Mapped SimVars and
  LVars also update canonical engine state through the compatibility layer:
  `window.__DevApi.writeVar("L:TEST_SWITCH", 1)`.
- `readState(key)` reads canonical engine state: `window.__DevApi.readState("propulsion.apu.rpm.percent")`.
- `writeState(key, value, unit?)` writes canonical engine state with runtime provenance: `window.__DevApi.writeState("surfaces.flaps.target.ratio", 0.5, "ratio")`.
- `dispatchCommand(type, payload?)` dispatches a listed canonical engine command and returns dispatch metadata. Unknown command types fail: `window.__DevApi.dispatchCommand("surfaces.setTarget", { id: "flaps", ratio: 0.5 })`.
- `checkParam(names)` checks generic parameter presets: `window.__DevApi.checkParam(["gear", "flaps", "spoilers", "parkingBrake"])`.
- `setParam(name, value, unit?)` writes a generic parameter preset: `window.__DevApi.setParam("spoilers", 50, "percent")`.
- `keyEvent(name, args?)` invokes a simulator key event: `window.__DevApi.keyEvent("GEAR_DOWN")`.
- `bridgeCall(name, args?)` invokes a bridge/input-event call: `window.__DevApi.bridgeCall("InputEvent_Push_Long", [1, 1])`.
- `events(options?)` reads recent key/html/sound/effect/bridge/interaction events: `window.__DevApi.events({ kind: "html", limit: 5 })`.
- `watch(targets, options?)` samples variables over time: `await window.__DevApi.watch(["A:GEAR HANDLE POSITION"], { durationMs: 1000 })`.

## Actions

- `interactions.list({ filter?, limit? })` returns source-qualified targets, proven operations and channels, availability, localized presentation, current value, unit, and explicit diagnostics for metadata the compiler could not prove.
- `interactions.describe(target)` returns the complete compiled interaction metadata, binding variants, routes, timing, source provenance, localized presentation, blockers, current value, and source/contract diagnostics. Use the qualified ID when an authored ID is ambiguous.
- `interactions.press(target, selector?)` performs one authored press/release lifecycle: `await window.__DevApi.interactions.press("PUSH_AP_MASTER")`.
- `interactions.hold(target, selector?)` and `interactions.release(target)` own a hold by target. Conflicting work fails with `TARGET_BUSY`.
- `interactions.turn/increase/decrease(target, options)` execute authored detents: `await window.__DevApi.interactions.increase("KNOB_HEADING", { steps: 3 })`.
- `interactions.adjust(target, { delta, unit? })` and `interactions.set(target, { value, unit? })` preflight exact reachability before mutation. They prefer an authored Set route, otherwise converge through authoritative detents, settle on the simulator scheduler, and verify the exact observed result. Failures distinguish incompatible units, unknown or unreachable values, no progress, cycles, cancellation, and target loss.
- `interactions.on/off/toggle` are capability checked. `on` and `off` may use a readable authored toggle route only when the resulting state can be verified.
- `interactions.dispatch(target, action)` preserves the supplied canonical action fields, including source, phase, pointer ID, channel, axis, axis value, delta, drag percentage, steps, direction, value, unit, and timestamp. It rejects unauthored semantic variants instead of guessing.
- `interactions.active()` returns each running or held target with operation, source, lifecycle, start time, and cancellation status. `cancel(target)` and `cancelAll()` request cancellation through the same lifecycle.
- `interactions.history({ limit? })` returns the bounded persistent logical-action history. `interactions.trace.enable()`, `snapshot()`, and `export()` control the disabled-by-default detailed in-memory trace. Export returns a timestamped JSON filename, metadata, and text without opening a file picker.
- `interactions.profiles.list/get/effective` inspect the version 2 profile store. `create`, `duplicate`, `rename`, `delete`, and `reset` manage profiles; `selectGlobal` and `selectAircraft(packageRoot, aircraftId, profileIdOrNull)` select them; `export` and validated `import` round-trip the complete store.
- `interactions.settings.get()` and `interactions.settings.set({ interactionMode, showHighlights, showTooltips })` read or update cockpit interaction presentation. Fresh storage defaults to Legacy mode; Lock mode keeps complex authored targets captured while Primary is held.

Use the profile and interaction APIs for deterministic automation. Use real browser gestures only when validating physical input routing, pointer capture, camera arbitration, or the Settings capture workflow.

## Waiting And Chaining

- `waitFor(condition, timeoutMs?)` waits for observable state instead of using fixed sleeps. Common waits: `await window.__DevApi.waitFor({ kind: "gaugesReady", captured: true }, 45000)`, `waitFor({ kind: "varChanged", var: "A:SPOILERS HANDLE POSITION", from: before }, 5000)`, `waitFor({ kind: "interactionExecuted", sequenceAbove: before }, 5000)`.
- For event chains, capture the previous event `sequence` and pass `sequenceAbove` so stale events do not match: `const before = window.__DevApi.events({ kind: "html", limit: 1 }).data.html.at(-1)?.sequence ?? 0; await window.__DevApi.interactions.press("PUSH_MCDUL_MENU"); await window.__DevApi.waitFor({ kind: "event", eventKind: "html", name: "A320_Neo_CDU_1_BTN_MENU", sequenceAbove: before }, 5000)`.

## Camera, Settings, And Visuals

- `camera.enterCockpit()` / `camera.exitCockpit()` switch cockpit view: `await window.__DevApi.camera.enterCockpit()`.
- `camera.getPose()` / `camera.setPose(pose)` inspect or set camera pose: `window.__DevApi.camera.setPose({ position: [0, 1, 2] })`.
- `camera.frame(target)` frames a scene target: `window.__DevApi.camera.frame("PUSH_AP_MASTER")`.
- `settings.get()` / `settings.set(settings)` inspect or update viewer settings: `await window.__DevApi.settings.set({ exteriorInterior: "off" })`. Load-time settings such as `skipGaugeSettingSeed` are saved through the settings/profile path and take effect on the next load.
- `screenshot(options?)` captures viewport/gauge imagery: `window.__DevApi.screenshot({ target: "viewport" })`.
- `visualCheck(target?)` returns visual inspection data: `window.__DevApi.visualCheck("mcdu")`.
- `highlight(target, options?)` highlights a scene target: `window.__DevApi.highlight("LEVER_FLAPS", { durationMs: 1000 })`.
- `bench.startup()`, `bench.cockpitLod0(options?)`, `bench.all(options?)`, `bench.history(options?)`, and `bench.clearHistory()` run or inspect benchmarks: `await window.__DevApi.bench.cockpitLod0()`.

## Gauge Notes

Use `status().counts.capturedCapturableGauges` versus `capturableGauges` for visual readiness.
Backend-only `NO_TEXTURE` hosts count as `backendOnlyGauges`, not failed captures.
Gauge keys can repeat across VCockpit surfaces, so pass `surface` or `source` from `list({ kind: "gauges" })` when needed.
Bridge-backed gauge `supportedHostServiceCalls` are browser-host shims, not native WASM ABI execution.

## Canonical Cold-Start Checks

Use canonical state and command APIs for generic systems checks before synthetic cockpit interaction:

```js
await window.__DevApi.ready()
window.__DevApi.list({ kind: "commands", filter: "electrical" })
window.__DevApi.list({ kind: "state", filter: "propulsion.engine.1" })
window.__DevApi.dispatchCommand("electrical.battery.set", { enabled: true })
window.__DevApi.dispatchCommand("electrical.consumer.setSwitch", {
  id: "fuel-pump-1",
  enabled: true,
})
window.__DevApi.dispatchCommand("fuel.pump.setSwitch", { index: 1, enabled: true })
window.__DevApi.dispatchCommand("fuel.valve.setSwitch", { index: 1, open: true })
window.__DevApi.dispatchCommand("propulsion.engine.setStarter", {
  index: 1,
  enabled: true,
})
window.__DevApi.watch(
  [
    "electrical.bus.main.powered",
    "fuel.pump.pump-1.active",
    "fuel.engine.1.available",
    "propulsion.engine.1.combustion",
    "propulsion.engine.1.n1.percent",
    "propulsion.engine.1.generator.available",
  ],
  { durationMs: 2000 }
)
```
