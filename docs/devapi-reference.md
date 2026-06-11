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
- `list({ kind: "state", filter?, limit? })` lists canonical engine state keys, definitions, and current selected entries: `window.__DevApi.list({ kind: "state", filter: "surfaces" })`.
- `list({ kind: "commands", filter?, limit? })` lists canonical engine command types and payload examples: `window.__DevApi.list({ kind: "commands", filter: "apu" })`.
- `checkComponent(target)` inspects a component/interaction match: `window.__DevApi.checkComponent("PUSH_AP_MASTER")`.
- `checkMaterial(target, options?)` inspects scene materials: `window.__DevApi.checkMaterial("PUSH_OVHD_HYD_ENG1PUMP_SEQ1")`.
- `checkGauge(key?, options?)` inspects a VCockpit gauge and can include a screenshot: `window.__DevApi.checkGauge("mcdu", { screenshot: true })`.
- `inspectWasm(key?, options?)` fetches and compiles a resolved gauge `.wasm` for imports/exports without native MSFS ABI execution: `await window.__DevApi.inspectWasm("systems", { source: "SystemsHost" })`.
- `diagnostics(options?)` filters loader/runtime diagnostics: `window.__DevApi.diagnostics({ severity: "warning", includeGauges: true })`.
- `perf()` returns FPS/renderer/runtime performance data: `window.__DevApi.perf()`.

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

- `click(target, options?)` executes a cockpit interaction; stock mouse variables can be passed with `mouseEvent`, `inputType`, `relativeX/Y/Z`, and `dragPercent`: `await window.__DevApi.click("LEVER_FLAPS", { mouseEvent: "WheelUp" })`.
- `release(target)` releases a held/callback interaction: `window.__DevApi.release("PUSH_STARTER")`.
- `turn(target, options)` repeats wheel-style rotary input: `await window.__DevApi.turn("KNOB_HEADING", { direction: "up", steps: 3 })`.
- `drag(target, options?)` runs stock drag/callback phases (`Lock`, `LeftSingle`, `LeftDrag`, `LeftRelease`, `Unlock`): `await window.__DevApi.drag("LEVER_THROTTLE", { axis: "y", start: 0, end: 1 })`.
- `input.pointer(event)` sends real viewer pointer input, including right-button cockpit drags with `button: 2`: `window.__DevApi.input.pointer({ type: "down", x: 500, y: 300, button: 2 })`.
- `input.key(code, options?)` sends keyboard input: `window.__DevApi.input.key("KeyL", { type: "press" })`.
- `input.wheel(deltaY, options?)` sends wheel input: `window.__DevApi.input.wheel(-120, { x: 500, y: 300 })`.

## Waiting And Chaining

- `waitFor(condition, timeoutMs?)` waits for observable state instead of using fixed sleeps. Common waits: `await window.__DevApi.waitFor({ kind: "gaugesReady", captured: true }, 45000)`, `waitFor({ kind: "varChanged", var: "A:SPOILERS HANDLE POSITION", from: before }, 5000)`, `waitFor({ kind: "interactionExecuted", sequenceAbove: before }, 5000)`.
- For event chains, capture the previous event `sequence` and pass `sequenceAbove` so stale events do not match: `const before = window.__DevApi.events({ kind: "html", limit: 1 }).data.html.at(-1)?.sequence ?? 0; await window.__DevApi.click("PUSH_MCDUL_MENU"); await window.__DevApi.waitFor({ kind: "event", eventKind: "html", name: "A320_Neo_CDU_1_BTN_MENU", sequenceAbove: before }, 5000)`.

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
