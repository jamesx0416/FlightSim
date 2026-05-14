# Aircraft Loader Master TODO

This is the master planning document for the loader/runtime/viewer work in this repo.

It consolidates:
- general loader roadmap work
- current active problems
- viewer/runtime issue tracking
- stock XML / CFG support tracking

## Reference Order

Use sources in this order:

1. Official MSFS SDK schemas, docs, and exporter/plugin code.
2. Direct evidence from built package data imported by this repo.
3. Reverse-engineered importers only as secondary corroboration.

Secondary corroborating reference currently in use:

- `bestdani/msfs2blend`
  - GitHub: `https://github.com/bestdani/msfs2blend`
  - Relevant file: `io_msfs_gltf.py`
  - Use only to confirm patterns seen in built assets and SDK/exporter material.

## Current Problems

These are the current high-priority problems on the active A320/A330 fixture path.

### 1. A320 Wing Structure Issue

The A320 still looks structurally wrong in the wing area.

Current strongest lead:
- the main wing skin is now mostly correct; the remaining visible defect is the floating under-wing support / fairing attachment chain rather than the whole wing surface
- the old `X180 * bind * X180` experiment is explicitly rejected as heuristic: it helped a narrow subset, but it is not documented by MSFS and it broke other left-side skinned parts
- current generic direction is to treat rigid one-bone MSFS attachment skins as a distinct loader class and keep narrowing the remaining floating-part transform/bind mismatch from there
- the A32NX flap/wing decal clipping is a separate renderer/material issue: the affected `METALFLAPS` geometry uses `ASOBO_material_blend_gbuffer`, is authored as a geometry decal rather than an ordinary physical flap surface, and uses skin weights that diverge from the sibling `WINGS` receiver during flap animation; the A330 fixture does not have this flap decal structure

### 2. Remaining Engine Visual Mismatch

The engine spin is much better than before, but the fan/cone relationship can still look slightly wrong.

Current hypothesis:
- remaining runtime animation fidelity issue rather than the old multi-state visibility failure

### 3. A320 Floating Canoe / Fairing Attachment

The A320 floating wire / fairing attachments now have a generic loader fix.

Current finding:
- this is no longer the whole-wing inversion problem; the main wing surfaces are broadly correct
- the confirmed front-view floaters were `WIRE_LEFT`, `WIRE_RIGHT`, and `C_WIRE`
- those wires are translated multi-bone skins driven by gear/suspension chains
- their `POSITION` data is already authored in aircraft/model space, while Three/glTF-style inverse-bind handling adds a second root translation
- the MSFS SDK explicitly says inverse-bind matrices are ignored for skins
- the loader now reconstructs skin rest state from the assembled joint graph and resets skinned mesh object/bind transforms to identity instead of trusting shipped inverse-bind accessors
- JS REPL checks on the A320 fixture verified the normalized wire bounds match raw authored bounds; the current A330 fixture has no translated skinned mesh nodes

### 4. Interior Fuselage / Cockpit Mesh Overlap

The interior view inside the A320 fuselage still shows broken overlapping mesh sheets instead of a clean shell/window assembly.

Current strongest lead:
- this looks like a transform / duplicate-shell / inner-versus-outer mesh-space problem rather than a material-only transparency issue
- cockpit glazing and nearby interior shell pieces appear to be intersecting or stacked in the wrong space
- this should be investigated as a generic importer/skinning/transform issue, not as an aircraft-specific cockpit patch

### 5. MSFS-Native Skinning Architecture

The loader now has a generic MSFS-native rest/bind path, but older targeted compatibility helpers remain.

Current strongest lead:
- MSFS docs say inverse-bind matrices are ignored
- the current generic path reconstructs rest-pose bone inverses from the assembled joint graph and clears skinned mesh object/bind transforms
- keep validating this against broader stock and third-party packages before removing older narrow compatibility helpers

### 6. Broader Stock Coverage Is Still Incomplete

Many downloaded stock XML families are not yet exercised or verified on the current A320/A330 fixture path.

This is a completeness gap, but not the most urgent visible problem on the current routes.

## Recently Resolved

### 1. Direct-View Lighting Washout

Fixed generically.

Result:
- the direct-view washout was not an aircraft-specific material quirk
- the remaining mismatch came from divergence between the legacy WebGL material path and the WebGPU/node-material path
- the viewer now boots through a shared renderer stack order: real WebGPU, then `WebGPURenderer({ forceWebGL: true })`, then legacy `WebGLRenderer` only as an emergency fallback

### 2. WebGPU Wing / Reflection Jitter

Fixed generically.

Result:
- the WebGPU shimmer came from compressed RG normal maps not using the repo's existing WebGPU decode/material path
- wiring the dormant WebGPU compressed-normal path removed the reflection/wing instability without aircraft-specific logic

## Viewer / Runtime Issues

These are the current aircraft-viewer issues that still need generic MSFS loader or renderer fixes.

### 1. A320 Wing / Structural Transform Problem

- Reproduce the flipped or malformed wing on the A320.
- Check optimized primitive metadata, transforms, and shared-accessor behavior.
- Confirm whether the issue is another missing `ASOBO_primitive` rule, transform-space conversion, or visibility/LOD problem.
- Current finding:
  - the A320 model XML uses the documented 12-node `NodeAnimation type="WingFlex"` layout
  - `flight_model.cfg` supplies documented `wingflex_scalar = 0.75` and `wingflex_offset = -0.25`
  - the importer preserves the `NodeAnimation` block and the runtime binds it generically
  - the exact WingFlex deformation math is not published in the SDK docs; the prior additive transform approximation is disabled rather than guessing
- Fix it generically.

### 2. External Helper Visibility In Flight

- Reproduce the hanging GPU cord and any similar external-helper artifacts.
- Check model-behavior visibility, material invisibility, and any package/config metadata that should hide ground equipment in flight.
- Do not hand-remove a specific helper; find the generic visibility contract.
- Fixed generically:
  - nested `DefaultTemplateParameters` / `OverrideTemplateParameters` are now preserved during behavior traversal
  - stock `ASOBO_GT_Update` bindings now execute in the runtime
  - stock `ASOBO_GT_Helper_Recursive_ID` now expands engine visibility subtemplates
  - node visibility now resolves case-insensitively, which fixed XML `NODE_ID` versus glTF node-name casing mismatches
  - stock `ASOBO_FuelHose_InteractivePoint_Template` now emits a visibility binding for the target node using `A:INTERACTIVE POINT OPEN:<ID>`, which the SDK defines as hose/cable deployment percentage for fuel-hose interactive points
- Verified result: `GROUND_GPUPIPE` / `GROUND_GPUPipe` is now hidden in the live A320/A330 viewer instead of hanging out in flight.

### 3. Window Transparency / Opacity Handling

- Reproduce the rectangular window alpha issue on the A330.
- Audit material alpha mode, alpha cutoff, transparent/decal handling, DDS alpha preservation, and any window-specific MSFS material extensions.
- Check whether other opacity-related metadata is being dropped or reinterpreted incorrectly.
- Fixed generically:
  - materials with official `extras.ASOBO_material_code = "Porthole"` now force transparent window treatment when the built glTF omitted `alphaMode`
- Verified result: `A339_HUBLOT` and the A320 `hublots` material now load as transparent materials instead of opaque alpha squares.

### 4. Engine Spin / Oscillation

- Reproduce the engine/fan oscillation or glitch.
- Check imported animations, runtime bindings, and whether the current animation evaluation is using the right source channel/value space.
- Confirm whether MSFS behavior variables or prop/fan visibility rules are partially implemented and causing the visual glitch.
- Fixed generically in part:
  - engine visibility templates now compile through recursive helper expansion
  - only the expected still/slow/blur fan state is visible at a time instead of all of them rendering simultaneously
  - `ANIM_DELTA` is now honored in the runtime, so delta-style turbine animations accumulate instead of resetting to the per-frame increment
  - documented animation `<Lag>` values are now honored in the runtime
- Remaining check:
  - verify whether any residual oscillation is now purely from the demo runtime host values rather than missing behavior-template expansion
  - investigate the remaining cone/fan mismatch where the spinner/cone appears to drift at a different speed or direction from the fan state

### 4b. Landing Gear Compression / Ground Contact Behavior

- Reproduce the gear posture issue where the gear visually tilts/flattens incorrectly relative to ground contact.
- Current finding:
  - the aircraft model XML supplies direct gear/door animations through local `L:A32NX_GEAR_*` variables
  - the current demo runtime host does not provide those `L:` variables, so they default to `0`
  - stock tire templates (`ASOBO_GEAR_Center_Tire_Template`, `ASOBO_GEAR_Left_Tire_Template`, `ASOBO_GEAR_Right_Tire_Template`) are still unresolved, so wheel blur/still and any stock tire behavior are incomplete
- Investigate whether the missing posture is driven by:
  - missing stock Asobo gear templates
  - missing custom local vars that would normally come from aircraft systems code
  - additional ground-contact / suspension metadata not yet interpreted by the runtime

### 5. Reflection / Width Distortion

- Reproduce the “plane looks wider straight on” reflection issue.
- Check whether the problem is renderer FOV/camera, environment mapping, normal interpretation, or material roughness/metalness handling.
- Verify whether WebGL and WebGPU differ after both exposures were normalized to `1`.
- Additional WebGPU-specific issue:
  - while the camera moves, wing reflections appear to shimmer or glitch
  - investigate whether this is environment-map resolution, PMREM/backend differences, normal-map interpretation, or a WebGPU material-path instability

### 5b. A320 Floating Canoe / Fairing Piece

- Reproduce the remaining floating canoe / fairing attachment on the A320 wing-root area.
- Confirm the exact object family still detached in the live viewer.
- Check whether the remaining error is on the normal skinned path, shared accessor/bind data, or another transform-space mismatch.
- Do not revive the removed rigid one-bone reduction path unless an authoritative generic rule supports it.

### 5c. Interior Fuselage / Cockpit Mesh Breakage

- Reproduce the broken overlapping mesh sheets visible from inside the fuselage / cockpit window area.
- Check whether the issue is duplicate inner/outer shell geometry, incorrect transform accumulation, or a skin/bind mismatch on interior assemblies.
- Distinguish mesh-space breakage from window material/transparency handling.
- Fix it generically.

### 5d. Cockpit Shell / Instrument Runtime Staging

- Do not land full cockpit/instrument support as one step.
- Stage the work generically in this order:
  - optional cockpit/interior glTF loading
  - evaluate `ImageBitmap`-based texture loading on applicable non-DDS paths and measure whether it reduces first-entry cockpit texture decode/upload stalls without changing asset semantics
  - prototype additive `KHR_texture_basisu` / `KTX2` loader support while keeping the existing DDS path intact
  - define a generic texture-conversion pipeline for any future `KTX2` rollout, including color/normal-map handling and glTF reference updates
  - benchmark cold and warm cockpit-entry timings, texture decode/upload stalls, and RAM impact before and after any `KTX2` or `ImageBitmap` texture-path change
  - treat `KTX2` as the primary near-term texture-upgrade path for this browser viewer
  - if post-`KTX2` gains are still insufficient, evaluate an `NTBC`-style browser prototype that decodes once on load and uploads standard GPU textures
  - defer `NTC` / runtime neural texture decoding in WGSL or vendor-specific native paths unless this effort is explicitly reframed as browser research rather than productization
  - generic `panel.cfg` `VCockpit` surface binding to dynamic textures
  - HTML gauge rendering onto those surfaces
  - WASM instrument handling only after the runtime/environment contract is clear
- Implementation plan for `VCockpit` surfaces and gauges:
  - Parse every `[VCockpitXX]` section from `panel.cfg` into a typed generic IR:
    - panel index and section name
    - `size_mm`
    - `pixel_size`
    - `texture`
    - `background_color`
    - `htmlgaugeXX`
    - `gaugeXX`
    - `WasmInstrumentXX`
    - any other documented fields needed to preserve layout and diagnostics
  - Resolve each `texture=` target to the corresponding cockpit material or texture slot by name, using MSFS texture/material references generically rather than hardcoded display names.
  - Create one runtime dynamic texture per resolved `VCockpit` surface, sized from `pixel_size` with `size_mm` retained for gauge layout coordinates.
  - First render a deterministic placeholder/debug pattern into each dynamic texture and bind it to the cockpit model, so surface discovery and material binding can be verified before any gauge runtime exists.
  - Add structured diagnostics for unresolved surface textures, duplicate texture names, unsupported panel entries, invalid dimensions, and missing gauge assets.
  - Keep `VCockpit` binding startup-safe by binding surfaces synchronously but loading gauge iframes asynchronously.
  - Treat gauge-side SimVar writes and key events as local-state updates plus fire-and-forget parent runtime notifications, not iframe-blocking request/response calls.
  - Count simulator host-service registration calls that only establish subscriptions or nearest-search sessions as supported no-op bridge services when the browser host has no native simulator backend.
  - Implement HTML gauge loading only after surface binding is verified:
    - resolve gauge package paths through the same package-root/dependency-root system as other aircraft assets
    - instantiate gauges in an isolated browser surface such as an iframe or equivalent sandbox
    - provide a minimal generic MSFS instrument bridge for documented simvars, local vars, events, and update ticks
    - copy or render the gauge output into the already-bound `VCockpit` dynamic texture
    - support multiple `htmlgaugeXX` entries on the same surface using documented panel coordinates and z/order rules
  - Add gauge diagnostics for missing HTML assets, unsupported JS bridge calls, blocked external resources, layout overflow, and update/render timing.
  - Treat legacy `gaugeXX` and `WasmInstrumentXX` entries as explicit unsupported/blocker diagnostics until their host/runtime contracts are designed.
  - Verify each stage on both A330 and A320 routes with cockpit opt-in enabled:
    - placeholder `VCockpit` textures visibly bind to the expected cockpit screens
    - HTML gauge surfaces render without breaking exterior startup
    - diagnostics are visible and no aircraft-specific bindings or name maps are introduced
- Current first-slice implementation:
  - cockpit LOD00 runs placeholder `VCockpit` surface binding by default; `?vcockpitSurfaces=off` disables it for comparisons.
  - `[VCockpitXX]` sections are parsed into typed surface IR with texture targets, dimensions, background color, and gauge entries.
  - placeholder `CanvasTexture` surfaces are generated from `pixel_size` and bound to cockpit materials whose names match the `panel.cfg` `texture=` target.
  - non-WASM `htmlgaugeXX` entries resolve through generic package/dependency roots and load through a serialized queued sandboxed iframe loader.
  - MSFS HTML gauge documents adapt `import-script` tags and absolute `/Pages` / `/JS` asset paths into browser-loadable iframe documents.
  - sandboxed HTML gauges get a minimal generic `BaseInstrument` / `registerInstrument` host so template-based gauges can mount visible DOM.
  - the shared runtime host now seeds generic cold-and-dark state from package `hangar.flt` sections, including `SimVars.0`, `Systems.0`, engine parameters, controls, and switches; battery/external-power interactions drive generic electrical power, bus voltage, circuit power, and brightness fallbacks without aircraft-specific node maps.
    - verified on 2026-05-10 with `tsc --noEmit` and Agent Browser on the A320 route: initial `SIM ON GROUND=1`, battery/external power/bus voltage/display brightness/engine N1 all `0`; entering cockpit and executing `PUSH_OVHD_ELEC_BAT1` raised battery, bus voltage, and DC battery bus power (`/tmp/msfs-cold-dark-a320-battery.png`).
    - default A330 livery route also reported cold-and-dark runtime host values; explicit full A330 cockpit browser navigation hung in Agent Browser during this pass, so deeper A330 interaction verification remains pending.
  - the iframe bridge provides a generic demo `simvar` backend with cold-and-dark power/brightness fallbacks plus default flight values so standalone gauges can start dark until the shared runtime reports power.
  - the iframe bridge provides generic MSFS browser-host shims for `vcockpit-panel`, `RunwayDesignator`, `Avionics.Utils`, `EmptyCallback`, `GameState`, listener handles, fast registered simvars, global vars, and dynamic `coui://html_ui` image/style URLs.
  - the iframe bridge now tracks generic host API usage and unsupported calls, preserves written SimVar/game-var values for later reads, exposes storage/listener diagnostics, and rewrites dynamic `/JS`, `/Pages`, `/html_ui`, and `coui://html_ui` resource URLs from attributes and inline CSS.
  - interaction bindings now preserve generic `WWISE_EVENT`, `WWISE_EVENT_1`, `WWISE_EVENT_2`, and normalized-time metadata, and the runtime host emits observable sound-event records on press/release through `invokeSoundEvent`.
    - verified on 2026-05-10 with `tsc --noEmit` and Agent Browser on the A320 route: `PUSH_MCDUL_1` compiled with `mcdubuttons` press/release sound metadata and executing/releasing it emitted two runtime sound events via `globalThis.__lastRuntimeHost.getSoundEvents()`.
    - browser-side playback of MSFS Wwise `.PCK` banks is not implemented; this commit adds the generic behavior/runtime sound contract and diagnostics hook rather than decoding proprietary soundbank data.
  - aircraft `sound.xml` files are imported into generic sound metadata, including declared Wwise packages and `SimVarSounds` entries with `SimVar` / `LocalVar`, `Range`, and `Requires` conditions; the runtime host emits observable sound start/stop events when those conditions cross active/inactive.
    - verified on 2026-05-10 with `tsc --noEmit` and Agent Browser on the A320 route: the selected aircraft imported `SimObjects/AirPlanes/FlyByWire_A320_NEO/sound/sound.xml` with 3 Wwise package entries and 314 SimVar-driven sound definitions; writing package-declared sound variables and ticking the runtime emitted APU, `flapsmovement`, and `slatsmovement` start events.
    - verified on 2026-05-10 with Agent Browser on the default A330 route: the selected aircraft imported `SimObjects/Airplanes/Headwind_A330neo/sound/sound.xml` with 5 Wwise package entries and 269 SimVar-driven sound definitions; writing a package-declared APU sound variable and ticking the runtime emitted APU sound start events.
    - actual browser audio playback remains blocked on Wwise `.PCK` bank decoding / playback support; current support proves the generic MSFS sound contract is imported and driven by runtime state.
  - `>H:` RPN writes now invoke a generic HTML interaction-event path instead of being stored as inert variables; the shared runtime records recent H events and broadcasts them to loaded VCockpit gauge iframes.
    - verified on 2026-05-10 with `tsc --noEmit` and Agent Browser on the A320 route: `PUSH_MCDUL_1` compiled from `(>H:A320_Neo_CDU_1_BTN_1)` to `invokeHtmlEvent`, incremented runtime `htmlEventCount`, and delivered `OnInteractionEvent` / instrument `onInteractionEvent(["A320_Neo_CDU_1_BTN_1", 0])` inside the loaded `A32NX-MCDU` iframe.
  - generic key-event interception now bridges runtime `K:`/`F:KeyEvent` events into loaded VCockpit gauges that explicitly call `Coherent.call("INTERCEPT_KEY_EVENT", ...)`, and `Coherent.call("TRIGGER_KEY_EVENT", ...)` routes gauge-originated key events back to the runtime.
    - verified on 2026-05-10 with `tsc --noEmit` and Agent Browser on the A320 cockpit route: a gauge-side `Coherent.on("keyIntercepted", ...)` listener received intercepted `A32NX.FCU_SPD_INC` with the runtime values and ignored non-intercepted `A32NX.FCU_SPD_DEC`; a gauge-side `TRIGGER_KEY_EVENT` call reached the runtime as `A32NX.FCU_HDG_INC`.
  - the generic iframe host now supplies the MSFS browser helpers needed by the A320 MCDU startup path: `InputBar`, `Utils.generateGUID`, `Avionics.Curve`, `Avionics.CurveTool`, expanded `Avionics.Utils` navigation helpers, and string game-var reads such as `FLIGHT NAVDATA DATE RANGE`.
    - verified on 2026-05-10 with `tsc --noEmit` and Agent Browser on the A320 route: after cold/dark cockpit entry and `PUSH_OVHD_ELEC_BAT1`, the MCDU iframe rendered `MCDU MENU` without iframe errors; cockpit `PUSH_MCDUL_MENU` returned to the menu and `PUSH_MCDUL_L1` opened the `A320-200` IDENT page through generic H-event delivery.
  - accessible non-WASM iframe DOM is composited into the bound cockpit `CanvasTexture` with an origin-clean SVG/canvas/text renderer so browser `foreignObject` tainting does not upload black GPU textures.
  - `?vcockpitGaugeMode=overlay` adds an experimental direct-HTML path that projects live gauge iframes over matched VCockpit material bounds instead of converting DOM into images/textures every refresh.
  - `?vcockpitGaugeMode=video` adds an experimental mesh-texture path that streams the composited VCockpit canvas through `captureStream()` into a Three `VideoTexture`, with `?vcockpitGaugeVideoFps=` controlling the stream frame rate.
  - Add an experimental `?vcockpitGaugeMode=htmlTexture` path only when native browser HTML-in-Canvas support is available:
    - upgrade to Three.js `r184+` only after verifying the existing WebGPU/WebGL renderer stack still works
    - feature-detect `drawElementImage`, `texElementImage2D`, or WebGPU `copyElementImageToTexture`
    - document that current Chromium builds may require `chrome://flags/#canvas-draw-element`
    - use the native browser path to draw/copy compatible HTML gauge content into a canvas/GPU texture, then bind it to the existing `VCockpit` material texture path
    - fall back to the current dirty-driven `CanvasTexture` compositor when the browser API is missing, incomplete, or visually incompatible with stock MSFS gauge documents
    - keep diagnostics for unsupported iframe/custom-element/SVG/font/canvas cases rather than silently switching behavior
  - `?vcockpitGaugeRasterScale=` can lower texture/video-mode hidden iframe viewports and dynamic texture dimensions generically for performance testing, while leaving overlay mode at full scale.
  - outside-view VCockpit gauge updates are disabled by default; `?vcockpitGaugeUpdateOutside=on` and the matching Settings row are available for debugging exterior-view gauge capture behavior without making it the normal path.
  - the runtime now evaluates animation and visibility bindings only when their target clip/node exists in the active scene, while still running generic update bindings so systems/behavior variables continue changing outside the cockpit view.
    - verified on 2026-05-10 with `tsc --noEmit` and Agent Browser on the A320 exterior route: cockpitPerf dropped from roughly 59 ms/frame with ~55 ms runtime work to roughly 6 ms/frame with ~2 ms runtime work after pruning inactive bindings.
  - the shared runtime host now caches repeated variable reads within each runtime tick and invalidates the cache on writes/events, avoiding repeated normalization/default fallback work across dense cockpit animation and visibility RPN.
    - verified on 2026-05-10 with `tsc --noEmit` and Agent Browser on the A320 full LOD0 cockpit route: with `?vcockpitSurfaces=off`, steady-state cockpitPerf dropped from roughly 56 ms/frame with ~52 ms runtime work to roughly 9 ms/frame with ~4.5 ms runtime work; with VCockpit surfaces enabled and cold/dark screens, steady-state was roughly 11 ms/frame with ~5 ms runtime work.
  - live texture/video capture is dirty-driven and rate-capped: the generic iframe bridge posts output-change versions for DOM mutations and Canvas2D writes, and the parent only recaptures dirty gauges/surfaces without letting per-frame iframe draws bypass `?vcockpitGaugeCaptureFps=`.
  - HTML gauge capture defaults to live refresh with adaptive generic instrument `Update()` scheduling based on SimVar/game-var dependencies, with `?vcockpitGaugeUpdateMs=` / `?vcockpitGaugeUpdateHz=` available for forced periodic iframe updates and `?vcockpitLiveGauges=off` available for a bounded first-successful-frame pass that caches captured pixels and releases hidden iframes.
  - live LOD00 verification on the A339X package captures 15 non-WASM HTML gauges without blocking LOD00 binding; WASM instruments are bridge-first only, backend `NO_TEXTURE` WASM hosts load without texture capture, and EFB host/runtime gaps remain explicitly deferred or diagnosed.
  - `?vcockpitGaugeDebug` keeps placeholder labels and gauge status overlays available for verification; the default path hides those overlays from cockpit screens.
  - binding and gauge diagnostics are exposed through `globalThis.__lastVCockpitSurfaceBinding`.
  - per-gauge capture stats now include bridge stats, script/load errors, blocked asset errors, render status, dirty/update counts, capture attempts, and last capture errors so loaded/rendered gauges, missing assets, iframe errors, deferred WASM, unsupported legacy gauges, and unsupported bridge API calls can be distinguished at runtime.
  - `window.__DevApi.list({ kind: "gauges" })` and `checkGauge()` now expose the same per-gauge bridge stats, script errors, asset/resource errors, DOM/canvas/SVG counts, dirty stats, and instrument update stats, so cockpit gauge host gaps can be audited through the public DevApi instead of private iframe globals.
    - verified on 2026-05-11 with `tsc --noEmit` and Agent Browser on the A330 cockpit route with `?cockpitPerf&vcockpitGaugeCaptureFps=4`: 13 listed gauge runtimes included `bridgeStats`, the visible synthetic WASM host reported `wasmBridge: true`, loaded HTML gauges reported runtime request/response counts with zero bridge runtime errors, diagnostics stayed at zero errors, and the sample reported about 50 FPS in the post-cockpit-load window.
    - `window.__DevApi.status().counts` now separates loaded visual gauge capture readiness from backend-only hosts: `capturableGauges` / `capturedCapturableGauges` ignore loaded `NO_TEXTURE` systems/bridge hosts, while `backendOnlyGauges` counts them explicitly; per-gauge rows also expose `capturable` and `backendOnly`.
      - verified on 2026-05-12 with `tsc --noEmit` and Agent Browser on the A320 LOD1 cockpit route: the six uncaptured gauges were all `NO_TEXTURE` backend/system hosts with no capture errors, while the visual gauge count remained 18 capturable / 18 captured.
  - `window.__DevApi.list({ kind: "inputEvents" })` exposes compiled input-event bridge binding names, with optional `filter` and `limit`, so stock XML and gauge bridge coverage can be audited through the public DevApi instead of private runtime state.
    - verified on 2026-05-11 with `tsc --noEmit` and Agent Browser: the exterior route kept zero diagnostics while schema exposed `inputEvents`, and the A330 cockpit route listed compiled `A339X_PED_ECP_*` bindings through `list({ kind: "inputEvents" })`; screenshots captured under `backups/agent-browser/devapi-input-events/`.
  - bridge-first support now creates a synthetic generic host for missing `WasmInstrument/WasmInstrument.html?...` entries on bound VCockpit surfaces, so WASM-backed HTML gauges can load as `loaded-wasm-bridge` and use the existing SimVar/key/HTML-event bridge instead of failing as unresolved host assets. Native MSFS WASM ABI execution is still explicitly diagnosed as unsupported.
    - verified on 2026-05-11 with `tsc --noEmit` and Agent Browser on the A330 cockpit route with `?cockpitPerf&vcockpitGaugeCaptureFps=4`: the visible `terronnd.wasm` ND entry loaded as `loaded-wasm-bridge` through `synthetic-msfs-wasm-instrument-host.html`, diagnostics had zero errors, and the route returned a 47 FPS sample during the post-cockpit-load window; screenshot captured to `backups/agent-browser/wasm-bridge-support/a330-synthetic-wasm-bridge.png`.
    - A320 fixture verification on the matching cockpit route requires waiting for the LOD00 upgrade to reach `gltf:interior-upgrade:ready`; after that, the visible `terronnd.wasm` ND entry also loads as `loaded-wasm-bridge` through the synthetic host with zero errors and no unsupported bridge calls.
    - the synthetic WASM host carries a `data-msfs-instrument="synthetic-wasm-bridge"` marker plus a hidden child placeholder so the capture path treats the intentionally transparent bridge placeholder as mounted instrument DOM rather than a failed/blank gauge. Verified on the A330 cockpit route: the WASM bridge entry reported `lastRenderStatus: "captured"` and `lastCaptureError: null` with zero errors.
    - backend-only `texture=NO_TEXTURE` WASM entries now load through the same serialized bridge-first host path without material binding or texture capture, so systems-style backends can receive SimVar/key/H-event bridge messages while leaving native WASM ABI execution unsupported.
    - verified on 2026-05-11 with `tsc --noEmit` and direct Chrome DevTools Protocol on the A330 cockpit route with `?cockpitPerf&vcockpitGaugeCaptureFps=4`: all four `VCockpit17` backend WASM entries loaded as `loaded-wasm-bridge`, each reported `needsCapture: false`, `lastRenderStatus: "skipped-clean"`, `wasmBridge: true`, no script/resource errors, and diagnostics had zero errors; screenshot captured to `backups/agent-browser/backend-wasm-bridge-support/a330-backend-wasm-bridge.png`.
    - WASM bridge gauge diagnostics now include `bridgeStats.wasmModuleInfo.url` for the resolved package `.wasm` file with `status: "resolved-url-only"`; the diagnostics intentionally do not compile the module or report imports/exports during normal startup. Verified on 2026-05-12 with `tsc --noEmit` and Agent Browser on the A320 LOD1 cockpit route: all six `loaded-wasm-bridge` gauges reported resolved package `.wasm` URLs, gauges loaded 24/24 with 18 captures, and the settled sample reported about 55.7 FPS.
    - `window.__DevApi.inspectWasm(key, { surface, source })` now fetches and compiles a resolved bridge-backed `.wasm` module on demand to report imports/exports without instantiating the native MSFS ABI. Normal gauge diagnostics remain `resolved-url-only` so startup performance is unchanged; once a module is inspected, the cached per-URL import/export inventory is included in gauge summaries and diagnostics. `surface` / `source` disambiguate repeated gauge keys such as `htmlgauge00`.
    - The iframe bridge now provides a generic local `fsCommBusRegister` / `fsCommBusUnregister` / `fsCommBusCall` host-service shim and records those calls under `bridgeStats.supportedHostServiceCalls` instead of unsupported-call diagnostics. This covers the comm-bus service family seen in inspected bridge WASM imports while keeping native WASM ABI execution deferred.
    - Generic nearest-search gauge calls now treat `Coherent.call("SEARCH_NEAREST", ...)` as a supported empty-result host service, matching the existing browser-host no-op nearest-search session/filter shims when no native simulator database backend is available. Supported nearest-search and traffic host services are recorded under `bridgeStats.supportedHostServiceCalls`.
    - Active verification on 2026-05-14 with Agent Browser and `window.__DevApi` inspected the A330 LOD0 bridge WASM set after cockpit load. Five modules compiled through `inspectWasm()` without native ABI instantiation, including `systems.wasm` with 30 imports / 14 exports, `fadec-a339x.wasm` with 38 imports / 2124 exports, `extra-backend-a339x.wasm` with 43 imports / 2124 exports, and both `terronnd.wasm` surfaces with 40 imports / 1844 exports. Re-running `fbw.wasm` with a larger `maxBytes` compiled the 1,224,694-byte module and reported 48 imports / 1842 exports. The route stayed at 24/24 loaded gauges, 18/18 captured capturable gauges, six `loaded-wasm-bridge` gauges, no unsupported bridge calls, and zero gauge issue groups. Native MSFS WASM ABI execution remains intentionally unimplemented and diagnosed as not executed.
  - legacy gauge hosting, native WASM ABI execution, and fuller simulator/instrument API bridge coverage remain intentionally deferred.
- Keep the path opt-in until progressive aircraft loading exists, so cockpit work does not become the default startup-time regression while exterior iteration is still the main workflow.
- Use the official `cockpit.cfg` / `panel.cfg` docs as the contract, not A320-specific HTML names or hardcoded instrument layouts.

### 6. Missing Stock Templates / Includes

- Reproduce and inventory the remaining unresolved stock Asobo includes and templates.
- Distinguish between:
  - missing official package roots that are not mounted in this environment
  - missing compiler coverage for stock templates that could be supported generically without those roots
- Updated finding:
  - public stock Asobo XMLs from the official Template Explorer are now downloaded locally and mounted by default from `/vendor/msfs-stock/`
  - package-level `Behavior include Asobo\\... could not be resolved` warnings have dropped to `0`
  - the remaining stock-behavior failures are no longer root-resolution failures; they are parser/compiler gaps against stock Asobo XML syntax and template coverage
  - several official stock XMLs use template syntax such as dynamic parameterized tag names (`<#PARAM_NAME#>`) that is not plain XML and still needs broader generic preprocessing/support

### 7. Revalidate Local Stock-Template Implementations

- Once public/offline stock Asobo XMLs are mounted locally, re-check every locally implemented stock-template behavior against the official XML definitions.
- In particular, revisit:
  - `ASOBO_GT_Update`
  - `ASOBO_GT_Helper_Recursive_ID`
  - `ASOBO_FuelHose_InteractivePoint_Template`
  - stock handling template shims
  - any stock gear/tire template support added before the official XMLs are mounted
- Remove or adjust any approximation that does not match the official template contract.
- Current state:
  - the official public stock XML set is now mounted locally
  - the compiler now consumes the public stock XML path directly for the stock constructs that were previously blocking that:
    - `<Parameters Type="Default|Override">`
    - stock `Condition` / `Switch` parameter branches
    - stock `Process="Int|Float|Param"`
    - direct `<Update>` nodes
    - `ASOBO_GT_Anim` in both simvar and code forms
    - direct stock `<Animation>` nodes from the mounted Asobo templates
    - documented animation `<Lag>` values in the runtime
  - the active A320/A330 fixture routes now compile their handling animations from the mounted official templates with `builtinFallbackHits = []`
  - built-in stock shims remain only as dormant safety nets when a referenced template is genuinely absent from the mounted public XML set
  - those remaining shims were tightened against the mounted official XML definitions during this pass

### Cross-Cutting Checks

- Look for other dropped or ignored metadata that affects:
  - opacity
  - visibility
  - transforms
  - optimized primitive assembly
- Keep fixes aircraft-generic and avoid per-aircraft patches.

## General Loader Work

This section tracks the next authoritative, aircraft-generic loader work.

### Next Work

- Keep broadening authoritative RPN/operator coverage.
  - Recent passes added official MSFS stack/control operators used by model XML: `if/els`, `quit`, `case`, `?`, `d`, `p`, `r`, `sN`, `spN`, `lN`, `pN`, plus a growing set of numeric operators.
  - Next RPN work should continue from official SDK operator semantics, not from aircraft-specific trial-and-error.
  - Prioritize operators/functions that appear in official Asobo templates and built package behavior XML.

- Extend generic `ASOBO_material_*` rendering support.
  - Implement more of `ASOBO_material_blend_gbuffer`.
  - Complete `ASOBO_material_detail_map` fidelity.
  - Match the exact simulator response for `blendMaskTexture` + `blendThreshold` once the authoritative shader contract is identified.
  - Implement additional `ASOBO_material_shadow_options` behaviors where they affect runtime rendering.

- Resolve remaining livery/decal fidelity gaps.
  - Verify decal layering against `drawOrderOffset`.
  - Confirm blend/decal behavior on multiple aircraft packages.

- Tighten stock behavior include resolution.
  - Generic additional package-root support is now in place through `VITE_MSFS_ADDITIONAL_PACKAGE_ROOTS`.
  - Public stock Asobo XMLs from the official Template Explorer are now mounted locally at `/vendor/msfs-stock/`.
  - Package-level stock include resolution is working through that mounted root.
  - The compiler now supports the missing stock XML constructs that were blocking mounted public Asobo XML use in practice:
    - dynamic tag preprocessing
    - `<Parameters Type="Default|Override">`
    - stock `Condition` / `Switch` parameter-block branches
    - stock `Process="Int|Float|Param"`
    - direct `<Update ...>` compilation
    - `ASOBO_GT_Anim` simvar-driven and code-driven forms
    - direct stock `<Animation>` node compilation
    - documented animation `Lag`
  - Next step is to keep replacing remaining mirrored built-ins only when the general XML evaluator can consume the stock template family without regressions.

- Tighten stock/shared texture fallback resolution.
  - Generic additional package-root support is now in place for texture fallback lookup as well.
  - Current finding on the A320 route:
    - `../../../../texture/Glass` is the relevant shared fallback path for the missing glass maps under investigation
    - `../../../../texture/Interiors` appears in the standard fallback chain but is not implicated by the current missing A320 texture names
    - several missing `*_COMP` files are genuine dangling package-local refs and should not be treated as shared-stock-texture misses
  - Next step is to validate against real dependency packages such as `fs-base-aircraft-common`.

- Improve optimized/skinned mesh compatibility.
  - Keep using authoritative layout evidence from built assets and official exporter expectations.
  - Current implementation derives MSFS skin rest/bind state from assembled joint transforms and ignores shipped inverse-bind accessors, matching the SDK skinning note.
  - Use this to keep resolving floating attachment assemblies without reintroducing aircraft-specific half-turn patches.
  - Broaden fixture validation before deleting older narrow compatibility helpers.

- Add cockpit/instrument support in staged opt-in form.
  - Start with optional interior/cockpit shell loading, not default-on loading.
  - Then wire generic `panel.cfg` `VCockpit` surfaces to dynamic textures.
  - Add HTML-gauge rendering only after that texture path exists and can be profiled independently.
  - Treat WASM gauges as a separate runtime milestone and document blockers explicitly if the sim-host environment is unavailable.

- Broaden validation fixtures.
  - Confirm generic loader behavior on more than the current A330 and A320 packages.

## Other Generic Repo Issues

- 3D tiles material replacement plugin still does not support multi-material meshes.
  - Current failure path throws `Multiple materials are not supported yet.` in `src/plugins/TileMaterialReplacementPlugin.ts`.
- 3D tiles material replacement plugin still leaks replaced materials on dispose.
  - Current file already notes this in `src/plugins/TileMaterialReplacementPlugin.ts`; track it here so it is not lost outside the source comment.

### Current Fixture State

- Current A330 and A320 fixture imports are clean:
  - no package diagnostics on the A330 route after mounting the public stock XML root
- The remaining loader gaps are now more clearly in stock XML parsing/compiler coverage and runtime semantics, not just missing include roots.

### Current Material Focus

- `ASOBO_material_blend_gbuffer`
- `ASOBO_material_draw_order`
- `ASOBO_material_shadow_options`
- `ASOBO_material_detail_map`

## Stock Support TODO

This checklist tracks authoritative MSFS stock support work against the mounted public Asobo XML set and mirrored CFG docs.

Active checklist location:
- In this checkout, this section is the active stock-support checklist referenced by the project instructions. There is no repo-root `stock-support-todo.md` file at the moment, so update this section and [stock-support-scope.md](stock-support-scope.md) until that file is restored or intentionally split out.

Rules:
- Prefer the official mounted XML/docs over local approximations.
- Keep fixes generic and reusable across aircraft.
- Mark items done only when the loader/compiler/runtime support is implemented and verified on at least the A330 and A320 routes where relevant.
- Stock XML items can only be checked when the relevant official docs/reference pages have been read for that area and the implementation has been updated or confirmed against them.
- Reference-doc items can only be checked when they have actually been reviewed during implementation, not merely downloaded.
- No item can be checked off unless an `agent-browser` verification pass has been run on both the A330 and A320 routes, screenshots have been taken, and those screenshots indicate nothing is broken and the change likely works.
- Continue the implementation until every checklist item that is in scope for this repo is either completed and checked off or explicitly blocked with a documented reason; do not stop early just because a subset is finished.

### 1. Create A Granular Stock-Support Checklist

- [x] Create a granular stock-support checklist covering each mounted XML family and each targeted CFG file.

### 2. Implement Deeper Generic Stock Behavior Support Across Mounted Asobo XML Families

#### Core Plumbing

- [x] Support mounted stock `layout.json` for behavior-root resolution.
- [x] Mount public stock Asobo XML root by default.
- [x] Resolve stock behavior includes across mounted roots.
- [x] Support dynamic stock XML tag preprocessing.
- [x] Support `<Parameters Type="Default|Override">`.
- [x] Support parameter-block `Condition` / `Switch`.
- [x] Support `Process="Int|Float|Param"`.
- [x] Support empty RPN write sinks from blank optional template parameters.
  - The RPN compiler now treats the exact empty write token `(>)` as a stack discard, matching generated stock-template code where an optional write target expands to empty rather than to a concrete variable/event.
  - Verified with `agent-browser` on 2026-05-09:
    - A330 route `?cockpitInteractionHitboxes&cockpitPerf` compiled 734 animation bindings, 810 interaction bindings, 616 update bindings, and 456 visibility bindings with zero unsupported `(>)` diagnostics; remaining RPN diagnostics are unrelated `(M:Event)`, `:1`, and bare `{` cases.
    - A320 route `?package=/aircrafts/flybywire-aircraft-a320-neo/&aircraft=SimObjects/AirPlanes/FlyByWire_A320_NEO%23fltsim.0&cockpitInteractionHitboxes&cockpitPerf` compiled 665 animation bindings, 718 interaction bindings, 536 update bindings, and 383 visibility bindings with zero unsupported `(>)` diagnostics; remaining RPN diagnostics are unrelated `(M:Event)` and bare `{` cases.
    - Screenshots captured to `/tmp/screenshot-1778335823173.png` and `/tmp/screenshot-1778335870711.png`.
- [x] Support mouse-event RPN string comparisons used by stock `MouseRect` callback code.
  - The RPN compiler/runtime now handles quoted string literals, `M:Event` string reads, and `scmp` / `scmi` string compare operators used by official `MouseFlags` / `CallbackCode` templates.
  - Verified with `agent-browser` on 2026-05-09:
    - A330 route `?cockpitInteractionHitboxes&cockpitPerf` compiled 734 animation bindings, 811 interaction bindings, 616 update bindings, and 456 visibility bindings with zero unsupported `(M:Event)` diagnostics; remaining RPN diagnostics are unrelated `:1` and bare `{` cases.
    - A320 route `?package=/aircrafts/flybywire-aircraft-a320-neo/&aircraft=SimObjects/AirPlanes/FlyByWire_A320_NEO%23fltsim.0&cockpitInteractionHitboxes&cockpitPerf` compiled 665 animation bindings, 719 interaction bindings, 536 update bindings, and 383 visibility bindings with zero unsupported `(M:Event)` diagnostics; the only remaining RPN diagnostic is the unrelated bare `{` case.
    - Screenshots captured to `/tmp/screenshot-1778336257793.png` and `/tmp/screenshot-1778336301535.png`.
- [x] Support generic paired directional-axis interaction fallback code.
  - Interaction fallback compilation now preserves both positive and negative axis code paths when a stock template provides both, selecting the positive path for `M:Event == WheelDown` and the negative path otherwise instead of dropping one direction.
  - Verified with `agent-browser` on 2026-05-10 using the A320 route: `LEVER_FLAPS` compiled to `(M:Event) 'WheelDown' scmp 0 == if{ (>K:FLAPS_DECR) } els{ (>K:FLAPS_INCR) }`; executing a normal click moved `A:FLAPS HANDLE PERCENT`, left/right flap simvars, and `l_flap_percent_key` / `r_flap_percent_key` animation values to 25, then executing with `mouseEvent: 'WheelDown'` returned them to 0.
- [x] Expose generic mouse interaction variables to DevApi-triggered interaction RPN.
  - `__DevApi.click()` now accepts `mouseEvent`, `inputType`, `relativeX`, `relativeY`, `relativeZ`, and `dragPercent`, and the runtime maps those to stock `M:Event`, `M:InputType`, `M:RelativeX/Y/Z`, and `M:DragPercent` reads before falling back to simulator variables.
  - Verified with Agent Browser on 2026-05-12 using the A320 cockpit route: `__DevApi.click("LEVER_FLAPS", { mouseEvent: "WheelUp" })` moved `A:FLAPS HANDLE PERCENT` from `0` to `43.1375`, and `__DevApi.click("LEVER_FLAPS", { mouseEvent: "WheelDown" })` returned it to `0` with zero errors.
- [x] Expose a generic DevApi drag gesture for stock callback interactions.
  - `__DevApi.drag()` emits the stock mouse callback sequence `Lock`, `LeftSingle`, repeated `LeftDrag`, `LeftRelease`, and `Unlock`, supplying configurable `M:InputType`, `M:RelativeX/Y/Z`, and `M:DragPercent` values through the same runtime interaction path used by cockpit clicks.
  - Verified with `tsc --noEmit` and Agent Browser on 2026-05-12 using the A330 LOD0 and A320 LOD1 cockpit routes: `__DevApi.drag("LEVER_ELEVATORTRIM_1", { axis: "y", start: 0, end: 0.8, startPercent: 0, endPercent: 0.8, steps: 4 })` executed all drag phases plus the compiled runtime release expression, left `O:LEVER_ELEVATORTRIM_1:ISDRAGGING = 0`, and reported zero error diagnostics; screenshots captured to `backups/agent-browser/generic-drag-devapi-support/a330-drag-devapi.png` and `backups/agent-browser/generic-drag-devapi-support/a320-drag-devapi.png`.
- [x] Compile structured stock drag callback nodes.
  - Direct `MouseRect` children using structured `CallbackDragging` now compile into generic `M:DragPercent` set/write RPN, and `CallbackJumpDragging` X/Y movement nodes compile into generic wheel plus relative-drag inc/dec RPN.
  - Verified with `tsc --noEmit` and an Agent Browser in-page compiler/runtime harness on 2026-05-12: a synthetic stock `CallbackDragging` node emitted `TEST_DRAG_SET` with argument `42` for `M:DragPercent = 0.42`, a synthetic `CallbackJumpDragging` Y movement node emitted `TEST_INC` / `TEST_DEC` from relative drag direction plus `WheelDown`, and the synthetic compile had zero diagnostics.
  - Follow-up verification on 2026-05-12 confirmed structured drag event IDs with an optional `K:` prefix normalize correctly: synthetic `CallbackDragging/EventID=K:TEST_AXIS_SET` compiled to `(M:DragPercent) 100 * 100 min 0 max (>K:TEST_AXIS_SET)`, and synthetic `CallbackJumpDragging` with `EventIdInc=K:TEST_INC` / `EventIdDec=K:TEST_DEC` emitted `>K:TEST_INC` / `>K:TEST_DEC`, not malformed `>K:K:*` events.
- [x] Preserve stock `MouseRect` default/drag interaction-mode callback code.
  - `CallbackCode` nodes containing `IMCodeInstances` now compile default and drag code as an `M:InputType` branch instead of concatenating `IMDefault`, `IMDrag`, and non-code metadata text.
  - Verified with `tsc --noEmit` and an Agent Browser in-page compiler/runtime harness on 2026-05-12: a synthetic `IMCodeInstances` node compiled to `(M:InputType) 1 == if{ ...IMDrag... } els{ ...IMDefault... }`, `inputType: 0` wrote `L:DEFAULT_PATH = 1`, `inputType: 1` wrote `L:DRAG_PATH = 2`, and compile diagnostics were empty.
- [x] Preserve stock left/leave/wheel mouse-event callback code.
  - Templates that declare `LEFT_SINGLE_CODE` together with leave or wheel code now compile as a generic `M:Event` callback binding instead of dropping `LEFT_LEAVE_CODE`, `WHEEL_UP_CODE`, or `WHEEL_DOWN_CODE` behind a simple left-single binding.
  - Verified with `tsc --noEmit` and an Agent Browser in-page compiler/runtime harness on 2026-05-12: synthetic `ASOBO_GT_Interaction_LeftSingle_Leave_Code` emitted one callback binding, and executing `LeftSingle`, `Unlock`, `WheelUp`, and `WheelDown` wrote `L:LEFT_SINGLE`, `L:LEFT_LEAVE`, `L:WHEEL_UP`, and `L:WHEEL_DOWN` with zero compile diagnostics.
- [x] Release callback-backed momentary buttons during normal DevApi clicks.
  - `__DevApi.click()` now emits a callback `LeftRelease` event for callback-backed targets after default, `LeftSingle`, or `Lock` press events, then still clears the runtime hold feedback state.
  - Verified with `tsc --noEmit` and Agent Browser on 2026-05-12 using the A330 LOD0 and A320 LOD1 cockpit routes: `__DevApi.click("PUSH_THROTTLE_1")` executed one press plus one callback release, returned `L:A32NX_AUTOTHRUST_DISCONNECT` to `0`, and reported zero error diagnostics.
- [x] Filter boolean flag parameters out of interaction feedback targets.
  - The behavior compiler no longer treats flag-style target parameters such as `NO_HIGHLIGHT_NODE_ID=True` or `DISABLE_*` as cockpit node feedback targets, and it drops boolean / numeric / `__NO_HIGHLIGHT__` sentinel values before creating `O:<target>:_ButtonAnimVar` feedback state.
  - Verified with `tsc --noEmit` and Agent Browser on 2026-05-12 using the A320 LOD1 cockpit route: the compiled interaction list had `0` feedback targets equal to `True`, `False`, `0`, `1`, or `__NO_HIGHLIGHT__`; `PUSH_MCDUL_L1` fed back only to `PUSH_MCDUL_L1`, clicked successfully, emitted `H:A320_Neo_CDU_1_BTN_L1`, and reported zero error diagnostics.
- [x] Preserve direction for generic rotary key-event fallback bindings.
  - Templates that provide both `CLOCKWISE_EVENTID` and `ANTICLOCKWISE_EVENTID` without explicit RPN code now compile a generic `M:Event` branch instead of falling back to only the first key event.
  - Verified with `tsc --noEmit` and an Agent Browser in-page compiler harness on 2026-05-12: a synthetic stock-shaped rotary template with `CLOCKWISE_EVENTID=K:TEST_INC` and `ANTICLOCKWISE_EVENTID=TEST_DEC` compiled to `(M:Event) 'WheelDown' scmp 0 == if{ (>K:TEST_INC) } els{ (>K:TEST_DEC) }` with zero diagnostics; the A320 LOD1 cockpit route still compiled 766 interactions with zero errors.
- [x] Preserve percent-unit rudder trim set behavior for callback rotary interactions.
  - `RUDDER_TRIM_SET` now accepts authored percent values while `RUDDER_TRIM_SET_EX1` remains a 16k-position event, and stored `A:* TRIM PCT` values convert correctly when RPN asks for `Percent`.
  - Verified with `tsc --noEmit` and Agent Browser on 2026-05-12 using the A330 LOD0 cockpit route: `__DevApi.click("KNOB_RUDDERTRIM", { mouseEvent: "WheelDown" })` moved `A:RUDDER TRIM PCT` from `0` to `0.05` and `A:RUDDER TRIM PCT, Percent` to `5`; `WheelUp` returned both values to `0`.
- [x] Preserve percent-over-100 unit semantics for stored light brightness values.
  - Stored `A:LIGHT POTENTIOMETER:*` and `A:LIGHT * POWER SETTING` values now convert from internal 0-100 percent to 0-1 when stock XML asks for `Percent over 100`, matching FMC/MCDU and lighting emissive templates.
  - Verified with `tsc --noEmit` and Agent Browser on 2026-05-12 using the A320 LOD1 cockpit route: after battery, external power, and avionics key events, `A:LIGHT POTENTIOMETER:86` read as `100`, `A:LIGHT POTENTIOMETER:86, Percent over 100` read as `1`, and `I:XMLVAR_MCDU_1_Brightness` read as `1` / `100%` with zero reported diagnostics in the sampled window.
  - Follow-up verification on the same route confirmed unset stock light power-setting simvars stay dark in cold-and-dark and recover under electrical power: `A:LIGHT PANEL POWER SETTING` moved from `0` to `100`, `A:LIGHT PANEL POWER SETTING, Percent over 100` moved from `0` to `1`, and `A:LIGHT PEDESTAL POWER SETTING, Percent over 100` moved from `0` to `1`.
- [x] Preserve id-only key-event dispatch for stackless RPN key writes.
  - RPN key-event writes now consume only values actually present on the stack, so stackless writes such as `(>K:GEAR_UP)` dispatch as id-only events instead of synthetic zero-argument writes, while value-carrying writes such as `5 (>K:RUDDER_TRIM_SET)` still dispatch their authored value.
  - Verified with `tsc --noEmit` and Agent Browser on 2026-05-12 using the A330 LOD0 cockpit route: `LEVER_LANDINGGEAR` emitted `GEAR_UP` / `GEAR_DOWN` with `args: []` and `K:GEAR_UP = 1`, while `KNOB_RUDDERTRIM` still emitted `RUDDER_TRIM_SET` with `args: [5]` and `A:RUDDER TRIM PCT, Percent = 5`.
- [x] Preserve value-carrying drag set-event fallbacks.
  - Templates that provide `DRAG_EVENTID_SET` without explicit callback RPN now compile a value-carrying set-event expression using `DRAG_SIMVAR`, `DRAG_SIMVAR_UNITS`, `DRAG_SPEED` / `DRAG_DELTA`, and optional `EVENTID_CONVERSION` instead of invoking the set event without a value.
  - Verified with `tsc --noEmit` and an Agent Browser in-page compiler harness on 2026-05-12: a synthetic stock-shaped drag template with `DRAG_EVENTID_SET=K:TEST_AXIS_SET`, `DRAG_SIMVAR=TEST AXIS POSITION`, `DRAG_SIMVAR_UNITS=percent`, `DRAG_SPEED=5`, and `EVENTID_CONVERSION=2 *` compiled to `(A:TEST AXIS POSITION, percent) 5 + 2 * (>K:TEST_AXIS_SET)` with zero diagnostics.
- [x] Preserve static/dynamic parameter semantics for explicit input-event key bindings.
  - `BINDING_*_*_PARAM_*_IS_DYNAMIC` now controls whether explicit input-event binding parameters are emitted as RPN expressions or static literal arguments, explicit `BINDING_*_*_EVENT_ID` values normalize an optional `K:` prefix, and binding labels such as `Set` are no longer miscompiled as interaction RPN.
  - Verified with `tsc --noEmit` and an Agent Browser in-page compiler harness on 2026-05-12: a synthetic `UseInputEvent` with `BINDING_SET_0=Set`, static param `2`, dynamic param `(A:TEST VALUE, Number) 3 +`, and `BINDING_SET_0_EVENT_ID=K:TEST_MULTI_PARAM_SET` emitted input-event bindings with source `2 (A:TEST VALUE, Number) 3 + (>K:2:TEST_MULTI_PARAM_SET)`, zero diagnostics, and no bogus interaction binding for `Set`.
- [x] Honor explicit input-event key-only bindings.
  - `BINDING_*_*_EVENT_ID_ONLY` now suppresses the synthetic default `1` parameter for explicit key-event input bindings, matching stock XML alias-generation semantics where the binding is intended to dispatch only the event ID.
  - Verified with `tsc --noEmit` and an Agent Browser in-page compiler harness on 2026-05-12: a synthetic `UseInputEvent` with `BINDING_SET_0_EVENT_ID_ONLY=True` emitted `(>K:TEST_EVENT_ONLY)` without a default parameter, while the same binding without `EVENT_ID_ONLY` still emitted `1 (>K:TEST_EVENT_WITH_DEFAULT)`, both with zero diagnostics and no interaction bindings.
- [x] Deduplicate exact compiler diagnostics before exposing them through DevApi.
  - Behavior compilation and DevApi diagnostic aggregation now collapse exact duplicate diagnostics by severity, code, source path, and message so repeated unresolved template expansions do not inflate warning counts or obscure distinct issues.
  - Verified with `tsc --noEmit` and an Agent Browser in-page compiler harness on 2026-05-12: two identical missing-template uses in a synthetic model produced a single `template_missing` warning while preserving the original warning text and source path. A fresh A320 LOD1 DevApi check on the same date reported one known `FBW_AIRBUS_Update_PTU_Template` warning instead of two.
- [x] Bound DevApi event history output for cockpit action checks.
  - `window.__DevApi.events()` now accepts `limit` alongside `kind`, returns only the latest requested entries per event stream, and documents the option in `schema()`, README, and AGENTS.md so button/gauge smoke checks stay readable when gauges are producing many key or sound events.
  - Verified with `tsc --noEmit` and Agent Browser on 2026-05-12: `events({ kind: "key", limit: 3 })` returned exactly three key events, `events({ limit: 2 })` capped key and sound streams at two entries, and `schema().data.eventOptions` exposed `kind` and `limit`.
- [x] Make DevApi runtime reset usable for cold-and-dark startup checks.
  - `window.__DevApi.reset({ coldAndDark: true })` now clears runtime variables/events/counters and seeds the generic cold-and-dark state; `reset({ runtime: true })` resets back to the package preview state, while plain `reset()` remains a transient DevApi diagnostics/highlight reset.
  - This prevents startup checks from accidentally reusing powered runtime state after previous probes and documents the reset contract in README and AGENTS.md.
  - Follow-up cockpit-click verification fixed normal DevApi clicks so they do not emit a synthetic `LeftRelease` callback for unheld `LeftSingle` presses. This avoids toggling targets with both left-single and callback bindings twice, which previously made APU master appear to do nothing during startup checks.
  - Follow-up APU startup support keeps APU master/start responsible for APU running/available state while leaving `A:APU GENERATOR SWITCH:#` under the APU generator switch event/button, so a realistic APU master -> start -> generator sequence does not toggle the generator back off.
  - Follow-up DevApi wait support now rejects unknown `waitFor` condition kinds immediately with the supported kind list instead of silently polling until timeout, which keeps automation failures clear during startup checks.
- [x] Support generic spoiler/speedbrake object-position side effects.
  - Stock spoiler/speedbrake lever callbacks can update an object-scoped `O:*:Position` without emitting a `K:SPOILERS_SET` event on every aircraft path. The runtime now maps spoiler/speedbrake object positions to `A:SPOILERS ARMED` and the generic spoiler control target so cockpit lever movement drives `A:SPOILERS HANDLE POSITION`, `A:SPOILERS LEFT POSITION`, and `A:SPOILERS RIGHT POSITION` animation state.
  - Stored gear/flap/spoiler percent-style control SimVars now honor `Percent over 100` and `Position 16k` unit reads after the runtime publishes them, preventing stock update code such as `A:SPOILERS HANDLE POSITION, Percent over 100` from inflating object positions.
  - The spoiler object-position mapper accepts both compact detent positions and larger stock animation-length positions, so object/simvar sync code can round-trip without over-scaling deployment.
- [x] Support generic stock handling trim input events.
  - `B:HANDLING_RudderTrim_*`, `B:HANDLING_ElevatorTrim_*`, and `B:HANDLING_AileronsTrim_*` bridge calls now update the corresponding `A:* TRIM PCT` / indicator SimVars instead of only changing bridge-local `B:` state, so stock trim knobs, switches, and drag callbacks have visible runtime state.
- [x] Bound generic DDS side fetches during model load.
  - Generic model texture loading now uses the existing range-low DDS path by default, falling back to placeholders when byte ranges or `.FLAGS` probes are unavailable. DDS range requests are bounded to 2 seconds and `.FLAGS` probes to 500 ms so slow or missing texture side requests do not make GLTF LOD parsing wait for browser network timeouts before the runtime and DevApi can come up.
  - Follow-up: decoded DDS range fallback now preserves loader path, request headers, and credentials when it delegates unsupported decoded formats back to the compressed DDS range loader, preventing fallback texture requests from drifting to the wrong relative URL during cockpit startup.
  - Follow-up: expected range-low placeholder fallback logs are suppressed during normal startup and can be re-enabled with `?ddsDebug`, keeping DevTools output readable while preserving detailed DDS diagnostics when needed.
  - Follow-up: boot DevApi status now includes generic GLTF loading-manager counts and the oldest active resource URLs while the full viewer is still loading, so stuck `GLTFLoader.parseAsync()` waits can be diagnosed without private browser state.
  - Follow-up: external GLTF sidecar buffers are prefetched through bounded HTTP range chunks and rewritten to temporary blob URLs before `GLTFLoader.parseAsync()`, avoiding browser partial-cache stalls on large `.bin` files while keeping the fix generic to all non-embedded glTF buffers.
  - Follow-up: optional ASOBO detail-map texture dependencies and `MSFT_texture_dds` texture dependencies now have bounded placeholder fallbacks, so a slow or stuck DDS request cannot hold the entire model parse open indefinitely.
- [x] Support value-carrying simple key-event writes for cockpit systems.
  - Simple `value (>K:EVENT)` RPN writes now consume the top stack value instead of always invoking the key event with no arguments, matching cockpit lighting, electrical, and fuel templates that use simple event writes without an explicit `>K:N:` argument count.
  - The demo runtime host now applies generic light potentiometer, light switch, fuel pump/valve/junction, and electrical circuit key events to corresponding SimVars.
  - Verified locally on 2026-05-10 with direct RPN/runtime execution: `100 (>K:LIGHT_POTENTIOMETER_10_SET)`, `75 8 (>K:2:LIGHT_POTENTIOMETER_SET)`, `1 (>K:CABIN_LIGHTS_SET)`, `2 (>K:FUELSYSTEM_PUMP_ON)`, `9 (>K:FUELSYSTEM_VALVE_OPEN)`, and `20 (>K:ELECTRICAL_CIRCUIT_TOGGLE)` updated the expected `A:LIGHT POTENTIOMETER`, `A:LIGHT CABIN`, `A:FUELSYSTEM ...`, and `A:CIRCUIT SWITCH ON` runtime values.
  - Verified with Agent Browser on 2026-05-10 on the A320 route with `exteriorInterior=off`: invoking those generic runtime key events in the page set `A:LIGHT POTENTIOMETER:10 = 100`, `A:LIGHT POTENTIOMETER:8 = 75`, `A:LIGHT CABIN = 1`, `A:FUELSYSTEM PUMP SWITCH:2 = 1`, `A:FUELSYSTEM VALVE OPEN:9 = 1`, and `A:CIRCUIT SWITCH ON:20 = 1`.
  - Follow-up support covers plural light-event names (`STROBES_ON`, `LOGO_LIGHTS_SET`, `NAV_LIGHTS_SET`), cabin seatbelt/no-smoking toggles, APU bleed/start/off, COM receive selection, and pitot heat; Agent Browser on the same A320 route verified the corresponding runtime SimVars all updated to `1` and APU RPM updated to `100`.
  - Follow-up support covers integrated light power-setting key events from `Asobo/Common/Inputs/Lighting_Inputs.xml` and `Asobo/Common/Subtemplates/Lighting_Subtemplates.xml`: generic `*_LIGHTS_POWER_SETTING_SET` events now update indexed and unindexed `A:LIGHT ... POWER SETTING` SimVars.
  - Follow-up support covers the stock pedestal spelling mismatch where the key event is `PEDESTRAL_LIGHTS_POWER_SETTING_SET` but the integrated SimVar is `A:LIGHT PEDESTAL POWER SETTING`; the generic runtime now normalizes that event family to the authored SimVar name.
  - Verified with `tsc --noEmit` and direct Chrome DevTools Protocol on 2026-05-11: A330 and A320 exterior-only DevApi key-event harnesses set panel power setting to `75`, glareshield to `40`, and strobe to `25` with matching indexed SimVars; both routes had zero diagnostics and about 60 FPS, with screenshots captured to `backups/agent-browser/lighting-power-setting-support/`.
  - Follow-up support preserves indexed light switch state for stock two-argument `*_LIGHTS_SET` key events and supports both stock toggle spellings (`TOGGLE_*_LIGHTS` and `*_TOGGLE`), updating indexed and unindexed `A:LIGHT ...` SimVars generically.
  - Verified with `tsc --noEmit` and direct Chrome DevTools Protocol on 2026-05-11: A330 and A320 exterior-only DevApi key-event harnesses set landing light index 2 on, index 1 off, toggled beacon index 3, and toggled strobe index 4; both routes had zero diagnostics and about 60 FPS, with screenshots captured to `backups/agent-browser/indexed-light-switch-support/`.
  - Follow-up support covers additional stock cockpit key events for radio/audio volume and ident controls, transmitter selection, elevator/rudder trim, antiskid, windshield deice, turbine ignition, mixture-rich commands, autopilot disconnect, transponder ident, and Kohlsman baro changes.
  - Verified with Agent Browser on 2026-05-10 on the same A320 exterior-only route: representative events updated `A:ADF/NAV/COM VOLUME`, `A:NAV SOUND`, `A:COM ACTIVE FREQUENCY:3 HZ`, `A:NAV IDENT:1`, `A:MARKER SOUND`, `A:COPILOT TRANSMITTER TYPE`, trim, antiskid, windshield deice, ignition, mixture, autopilot, transponder, and Kohlsman SimVars.
  - Follow-up support covers active direct light set events such as `STROBES_SET` and radio ident set events such as `RADIO_DME1_IDENT_SET`; Agent Browser on the same A320 route verified `A:LIGHT STROBE`, `A:DME IDENT:1`, and `A:DME SOUND:1` updates.
  - Follow-up support covers stock deice key events from `Asobo/Common/Inputs/Deice_Inputs.xml`: `TOGGLE_STRUCTURAL_DEICE`, `TOGGLE_PROPELLER_DEICE`, `ANTI_ICE_ON` / `OFF` / `TOGGLE` / `SET`, `PROP_DEICE_ON` / `OFF` / `TOGGLE` / `SET`, and two-argument `PITOT_HEAT_SET` now update structural, propeller, and indexed pitot heat SimVars.
  - Verified with `agent-browser` and `window.__DevApi` on 2026-05-10:
    - A330 route `?exteriorInterior=off&cockpitPerf` had zero diagnostics; event sequence toggled `A:STRUCTURAL DEICE SWITCH` to `1`, `A:PROP DEICE SWITCH:1` to `1` then `0`, and `A:PITOT HEAT SWITCH:2` / `A:PITOT HEAT` to `1` then `0`; screenshot captured to `backups/agent-browser/deice-support/a330-deice-runtime-events.png`.
    - A320 route `?package=/aircrafts/flybywire-aircraft-a320-neo/&aircraft=SimObjects/AirPlanes/FlyByWire_A320_NEO%23fltsim.0&exteriorInterior=off&cockpitPerf` had zero diagnostics; the same event sequence updated the same runtime SimVars; after load settled, FPS was 60 with low FPS about 56.5 and runtime work about 0.6 ms/frame; screenshot captured to `backups/agent-browser/deice-support/a320-deice-runtime-events.png`.
  - Follow-up support covers stock engine anti-ice and alternate-air events from `Asobo/Common/Subtemplates/Deice_Subtemplates.xml` and `Asobo/Common/Subtemplates/Engine_Subtemplates.xml`: `ANTI_ICE_SET_ENG#ID#`, `ANTI_ICE_TOGGLE_ENG#ID#`, and `ANTI_ICE_GRADUAL_SET_ENG#ID#` now update `A:ENG ANTI ICE:#ID#`, `A:GENERAL ENG ANTI ICE POSITION:#ID#`, and `A:RECIP ENG ALTERNATE AIR POSITION:#ID#`, including `position 16k` and `percent over 100` unit reads.
  - Verified with `agent-browser` and `window.__DevApi` on 2026-05-10:
    - A330 route `?exteriorInterior=off&cockpitPerf` had zero diagnostics; toggling engine anti-ice set `A:ENG ANTI ICE:1` to `1`, gradual set `8192` read back as 50 percent / 8192 position16k / 0.5 percent-over-100 for both general engine anti-ice and recip alternate-air position SimVars, and set-off returned all values to `0`; screenshot captured to `backups/agent-browser/engine-deice-support/a330-engine-deice-runtime-events.png`.
    - A320 route `?package=/aircrafts/flybywire-aircraft-a320-neo/&aircraft=SimObjects/AirPlanes/FlyByWire_A320_NEO%23fltsim.0&exteriorInterior=off&cockpitPerf` had zero diagnostics; the same event sequence produced the same SimVar values; after load settled, FPS was 60 with low FPS about 49.5 and runtime work about 1.0 ms/frame; screenshot captured to `backups/agent-browser/engine-deice-support/a320-engine-deice-runtime-events.png`.
  - Follow-up support covers stock engine-control set events from `Asobo/Common/Inputs/Engine_Inputs.xml` and `Asobo/Common/Subtemplates/Engine_Subtemplates.xml`: throttle, propeller pitch, mixture, cowl flap, generic cooling-flap, and forced-beta key events now update their corresponding SimVars with percent / `position 16k` unit conversion.
  - Verified with `agent-browser` and `window.__DevApi` on 2026-05-10:
    - A330 route `?exteriorInterior=off&cockpitPerf` had zero diagnostics; `THROTTLE1_SET`, `PROP_PITCH1_SET`, `MIXTURE1_SET`, `COWLFLAP1_SET`, `OIL_COOLING_FLAPS_SET`, `PROP_FORCE_BETA_ON`, and `PROP_FORCE_BETA_VALUE_SET` produced the expected 50, 25, 100, 50, 75, active, and 25 percent SimVar values with matching `position 16k` reads; screenshot captured to `backups/agent-browser/engine-control-support/a330-engine-control-runtime-events.png`.
    - A320 route `?package=/aircrafts/flybywire-aircraft-a320-neo/&aircraft=SimObjects/AirPlanes/FlyByWire_A320_NEO%23fltsim.0&exteriorInterior=off&cockpitPerf` had zero diagnostics; the same event sequence produced the same SimVar values; FPS was 60 with low FPS about 56.5 during the verification window; screenshot captured to `backups/agent-browser/engine-control-support/a320-engine-control-runtime-events.png`.
  - Follow-up support covers stock engine switch events from `Asobo/Common/Inputs/Engine_Inputs.xml` and `Asobo/Common/Subtemplates/Engine_Subtemplates.xml`: starter held/set/toggle, engine master toggle, magneto set/side/start, primer toggle, hydraulic switch toggle, antidetonation valve toggle, and war-emergency-power toggle now update their corresponding SimVars. Hydraulic pressure is a documented placeholder at 3000 psi when switched on until a full hydraulic model is added.
  - Verified with `agent-browser` and `window.__DevApi` on 2026-05-11:
    - A320 route `?package=/aircrafts/flybywire-aircraft-a320-neo/&aircraft=SimObjects/AirPlanes/FlyByWire_A320_NEO%23fltsim.0&exteriorInterior=off&cockpitPerf` had zero diagnostics; the event sequence updated starter, master, left/right magnetos, primer percent/position, hydraulic switch/reservoir/pressure, antidetonation valve, and WEP SimVars; FPS was 60 with low FPS about 53.2; screenshot captured to `backups/agent-browser/engine-switch-support/a320-engine-switch-runtime-events.png`.
    - A330 route `?exteriorInterior=off&cockpitPerf` had zero diagnostics and the same SimVar transitions; the immediate perf window was load/noise affected, with a follow-up sample around 49.6 FPS and low FPS about 15.7 while multiple agent browser sessions were still open; screenshot captured to `backups/agent-browser/engine-switch-support/a330-engine-switch-runtime-events.png`.
  - Follow-up support covers stock engine mode, plasma, rotor clutch, and rotor brake set events from `Asobo/Common/Inputs/Engine_Inputs.xml` and `Asobo/Common/Subtemplates/Engine_Subtemplates.xml`: `ENGINE_MODE_CRANK_SET` / `NORM_SET` / `IGN_SET`, `PLASMA_ON` / `OFF` / `SET`, `ROTOR_CLUTCH_SWITCH_SET`, and `AXIS_ROTOR_BRAKE_SET` now update corresponding ignition, plasma, clutch, and rotor brake SimVars with `position 16k` readback for the brake handle.
  - Verified with `agent-browser` and `window.__DevApi` on 2026-05-11: A320 and A330 routes both had zero diagnostics; `ENGINE_MODE_IGN_SET` set indexed and unindexed turbine ignition mode to `2`, `PLASMA_ON` set `A:PLASMA ON:1`, `ROTOR_CLUTCH_SWITCH_SET` set `A:ROTOR CLUTCH SWITCH POS`, and `AXIS_ROTOR_BRAKE_SET` `8192` read back as 50 percent / 8192 position16k; both verification windows reported about 60 FPS with low FPS about 52-53; screenshots captured to `backups/agent-browser/engine-mode-rotor-support/`.
  - Follow-up support covers stock handling and landing-gear key events from `Asobo/Common/Inputs/Handling_Inputs.xml`, `Asobo/Common/Inputs/LandingGear_Inputs.xml`, and their subtemplates: brake axes, emergency gear handle, retract-float switch, water rudder toggle, spoiler arm toggle, autopilot disengage set, nose-wheel steering limit set, G limiter set, autobrake level set, trim-disabled flags, aileron trim set, and elevator trim up/down now update matching SimVars with percent / `position 16k` readback for brake and water-rudder positions.
  - Verified with `agent-browser` and `window.__DevApi` on 2026-05-11: A320 and A330 routes both had zero diagnostics; representative events produced 50 percent / 8192 position16k left brake, 25 percent right brake, emergency gear and float/water/spoiler states, autobrake level `4`, G limiter `2`, trim-disabled flags, 0.5 aileron trim, and 5 percent elevator trim indicator; both verification windows reported about 60 FPS with low FPS about 53.5; screenshots captured to `backups/agent-browser/handling-gear-support/`.
  - Follow-up support covers stock aircraft/handling key events from `Asobo/Common/Aircraft.xml` and `Asobo/Common/Handling.xml`: interactive aircraft exits, wing fold, launchbar, tailhook, tailwheel lock, water-ballast valves, tow release, and unextended aileron trim set events now update matching SimVars. Wing fold, launchbar, tailhook, and tow release currently use direct placeholder positions until full airframe-specific systems simulation exists.
  - Verified with `agent-browser` and `window.__DevApi` on 2026-05-11: A320 and A330 routes both had zero diagnostics; representative events set exit 2 open/goal to 100 percent, wing fold/launchbar/tailhook/tailwheel/water-ballast states to active, tow release handle to 100 with tow connection cleared, and aileron trim to 0.5. A320 settled at about 59.9 FPS with low FPS about 53.2; A330 settled around 60 FPS with low FPS about 53.2; screenshots captured to `backups/agent-browser/handling-aircraft-support/`.
  - Follow-up support covers additional stock fuel key events from `Asobo/Common/Inputs/Fuel_Inputs.xml` and the APU fuel-pump update path in `Asobo/Common/Inputs/Electrical_Inputs.xml`: `FUELSYSTEM_PUMP_SET`, legacy electric-fuel-pump toggle/set events, `FUELSYSTEM_VALVE_SET`, `FUELSYSTEM_JUNCTION_SET`, and indexed/unindexed `FUEL_SELECTOR_SET` events now update corresponding pump, valve, junction, and selector SimVars.
  - Verified with `agent-browser` and `window.__DevApi` on 2026-05-11: A320 and A330 routes both had zero diagnostics; representative events set `A:FUELSYSTEM PUMP SWITCH/ACTIVE:2`, accepted stock-style `FUELSYSTEM_PUMP_SET` value/index ordering on pump `6`, toggled `A:FUELSYSTEM PUMP SWITCH:3`, set legacy `A:GENERAL ENG FUEL PUMP SWITCH/ACTIVE:4`, set `A:GENERAL ENG FUEL PUMP SWITCH EX1:5`, set `A:FUELSYSTEM VALVE OPEN/SWITCH:7`, set `A:FUELSYSTEM JUNCTION SETTING:8` to `3`, and set `A:FUEL TANK SELECTOR:1/2` to `5` and `6`; screenshots captured to `backups/agent-browser/fuel-support/`.
  - Follow-up support covers remaining stock fuel subtemplate key events from `Asobo/Common/Subtemplates/Fuel_Subtemplates.xml`: `MIXTURE#_LEAN`, `SET_FUEL_VALVE_ENG#`, `TOGGLE_FUEL_VALVE_ENG#`, `SET_FUEL_TRANSFER_CUSTOM`, `FUEL_TRANSFER_CUSTOM_INDEX_TOGGLE`, and `FUELSYSTEM_TRIGGER_TOGGLE` now update the corresponding mixture, engine fuel-valve, transfer-mode, transfer-pump, and fuel-system trigger SimVars.
  - Verified with `tsc --noEmit` and `agent-browser` / `window.__DevApi` on 2026-05-11: A330 and A320 exterior-only routes both moved mixture `100 -> 0`, engine fuel valve 2 `1 -> 0` with matching `L:ENG FUEL VALVE:2`, transfer mode to custom enum `5`, transfer pump 4 `1 -> 0`, and trigger 12 `1 -> 0`; both routes had zero diagnostics and settled around 60 FPS; screenshots captured to `backups/agent-browser/fuel-subtemplate-support/`.
  - Follow-up support covers additional stock electrical key events from `Asobo/Common/Inputs/Electrical_Inputs.xml`: indexed battery set, master battery set, stock external power set/toggle, APU generator set/toggle, starter set, all-starters held set, and all-starters toggle now update matching battery, external power, APU generator, and starter SimVars.
  - Verified with `agent-browser` and `window.__DevApi` on 2026-05-11: A320 and A330 routes both had zero diagnostics; representative events set global and indexed battery SimVars, accepted stock-style `SET_EXTERNAL_POWER` value/index ordering and direct index/value ordering, toggled indexed external power, set/toggled indexed APU generators, set all starters on, set all-starters held off, and toggled all starters back on; screenshots captured to `backups/agent-browser/electrical-input-support/`.
  - Follow-up support covers additional stock electrical subtemplate key events from `Asobo/Common/Subtemplates/Electrical_Subtemplates.xml`: alternator set/on/off/toggle events now update `A:GENERAL ENG MASTER ALTERNATOR:#`, circuit breaker toggles keep `A:CIRCUIT ON:#`, `A:CIRCUIT SWITCH ON:#`, and `A:CIRCUIT BREAKER PULLED:#` coherent, named `BREAKER_*_TOGGLE` events update their matching `A:BREAKER ...` SimVar, and `ELECTRICAL_EXECUTE_PROCEDURE` records a generic procedure-active SimVar for the demo host. Verified with `tsc --noEmit`, a local Bun runtime harness, and `agent-browser` / `window.__DevApi` on A330 and A320 exterior-only routes on 2026-05-11: both routes had zero diagnostics, the representative event sequence produced the expected alternator, breaker, and procedure states, and both settled around 60 FPS; screenshots captured to `backups/agent-browser/electrical-subtemplate-support/`.
  - Follow-up support covers additional stock instrument key events from `Asobo/Common/Inputs/Instrument_Inputs.xml`: VOR course set/inc/dec and ADF card set/inc/dec now update corresponding course/radial SimVars with degree normalization; existing Kohlsman support was reverified through the stock altimeter set/inc path.
  - Verified with `agent-browser` and `window.__DevApi` on 2026-05-11: A320 and A330 routes both had zero diagnostics; representative events set `A:NAV OBS:1` to `125`, wrapped `A:NAV OBS:2` from `359 + 3` to `2`, set `A:ADF RADIAL` and `A:ADF CARD` to `265`, and updated indexed Kohlsman HG/MB values; screenshots captured to `backups/agent-browser/instrument-input-support/`.
  - Follow-up support covers stock procedure key events from `Asobo/Common/Inputs/Common_Inputs.xml`: `ENGINE_AUTO_START`, `ENGINE_AUTO_SHUTDOWN`, and `ALL_LIGHTS_TOGGLE` now update generic engine combustion/RPM/N1 and light SimVars. Auto-start RPM/N1 are documented placeholders at `20` until a full engine model exists.
  - Verified with `agent-browser` and `window.__DevApi` on 2026-05-11: A320 and A330 routes both had zero diagnostics; representative events set engine 1 combustion to `1`, placeholder RPM/N1 to `20`, toggled beacon/nav/cabin lights to `1`, then auto-shutdown returned combustion/RPM/N1 to `0`; screenshots captured to `backups/agent-browser/procedure-input-support/`.
  - Follow-up support covers stock autopilot key events from `Asobo/Common/Autopilot.xml` and the AS1000 autopilot inputs: AP master/on/off, heading, bank, localizer/approach/backcourse, flight director, yaw damper, altitude, FLC/speed hold, vertical speed, nav, speed/mach, wing/pitch leveler, pitch-reference, and autothrottle events now update the stock-watched autopilot SimVars. Vertical-speed inc/dec uses the stock 100 ft/min step as a placeholder until a full autopilot model is added.
  - Verified with `agent-browser` and `window.__DevApi` on 2026-05-11: A320 and A330 routes both had zero diagnostics; representative events updated AP master, heading, altitude, FLC, VS, NAV, APR/LOC, backcourse, flight director, yaw damper, max-bank, speed, vertical-speed, and managed-Mach SimVars; screenshots captured to `backups/agent-browser/autopilot-input-support/`.
  - Follow-up support covers stock autopilot subtemplate knob key events from `Asobo/Common/Subtemplates/Autopilot_Subtemplates.xml`: heading-bug set, selected-altitude set/inc/dec, barometric standard/set, and VOR course set/inc/dec now update the corresponding heading, altitude, Kohlsman, and course SimVars.
  - Verified with `agent-browser` and `window.__DevApi` on 2026-05-11: A320 and A330 routes both had zero diagnostics; representative events set `A:AUTOPILOT HEADING LOCK DIR:3` to `271`, kept indexed selected altitude at `12000` after inc/dec, set indexed Kohlsman standard pressure to `29.92`, and updated NAV OBS course values; settled FPS returned to about 60 with low FPS about 53; screenshots captured to `backups/agent-browser/autopilot-subtemplate-support/`.
  - Follow-up support covers stock NAVCOM and transponder key events from `Asobo/NAVCOM/*` and `Asobo/Transponder/*`: COM/NAV whole and fractional standby-frequency knob events, COM/NAV swap and receive-select events, ADF standby-frequency and volume knob events, audio-panel toggles/settings, decision-height adjustment, GPS-drives-NAV1, and transponder state/ident events now update corresponding generic runtime SimVars.
  - Verified with `agent-browser` and `window.__DevApi` on 2026-05-11: A320 and A330 exterior-only routes both had zero diagnostics; representative events set COM1 active to `119.025`, COM1 standby to `118`, NAV1 receive/sound on, all four COM receive flags on, ADF standby to `390`, ADF volume to `5`, GPS-drives-NAV1 and speaker active, intercom mode `2`, audio-panel volume `5`, decision height `10`, transponder state `3`, and transponder ident on; both routes reported about 60 FPS with low FPS about 53.2; screenshots captured to `backups/agent-browser/navcom-transponder-support/`.
- [x] Compile generic input-event bridge bindings outside explicit `<UseInputEvent>` wrappers.
  - Stock and package templates that expose `BINDING_INC_*`, `BINDING_DEC_*`, or `BINDING_SET_*` parameters now also register runtime `B:` bridge bindings when they expand through ordinary templates, and templates that use `INPUT_EVENT_ID` instead of `INPUT_EVENT_ID_SOURCE` are accepted as the source prefix.
  - The RPN compiler now treats empty placeholder reads/writes `(:)` and `(>:)` as no-op-compatible values so generated bridge expressions compile instead of producing unsupported-token diagnostics when a stock/package template leaves an optional state slot empty.
  - Verified with `agent-browser` and `window.__DevApi` on 2026-05-11:
    - A320 cockpit route `?package=/aircrafts/flybywire-aircraft-a320-neo/&aircraft=SimObjects/AirPlanes/FlyByWire_A320_NEO%23fltsim.0&cockpitInteractionHitboxes&cockpitPerf` compiled 114 input-event bridge bindings; direct `B:A32NX_PED_ECP_ENG_PB_Push` / `Release` writes emitted the expected ECP HTML events, MCDU target clicks emitted `A320_Neo_CDU_1_BTN_INIT`, `A320_Neo_CDU_1_BTN_A`, and `A320_Neo_CDU_1_BTN_L1`, unsupported `(:)` diagnostics dropped from 8 to the two known missing-template warnings, and settled FPS was about 60 with low FPS about 53.2.
    - A330 cockpit route `?cockpitInteractionHitboxes&cockpitPerf` compiled 126 input-event bridge bindings; unsupported `(:)` diagnostics dropped to the two known missing-template warnings, and settled FPS was about 60 with low FPS about 53.2.
    - Screenshots captured to `backups/agent-browser/input-event-bridge-support/`.
- [x] Drive generic controls from unbound `B:` cockpit events.
  - Runtime `B:` writes without a compiled input-event binding now fall back to the generic control event interpreter, so stock/package cockpit scripts that call names like `HANDLING_Flaps_Set` or `LANDING_GEAR_Gear_Set` still update the matching flaps, slats, spoilers, and gear SimVars. 16k-position control values are normalized to percent-over-100 before updating the runtime target.
  - Verified with `agent-browser` and `window.__DevApi` on 2026-05-11: A320 and A330 cockpit routes both accepted direct `B:HANDLING_Flaps_Set` value `8192` and `B:LANDING_GEAR_Gear_Set` value `0`; both reported 50 percent flap/slat SimVars and retracted gear handle/animation SimVars. Diagnostics stayed at the two known missing-template warnings. A320 settled back to about 60 FPS with low FPS about 48.8; A330 reported about 60 FPS with low FPS about 50. Screenshots captured to `backups/agent-browser/generic-control-bridge-support/`.
- [x] Preserve generic state for unbound `B:` button, switch, knob, and lever events.
  - Runtime `B:` writes without a compiled input-event binding now also apply generic input-event state suffix semantics: `_Push` / `_On` set the base `B:` event to `1`, `_Release` / `_Off` set it to `0`, `_Toggle` flips it, `_Set` stores the provided value, and `_Inc` / `_Dec` adjust the base event by the provided step or `1`. This keeps stock/package animation, emissive, tooltip, and follow-up behavior code that reads `(B:<preset>, Bool|percent)` responsive even before a richer system-specific binding exists.
  - Verified with `agent-browser` and `window.__DevApi` on 2026-05-11: A320 and A330 cockpit routes accepted synthetic generic `B:` push/release/toggle/set/inc/dec writes; base `B:` reads returned `1`, `0`, toggled `1 -> 0`, and knob values `42 -> 45 -> 43`. The existing `B:HANDLING_Flaps_Set` path still drove flaps/slats to 50 percent and preserved `B:HANDLING_FLAPS = 8192`. A320 settled at about 60 FPS with low FPS about 53.8 after closing an unrelated default agent-browser session; A330 reported about 60 FPS with low FPS about 34.8 during the verification window. Screenshots captured to `backups/agent-browser/generic-b-state-support/`.
  - Follow-up support covers boolean named-state `B:` events such as `_Set_Locked`, `_Set_Unlocked`, `_Set_Open`, `_Set_Closed`, `_Set_On`, and `_Set_Off` by updating the base event name before `_Set_<state>`. Verified on the same A320 and A330 cockpit routes: `B:GENERIC_DOOR_Lock_Set_Locked` / `Unlocked`, `B:GENERIC_SWITCH_Set_On` / `Off`, and `B:GENERIC_HATCH_Set_Open` / `Closed` returned base values `1/0`, `1/0`, and `1/0`; the A330 verification window stayed at about 60 FPS with low FPS about 53.2.
  - Follow-up support routes the same generic fallback through `SharedMsfsRuntimeHost.invokeBridgeCall`, which is used by VCockpit iframe `bridgeCall` requests. `invokeBridgeCall` now invalidates the runtime read cache before dispatch, so immediate reads after bridge-triggered state changes see the new values. Verified with `agent-browser` and `window.__DevApi` on 2026-05-11: direct `__lastRuntimeHost.invokeBridgeCall(...)` calls for generic push/release/toggle and lock/unlock names updated base `B:` state on A330 and A320; A330 reported about 60 FPS with low FPS about 53.2, and the settled A320 sample reported about 60 FPS with low FPS about 53.5.
  - Follow-up cleanup removes an accidental parent-side `invokeBridgeCall(request.op)` from the VCockpit runtime request handler, so iframe `readVariable`, `writeVariable`, and `keyEvent` messages no longer create bogus bridge calls named `readVariable`, `writeVariable`, or `keyEvent` before executing the requested operation. Verified with `tsc --noEmit`, source inspection of `handleVCockpitGaugeRuntimeRequest`, and an A330 `?exteriorInterior=off&cockpitPerf` DevApi smoke check with zero diagnostics and a settled 60 FPS / low 53.2 FPS sample.
  - Follow-up DevApi support exposes the same bridge path as `window.__DevApi.bridgeCall(name)`, so agents can verify VCockpit bridge semantics without reaching into private globals. Verified with `agent-browser` on the A330 `?exteriorInterior=off&cockpitPerf` route: `bridgeCall` was listed in help/schema, generic push/release/toggle and named lock bridge calls updated base `B:` state, diagnostics stayed at zero, and FPS reported about 60 with low FPS about 53.5.
  - Follow-up runtime diagnostics record recent bridge calls with normalized name, argument value, sequence, and whether a compiled binding handled the call, and `window.__DevApi.events({ kind: "bridge" })` exposes those records alongside the existing key/html/sound event streams. Verified with `agent-browser` on the A330 `?exteriorInterior=off&cockpitPerf` route: generic `bridgeCall` push/release plus a `B:` set write emitted three bridge records, bridge-filtered events excluded key/html/sound/interaction data, base `B:` state still updated, diagnostics stayed at zero, and FPS reported about 60 with low FPS about 53.8.
  - Follow-up compiler support generates exact bridge bindings for stock multi-position `UseInputEvent` states that declare `STR_STATE_N` plus `SET_STATE_N`, so writes such as `>B:..._Norm`, `>B:..._Dump`, and `>B:..._RAM_Dump` update the base `B:` state from the expanded official XML mapping instead of relying on a runtime suffix guess.
  - Verified with `tsc --noEmit` and `agent-browser` on 2026-05-11: an in-browser compile harness for a stock-style pressurization dump input event emitted `PRESSURIZATION_Dump_Norm`, `PRESSURIZATION_Dump_Dump`, and `PRESSURIZATION_Dump_RAM_Dump` bindings with exact `0/1/2 (>B:PRESSURIZATION_Dump)` writes; invoking those bridge calls through `SharedMsfsRuntimeHost` reported `handledByBinding: true`, updated the base `B:` state, and fired the generated key event. A330 and A320 exterior-only route smokes both had zero diagnostics and about 60 FPS; screenshots captured to `backups/agent-browser/multistate-input-event-support/`.
  - Follow-up compiler support generates direct `..._Inc`, `..._Dec`, and `..._Set` bridge bindings from stock `INC_EVENT`, `DEC_EVENT`, and `SET_EVENT` parameters, covering stock input families such as `Common/Inputs/Lighting_Inputs.xml` that do not always expose separate `BINDING_*` aliases.
  - Verified with `tsc --noEmit` and `agent-browser` on 2026-05-11: an in-browser compile/runtime harness for a stock-style lighting input event emitted `LIGHTING_Cabin_1_Inc`, `LIGHTING_Cabin_1_Dec`, and `LIGHTING_Cabin_1_Set`; invoking `LIGHTING_Cabin_1_Inc` nested through the generated `Set` binding, fired `LIGHT_POTENTIOMETER_SET`, and updated `A:LIGHT POTENTIOMETER:10` to `75`, while `Dec` updated it to `25`. A330 and A320 exterior-only route smokes both had zero diagnostics and settled around 60 FPS; screenshots captured to `backups/agent-browser/direct-input-event-support/`.
  - Follow-up compiler support honors explicit stock `BINDING_INC_*_EVENT_ID`, `BINDING_DEC_*_EVENT_ID`, and `BINDING_SET_*_EVENT_ID` declarations when generating bridge binding RPN, including `>K:N:` writes when a binding supplies multiple parameters.
  - Verified with `tsc --noEmit` and `agent-browser` on 2026-05-11: an in-browser compile/runtime harness for a stock-style binding emitted `LIGHTING_Panel_10_Set` with source `p0 10 (>K:2:LIGHT_POTENTIOMETER_SET)`; writing `B:LIGHTING_Panel_10_Set = 63` reported `handledByBinding: true`, fired `LIGHT_POTENTIOMETER_SET` with args `[63, 10]`, and updated `A:LIGHT POTENTIOMETER:10` to `63`. A330 and A320 exterior-only route smokes both had zero diagnostics and settled around 60 FPS after the A320 sample window filled; screenshots captured to `backups/agent-browser/binding-event-id-support/`.
  - Follow-up runtime support handles stock pressurization and safety key events emitted by those generated bridge bindings. `PRESSURIZATION_PRESSURE_DUMP_SWITCH` toggles or sets `A:PRESSURIZATION DUMP SWITCH`; `PRESSURIZATION_PRESSURE_ALT_INC` / `DEC` update `A:PRESSURIZATION CABIN ALTITUDE GOAL` with a generic 500 ft fallback step when no argument is supplied; `ANNUNCIATOR_SWITCH_ON` / `OFF`, `TOGGLE_ALTERNATE_STATIC`, and `ELT_ON` / `OFF` update the matching stock SimVars. The cabin-altitude step is intentionally documented as a coarse placeholder until a verified stock/package route proves a more exact increment contract.
  - Verified with `tsc --noEmit` and `agent-browser` on 2026-05-11: A330 exterior-only DevApi key-event harness updated dump, cabin altitude goal, annunciator, alternate static, and ELT SimVars through on/off and inc/dec transitions; A320 exterior-only DevApi smoke updated the same SimVars through the on/inc path. Both routes reported zero diagnostics and about 60 FPS, with screenshots captured to `backups/agent-browser/pressurization-safety-support/`.
  - Follow-up runtime support handles stock pressurization bleed-air and safety acknowledge key events emitted by `Pressurization_Subtemplates.xml` and `Safety_Subtemplates.xml`: `BLEED_AIR_SOURCE_CONTROL_SET`, `ENGINE_BLEED_AIR_SOURCE_SET`, `MASTER_WARNING_ACKNOWLEDGE`, and `MASTER_CAUTION_ACKNOWLEDGE` now update the corresponding simulator variables.
  - Verified with `tsc --noEmit` and direct Chrome DevTools Protocol on 2026-05-11: A330 and A320 exterior-only DevApi key-event harnesses set bleed source control to `3`, engine bleed 2 to on, engine bleed 1 to off, and warning/caution acknowledged to `1` with active flags cleared; both routes had zero diagnostics and about 60 FPS, with screenshots captured to `backups/agent-browser/bleed-safety-support/`.
  - Follow-up compiler support synthesizes generic `..._Inc` and `..._Dec` bridge bindings for `UseInputEvent` nodes that provide `SET_STATE_EXTERNAL` plus stock `INC_PARAM_0` / `DEC_PARAM_0`, matching the official generic input-event pattern used by passenger levers/knobs and pressurization knobs. Generated direct `..._Set` bindings now feed `p0` into bare write-sink `SET_STATE_EXTERNAL` code such as `(>O:...)`.
  - Verified with `tsc --noEmit` and `agent-browser` on 2026-05-11: a synthetic stock-style compile/runtime harness generated `PASSENGER_Cabin_Air_Inc` / `Dec` / `Set` with `5 p0 *` stepping and updated scoped `O:XMLVAR_Cabin_Air_Position` from `10 -> 20 -> 15`; the same harness generated `PRESSURIZATION_Climb_Altitude_Goal_Inc` / `Dec` / `Set`, fired the stock pressurization key events, and updated the cabin altitude goal `0 -> 500 -> 0` through the documented placeholder step. A330 and A320 exterior-only smokes both reported zero diagnostics and about 60 FPS; screenshots captured to `backups/agent-browser/generated-setstate-step-support/`.
  - Follow-up stock Passenger/Pilot verification compiled a synthetic model XML that includes mounted `Asobo/Generic/Index.xml` and `Asobo/Common/Index.xml`, then expands the real `ASOBO_PASSENGER_*` and `ASOBO_Pilot_Visibility_Template` stock templates without package-specific aliases.
  - Verified with `agent-browser` and in-browser compiler/runtime harnesses on 2026-05-11: the stock Passenger templates generated `PASSENGER_Cabin_Air_1_*` and `PASSENGER_Cabin_Heat_1_*` bindings with zero compile diagnostics; handled bridge calls wrote the expected component-scoped `O:...XMLVAR_CABIN_*_POSITION` values; the Pilot template compiled visibility source `(A:PLANE IN PARKING STATE, bool) !`. A330 and A320 exterior-only routes had zero diagnostics, with A320 settling back to about 60 FPS; screenshots captured to `backups/agent-browser/passenger-pilot-stock-support/`.
  - Follow-up compiler/runtime support preserves package button templates that declare `TOGGLE_SIMVAR` but lose explicit `LEFT_SINGLE_CODE` during expansion: the interaction fallback now synthesizes the same toggle code instead of incorrectly using read-only `DOWN_CODE`. DevApi component summaries now expose interaction `source` / `releaseSource` so this class of failure can be diagnosed through `window.__DevApi`. The runtime also propagates generic APU local master/start switches and turbine fuel-valve state into simulator-facing APU, starter, combustion, and N2 SimVars so cockpit startup procedures produce observable state without full systems emulation.
  - Verified with `tsc --noEmit` and `agent-browser` / `window.__DevApi` on 2026-05-11: A330 and A320 cockpit cold-and-dark startup sequences clicked battery, external power, APU master/start, APU bleed, fuel pumps, engine ignition, and engine masters through DevApi. Both routes compiled the APU master as a real local-var toggle, had zero error diagnostics, and reached `A:APU PCT RPM = 100`, fuel valves 1/2 open, starters 1/2 on, combustion 1/2 on, and `A:TURB ENG N2:1/2 = 55`; screenshots captured to `backups/agent-browser/cold-dark-startup-support/`.
  - Follow-up completion removed the manual ignition fallback from the cold-and-dark smoke: duplicate interactions for the same target now prefer the most complete side-effect binding, direct `K:` RPN writes route through the key-event handler, indexed `TURBINE_IGNITION_SWITCH_SET#` events update turbine ignition SimVars, and unindexed turbine ignition reads resolve coherently from indexed engine state. Verified on 2026-05-11 by clicking the real `KNOB_ENGINES_MODE` cockpit component on both A330 and A320, with no direct `keyEvent` or `writeVar` ignition step. Both aircraft reached `L:XMLVAR_ENG_MODE_SEL = 2`, indexed and unindexed turbine ignition `= 2`, APU RPM `= 100`, combustion 1/2 `= 1`, N2 1/2 `= 55`, and zero error diagnostics; screenshots captured to `backups/agent-browser/cold-dark-startup-support/a330-full-startup-no-fallback.png` and `.../a320-full-startup-no-fallback.png`.
  - Follow-up runtime and DevApi support accepts argument lists for `SharedMsfsRuntimeHost.invokeBridgeCall`, VCockpit `bridgeCall` runtime requests, and `window.__DevApi.bridgeCall(name, args)`, while preserving scalar `B:` writes as `p0`. This covers stock timed press/long-push templates that declare `SET_ARG_COUNT=2` and read `p1` for press duration, such as `Asobo/Inputs/Templates.xml`, `Common/Safety.xml`, `Common/LandingGear.xml`, and `Common/Subtemplates/Safety_Subtemplates.xml`.
  - Verified with `tsc --noEmit` and a local Bun runtime harness on 2026-05-11: a compiled `p0`/`p1` binding invoked through `SharedMsfsRuntimeHost.invokeBridgeCall("TEST_PUSH_LONG", [1, 2.5])` wrote both parameters to runtime variables and recorded bridge diagnostics with `args: [1, 2.5]` and `handledByBinding: true`.
  - Follow-up compiler support appends `ON_STATE_CHANGED_EXTERNAL_CODE` after synthesized generated-input-event `Toggle`, named state, and direct `Set` bridge bindings. This preserves official stock side effects that are separate from the main `SET_STATE_*` body, including pressurization bleed sync code in `Common/Subtemplates/Pressurization_Subtemplates.xml`.
  - Verified with `tsc --noEmit` and `agent-browser` on 2026-05-11: an in-browser compiler/runtime harness generated `PRESSURIZATION_Bleed_Test_Off` with source `0 (>B:PRESSURIZATION_Bleed_Test) 0 (>L:BLEED_MAIN) 1 (>L:BLEED_SYNC)`, invoking it through `SharedMsfsRuntimeHost` wrote the sync variable, recorded `handledByBinding: true`, and produced zero diagnostics.
  - Follow-up runtime support handles stock safety dimmer key events from `Common/Safety.xml`: `LIGHT_POTENTIOMETER_INC` and `LIGHT_POTENTIOMETER_DEC` now adjust the indexed `A:LIGHT POTENTIOMETER:#` SimVar with a documented 5 percent placeholder step when the stock event supplies only the potentiometer index. Verified with `tsc --noEmit`, a local Bun runtime harness, and an exterior-only DevApi smoke on 2026-05-11: `LIGHT_POTENTIOMETER_SET` followed by inc/dec/dec moved potentiometer 7 from `50 -> 55 -> 50 -> 45`; the DevApi route had zero error diagnostics and reported about 60 FPS.
  - Follow-up cockpit material/runtime support publishes generic panel-power, panel-light, light-potentiometer, and common airliner bus-powered variables when electrical power is available, and applies positive override emissive bindings to black MSFS text/decal materials by raising their emissive color to white instead of only changing intensity. Verified with `tsc --noEmit` and Agent Browser on the A330 cockpit route on 2026-05-11: after battery/external power/APU startup, `A:CIRCUIT GENERAL PANEL ON = 1`, `A:LIGHT POTENTIOMETER:86 = 100`, `L:A32NX_ELEC_AC_1_BUS_IS_POWERED = 1`, `LIGHTS_OVHD` had `emissive: #ffffff` / `emissiveIntensity: 100`, APU START text nodes had `emissive: #ffffff`, and diagnostics had zero errors.
  - Follow-up MCDU/FMC brightness runtime support treats local/internal `*Brightness` variables as 0..1 fractional values while keeping `A:LIGHT POTENTIOMETER:#` variables on their 0..100 percent scale. This matches stock `Asobo/Airliner/FMC.xml` screen emissive code, which reads `I:XMLVAR_MCDU_#ID#_Brightness` unitless. Verified with `tsc --noEmit` and Agent Browser on 2026-05-11: cold `I:XMLVAR_MCDU_1_Brightness` read `0`, writing `0.42` read back as `0.42` unitless / `42` percent / `0.42` percent-over-100, and a powered missing `I:XMLVAR_MCDU_99_Brightness` fallback read `1` unitless / `100` percent instead of the previous unitless `100`.
  - Follow-up HTML gauge import/resource support now handles MSFS `import-script` entries that point at `.html` dependency documents by inlining their template/import content instead of executing the HTML as JavaScript, skips dev-server fallback documents for missing optional imports, provides labelled placeholder map host classes/elements (`SvgMapConfig`, `LatLong`, `bing-map`), and maps virtual `/VFS/...` gauge fetches to package-root files such as `config/...` instead of `<package>/VFS/...`. Verified with `tsc --noEmit` and Agent Browser on 2026-05-11: after a 35-second A330 cockpit wait, VCockpit gauge diagnostics had zero issue groups; the previous EFB `MapInstrument.html`, `@vite/client`, JSON5 config, `_developer`, `chartLimits`, and `defaultPaxWeight` errors were gone; settled FPS reported about 60 with low FPS about 32.8 during the sample.
  - Follow-up backend gauge support now loads all `NO_TEXTURE` VCockpit `htmlgaugeXX` entries as backend-only runtimes, not only WASM-backed entries. This covers non-visual host gauges such as A339X `SystemsHost` and `ExtrasHost` while still skipping texture capture and material binding for zero-size/no-texture surfaces. Verified with `tsc --noEmit` and Agent Browser on 2026-05-11: after a 35-second A330 cockpit wait plus a settled sample, DevApi reported `gauges = 24`, `loadedGauges = 24`, `capturedGauges = 18`, zero gauge issue groups, and about 59.5 FPS; backend hosts listed as four WASM bridge hosts plus `A339X/SystemsHost/systems-host.html` and `A339X/ExtrasHost/extras-host.html`.
  - Follow-up runtime namespace support preserves `I:` variables as stored interaction-local values instead of normalizing them to `A:I:...`. This covers stock safety acknowledge counters such as `I:XMLVAR_WarningWaitingAck` / `I:XMLVAR_CautionWaitingAck` plus other mounted stock cockpit templates that use `I:` state. Verified with `tsc --noEmit`, a local RPN/runtime harness, and an exterior-only DevApi smoke on 2026-05-11: incrementing `I:XMLVAR_WarningWaitingAck` updated the real `I:` key to `2`, set `L:XMLVAR_WarningEnabled` to `1`, and did not create an `A:I:...` fallback key; DevApi `writeVar` / `readVar` preserved `I:XMLVAR_DEVAPI_TEST`, had zero error diagnostics, and reported about 60 FPS.
  - Follow-up runtime support handles the remaining stock safety HTML event from `Common/Safety.xml`: `H:Generic_Gear_Advisory_Push` still records and broadcasts the generic HTML event, and now also clears `L:Generic_Gear_Advisory_Active` while marking `L:Generic_Gear_Advisory_Acknowledged`. Verified with `tsc --noEmit`, a local runtime harness, and an exterior-only DevApi smoke on 2026-05-11: writing the H event recorded `GENERIC_GEAR_ADVISORY_PUSH`, cleared the active local var to `0`, set the acknowledged local var to `1`, had zero error diagnostics, and settled back to about 60 FPS after startup sampling filled.
  - Follow-up cockpit diagnostics expose a phase breakdown for `AircraftRuntime.update()` through `window.__DevApi.report().data.perf.cockpitPerf.runtimeProfile` when `?cockpitPerf=1` is enabled, separating host tick, update bindings, interaction feedback, animation, mixer, wing flex, visibility, and material binding time. Verified with `tsc --noEmit` and Agent Browser on 2026-05-12: the A320 LOD1 cockpit route reported 24/24 loaded gauges, 18 captures, and runtime profile binding counts for 569 animation, 119 visibility, 640 material, and 537 update bindings.
  - Follow-up DevApi runtime-host diagnostics expose variable read cache hit/miss counts through `window.__DevApi.report().data.perf.runtimeHost`, so cockpit performance work can distinguish raw read volume from per-frame cache misses without reaching into private globals. Verified with `tsc --noEmit` and Agent Browser on 2026-05-12: the A320 LOD1 cockpit report included `variableReadCacheHitCount` / `variableReadCacheMissCount` and a settled 60 FPS sample.
  - Follow-up runtime cache optimization now keys per-frame variable reads by normalized variable name plus normalized unit, so equivalent RPN reads with case/spacing differences share the same cached value. Verified with `tsc --noEmit` and Agent Browser on 2026-05-12: the A320 LOD1 cockpit route reported about 58.6 FPS, 24/24 loaded gauges, 18 captures, and runtime profile median update time about 7.4 ms.
    - Second-aircraft verification on 2026-05-12 used the A330 LOD0 cockpit route because A330 LOD1 is a 5-mesh low-detail interior with no VCockpit surface binding. A330 LOD0 reported 24/24 loaded gauges, 18 captures, 6 `loaded-wasm-bridge` gauges, zero gauge issue groups, the two known PTU template warnings, and about 59.9 FPS with runtime median update time about 5.4 ms.
    - The same A330 LOD0 DevApi session verified generic control behavior: `GEAR_DOWN` moved gear handle/animation state to deployed, `FLAPS_INCR` moved flap SimVars and flap animations to 25 percent, and `SPOILERS_SET` with the MSFS 16k half-scale argument `8192` moved spoiler SimVars and spoiler animations to about 50 percent.
    - A fresh A330 LOD0 MCDU smoke on 2026-05-12 verified `PUSH_MCDUL_MENU` and `PUSH_MCDUL_L1` through `window.__DevApi.click()`: both clicks executed, the loaded/captured `A339X/MCDU/mcdu.html` gauge reported zero script/resource/bridge errors, and the runtime received `A320_Neo_CDU_1_BTN_MENU` plus `A320_Neo_CDU_1_BTN_L1` HTML events.
    - DevApi control parameter presets now cover `gear`, `flaps`, `spoilers`, and `parkingBrake`, mapping `checkParam()` / `setParam()` to generic runtime SimVars (`A:GEAR HANDLE POSITION`, `A:FLAPS HANDLE PERCENT`, `A:SPOILERS HANDLE POSITION`, and `A:BRAKE PARKING POSITION`). Verified on 2026-05-12 with the A320 LOD1 cockpit route: `setParam()` moved those runtime values and the matching gear/flap/spoiler animations without requiring agents to remember MSFS 16k key-event scaling.
  - Follow-up interaction feedback support now honors authored `SWITCH_POSITION_TYPE` / `SWITCH_POSITION_VAR` animation variables in addition to the fallback `O:<target>:_ButtonAnimVar` pulse state. Verified on 2026-05-12 with `tsc --noEmit` and Agent Browser on the A320 LOD1 cockpit route: holding `PUSH_MCDUL_MENU` through DevApi raised `L:A32NX_MCDU_PUSH_ANIM_1_MENU` to `0.6`, emitted `H:A320_Neo_CDU_1_BTN_MENU`, then released and decayed both the authored L-var and fallback O-var to `0` with only the known PTU warning. Second-aircraft verification on the A330 LOD0 cockpit route produced the same held/released authored/fallback animation behavior and event dispatch.
  - Follow-up DevApi release support now mirrors pointer release for callback-backed held interactions by sending a `LeftRelease` callback before clearing held feedback. Verified on 2026-05-12 with `tsc --noEmit` and Agent Browser on the A330 LOD0 cockpit route: holding and releasing `PUSH_MCDUL_CLR` returned `L:A32NX_MCDU_PUSH_ANIM_1_CLR` and `L:A32NX_MCDU_CLR_Pressed` to `0`, reported `callbackReleased: true`, and preserved the `A320_Neo_CDU_1_BTN_CLR` HTML event dispatch.
    - Active regression verification on 2026-05-14 used fresh A320 and A330 LOD0 cockpit sessions with `window.__DevApi`. On both routes, `PUSH_MCDUL_MENU`, `PUSH_MCDUL_L1`, and held `PUSH_MCDUL_CLR` each executed once; the runtime emitted the expected `A320_Neo_CDU_1_BTN_MENU`, `A320_Neo_CDU_1_BTN_L1`, and `A320_Neo_CDU_1_BTN_CLR` HTML events; `L:A32NX_MCDU_CLR_Pressed` rose to `1` while held and returned to `0` on `release()`. `setParam("gear", 0)`, `setParam("flaps", 50, "percent")`, `setParam("spoilers", 50, "percent")`, and `setParam("parkingBrake", 1)` moved the generic control SimVars on both routes; A320 also emitted stock flap animation trigger effects. Both routes kept zero gauge issue groups after the active actions.
  - Follow-up runtime support keeps alternate stock bus-connection SimVar forms coherent when `ELECTRICAL_BUS_TO_BUS_CONNECTION_TOGGLE` fires from lighting/electrical templates. The demo runtime now toggles the paired source/target form, reverse paired form, and unprefixed endpoint forms together, covering mounted stock reads such as `(A:BUS CONNECTION ON:#BUS_ID#, Bool)` and `(A:1:BUS CONNECTION ON:#BUS_ID#, Bool)` without aircraft-specific aliases. Verified with `tsc --noEmit` and a local Bun runtime harness on 2026-05-11: toggling bus `4` to bus `1` moved `A:4:BUS CONNECTION ON:1`, `A:1:BUS CONNECTION ON:4`, `A:BUS CONNECTION ON:4`, and `A:BUS CONNECTION ON:1` through `1 -> 0 -> 1`. Verified with `agent-browser` and `window.__DevApi` on A330 and A320 exterior-only routes: both routes toggled the same four SimVars through `1 -> 0 -> 1`, had zero diagnostics, and settled around 60 FPS after the A320 sample window filled; screenshots captured to `backups/agent-browser/bus-connection-support/`.
- [x] Support standalone RPN conditional blocks and register labels seen in mounted stock/built XML.
  - The RPN compiler now treats standalone `{ ... }` blocks as conditional blocks and accepts `:N` register labels as label markers.
  - Verified with `agent-browser` on 2026-05-09:
    - A330 route `?cockpitInteractionHitboxes&cockpitPerf` compiled 735 animation bindings, 811 interaction bindings, 617 update bindings, and 456 visibility bindings with zero unsupported RPN diagnostics.
    - A320 route `?package=/aircrafts/flybywire-aircraft-a320-neo/&aircraft=SimObjects/AirPlanes/FlyByWire_A320_NEO%23fltsim.0&cockpitInteractionHitboxes&cockpitPerf` compiled 665 animation bindings, 719 interaction bindings, 537 update bindings, and 383 visibility bindings with zero unsupported RPN diagnostics.
    - Screenshots captured to `/tmp/screenshot-1778336474838.png` and `/tmp/screenshot-1778336519179.png`.
  - Follow-up support implements generic `gN` jumps to `:N` labels, including jumps emitted from inside nested `if{}` blocks, so stock enum-mapping code can short-circuit after the first matching branch instead of continuing through later cases.
  - Verified with `tsc --noEmit`, local RPN harnesses, and direct Chrome DevTools Protocol on 2026-05-11: A330 and A320 exterior-only routes both had zero diagnostics; in-browser dynamic imports of `src/msfs/rpn.ts` compiled and evaluated simple true/false jump cases plus a pressurization-style bleed-air enum expression using `g2` / `:2`; screenshots captured to `backups/agent-browser/rpn-goto-label-support/`.
- [x] Treat empty stock animation-template expansions as no-ops.
  - Stock `ASOBO_GT_Anim` / `ASOBO_GT_Anim_Code` shortcut compilation now skips expansions whose required `ANIM_NAME` and animation source parameters resolve empty, while direct `<Animation>` nodes still emit validation diagnostics when malformed.
  - Verified with `agent-browser` on 2026-05-09:
    - A330 route `?cockpitInteractionHitboxes&cockpitPerf` compiled 735 animation bindings, 811 interaction bindings, 617 update bindings, and 456 visibility bindings with zero `animation_params_missing` diagnostics.
    - A320 route `?package=/aircrafts/flybywire-aircraft-a320-neo/&aircraft=SimObjects/AirPlanes/FlyByWire_A320_NEO%23fltsim.0&cockpitInteractionHitboxes&cockpitPerf` compiled 665 animation bindings, 719 interaction bindings, 537 update bindings, and 383 visibility bindings with zero `animation_params_missing` diagnostics.
    - Screenshots captured to `/tmp/screenshot-1778336775658.png` and `/tmp/screenshot-1778336805084.png`.
- [x] Support direct `<Update ...>` nodes.
- [x] Support `ASOBO_GT_Anim` in simvar and code forms.
- [x] Verify generic cockpit interaction press/release behavior on A330 and A320.
  - Implemented data capture for interaction `MIN_HELD_DURATION`, `ANIM_DURATION`, `LEFT_LEAVE_CODE`, `LEFT_RELEASE_CODE`, and default-IM release variants from expanded behavior template parameters.
  - Runtime now executes press code on pointerdown, release code on pointerup or after positive `MIN_HELD_DURATION`, and avoids hardcoded visual pulse timing.
  - Verified with `agent-browser` on 2026-05-09:
    - A330 route `?cockpitInteractionHitboxes&cockpitPerf` entered cockpit LOD00 with 780 interaction bindings, 1210 mapped pickable meshes, and 12 fallback hitboxes; synthetic pointerdown/up on `PUSH_MCDUL_CLR` executed once, set `L:A32NX_MCDU_CLR_Pressed` to `1` on press, and returned it to `0` after release/update.
    - A320 route `?package=/aircrafts/flybywire-aircraft-a320-neo/&aircraft=SimObjects/AirPlanes/FlyByWire_A320_NEO%23fltsim.0&cockpitInteractionHitboxes&cockpitPerf` entered cockpit LOD00 with 688 interaction bindings, 1115 mapped pickable meshes, and 20 fallback hitboxes; synthetic pointerdown/up on `PUSH_MCDUL_CLR` executed once, set `L:A32NX_MCDU_CLR_Pressed` to `1` on press, and returned it to `0` after release/update.
    - Screenshots captured to `/tmp/msfs-a330-updated-cockpit.png`, `/tmp/msfs-a330-interaction-click.png`, `/tmp/msfs-a320-interactions.png`, and `/tmp/msfs-a320-interaction-click.png`.
- [x] Verify cockpit interaction occlusion on A330 and A320.
  - Exact interaction-mesh picking now uses a cached non-interactive occluder mesh registry with bounding-box prefiltering, so seats/panels/materials can block controls without restoring full-scene cockpit raycasting.
  - The miss diagnostic now preserves `lastMissReason = "occluded"` when all candidate hits are rejected by occlusion instead of overwriting the result with `no-bound-interaction`.
  - Verified with `agent-browser` on 2026-05-09:
    - A330 route reported 743 occluder meshes; an occlusion scenario with `SWITCH_CONSOLE_BRIGHT_FO` blocking `HANDLING_Switch_Wiper_left` produced no execution and `lastMissReason: "occluded"`.
    - A320 route reported 1634 occluder meshes; an occlusion scenario with `WIPER_WIPER_L_1` blocking `COCKPIT_COFFEE_R` produced no execution and `lastMissReason: "occluded"`.
- [x] Replace remaining mirrored stock-template fallbacks where the general XML evaluator can do so safely.
  Verified:
  - the built-in stock-template fallback path has been removed from the compiler
  - the active A320/A330 fixture routes still compile and run cleanly through the mounted official XML path with `builtinFallbackHits = []`
- [x] Resolve `FBW_AIRBUS_Update_PTU_Template`.
  - Blocked on missing package content: both active fixture model XMLs reference `FBW_AIRBUS_Update_PTU_Template`, but that template is not defined in either aircraft package or the mounted stock XML set.
  - `vendor/msfs-stock/ModelBehaviorDefs/Asobo/Airliner/Airbus.xml` defines `ASOBO_AIRBUS_Update_PTU_Template`, but mapping `FBW_` to `ASOBO_` would be a package/vendor-specific alias guess, so no fallback was added.
  - Current verified state on 2026-05-10: A330 and A320 routes each have exactly one behavior diagnostic, this missing template; both routes report zero unsupported RPN diagnostics and `builtinFallbackHits = []`.

#### Stock XML Files

Scope note:
- See [stock-support-scope.md](stock-support-scope.md) for the currently exercised public stock XML set on the A320/A330 fixture routes.
- The current fixture include graph exercises `Common.xml`, `Common/Index.xml`, `Exterior.xml`, `Generic.xml`, `Generic/FX.xml`, and `Generic/Index.xml`.
- XML files outside that exercised set should stay unchecked until they are either:
  - exercised and verified on the fixture routes, or
  - explicitly documented as blocked / out of current runtime scope.

##### AircraftTypes

- [ ] `AircraftTypes/Gliders.xml`
- [ ] `AircraftTypes/Rotorcrafts.xml`

##### Airliner

- [ ] `Airliner/AS02A.xml`
- [ ] `Airliner/Airbus.xml`
- [ ] `Airliner/AirlinerCommon.xml`
- [ ] `Airliner/Boeing.xml`
- [ ] `Airliner/FMC.xml`
- [ ] `Airliner/GlassCockpit.xml`
- [ ] `Airliner/Inputs/Airliner_Inputs.xml`

##### Common

- [x] `Common.xml`
- [x] `Common/Aircraft.xml`
- [x] `Common/Autopilot.xml`
- [x] `Common/Deice.xml`
- [x] `Common/Electrical.xml`
- [x] `Common/Engine.xml`
- [x] `Common/Fuel.xml`
- [x] `Common/Handling.xml`
- [x] `Common/Index.xml`
- [x] `Common/Instrument.xml`
- [x] `Common/LandingGear.xml`
- [x] `Common/Lighting.xml`
- [x] `Common/Passenger.xml`
- [x] `Common/Pilot.xml`
- [x] `Common/Pressurization.xml`
- [x] `Common/Safety.xml`

##### Common Inputs

- [x] `Common/Inputs/Aircraft_Inputs.xml`
- [x] `Common/Inputs/Autopilot_Inputs.xml`
- [x] `Common/Inputs/Common_Inputs.xml`
- [x] `Common/Inputs/Deice_Inputs.xml`
- [x] `Common/Inputs/Electrical_Inputs.xml`
- [x] `Common/Inputs/Engine_Inputs.xml`
- [x] `Common/Inputs/Fuel_Inputs.xml`
- [x] `Common/Inputs/Handling_Inputs.xml`
- [x] `Common/Inputs/Instrument_Inputs.xml`
- [x] `Common/Inputs/LandingGear_Inputs.xml`
- [x] `Common/Inputs/Lighting_Inputs.xml`
- [x] `Common/Inputs/Passenger_Inputs.xml`
- [x] `Common/Inputs/Pressurization_Inputs.xml`
- [x] `Common/Inputs/Safety_Inputs.xml`
  - These three files are wrapper presets that only extend `ASOBO_GIE_Anim_Handling` with their input-event source names; the detailed XML tree checklist already marks their nodes complete.

##### Common Subtemplates

- [x] `Common/Subtemplates/Aircraft_Subtemplates.xml`
- [x] `Common/Subtemplates/Autopilot_Subtemplates.xml`
- [x] `Common/Subtemplates/Deice_Subtemplates.xml`
- [x] `Common/Subtemplates/Electrical_Subtemplates.xml`
- [x] `Common/Subtemplates/Engine_Subtemplates.xml`
- [x] `Common/Subtemplates/Fuel_Subtemplates.xml`
- [x] `Common/Subtemplates/Handling_Subtemplates.xml`
- [x] `Common/Subtemplates/Instrument_Subtemplates.xml`
- [x] `Common/Subtemplates/LandingGear_Subtemplates.xml`
- [x] `Common/Subtemplates/Lighting_Subtemplates.xml`
- [x] `Common/Subtemplates/Passenger_Subtemplates.xml`
- [x] `Common/Subtemplates/Pressurization_Subtemplates.xml`
- [x] `Common/Subtemplates/Safety_Subtemplates.xml`

##### Exterior

- [x] `Exterior.xml`

##### GPS

- [ ] `GPS/AS430.xml`
- [ ] `GPS/AS530.xml`
- [ ] `GPS/Aera.xml`
- [ ] `GPS/Inputs/AS430_Inputs.xml`
- [ ] `GPS/Inputs/Aera_Inputs.xml`

##### Generic

- [x] `Generic.xml`
- [x] `Generic/AnimationTriggers.xml`
- [x] `Generic/Animations.xml`
- [x] `Generic/Emissive.xml`
- [x] `Generic/FX.xml`
- [x] `Generic/Helpers.xml`
- [x] `Generic/Index.xml`
- [ ] `Generic/Interactions.xml`
- [x] `Generic/Updates.xml`
- [x] `Generic/Visibility.xml`

##### Generic Complex

- [ ] `Generic/Complex/Index.xml`
- [ ] `Generic/Complex/Joystick.xml`
- [ ] `Generic/Complex/Knob.xml`
- [ ] `Generic/Complex/Lever.xml`
- [ ] `Generic/Complex/Misc.xml`
- [ ] `Generic/Complex/PushButton.xml`
- [ ] `Generic/Complex/Switch.xml`

##### Generic Subtemplates

- [ ] `Generic/Subtemplates/Animations_Subtemplates.xml`
- [ ] `Generic/Subtemplates/Interactions_Subtemplates.xml`
- [ ] `Generic/Subtemplates/Updates_Subtemplates.xml`

##### GlassCockpit

- [ ] `GlassCockpit/AS1000.xml`
- [ ] `GlassCockpit/AS3000.xml`
- [ ] `GlassCockpit/AS307.xml`
- [ ] `GlassCockpit/AS3X.xml`
- [ ] `GlassCockpit/AS3X_Touch.xml`
- [ ] `GlassCockpit/AS5.xml`
- [ ] `GlassCockpit/AS580.xml`
- [ ] `GlassCockpit/AS650.xml`
- [ ] `GlassCockpit/Inputs/AS1000_Inputs.xml`
- [ ] `GlassCockpit/Inputs/AS3X_Inputs.xml`
- [ ] `GlassCockpit/Inputs/AS5_Inputs.xml`

##### Inputs

- [ ] `Inputs/Generic.xml`
- [ ] `Inputs/Helpers.xml`
- [ ] `Inputs/Index.xml`
- [ ] `Inputs/Templates.xml`

##### Misc

- [ ] `Misc/ASDigiflo.xml`
- [ ] `Misc/ASDigitalFuelMeter_FP5L.xml`
- [ ] `Misc/ASPropeller.xml`
- [ ] `Misc/ASVigilus.xml`
- [ ] `Misc/AS_EPM.xml`
- [ ] `Misc/Accelerometer.xml`
- [ ] `Misc/Clock.xml`
- [ ] `Misc/GX2.xml`
- [ ] `Misc/GroundVehicles.xml`
- [ ] `Misc/Pl463.xml`
- [ ] `Misc/SimObjects.xml`
- [ ] `Misc/VoltsAmps.xml`
- [ ] `Misc/Inputs/Misc_Inputs.xml`

##### NAVCOM

- [x] `NAVCOM/ADF.xml`
- [x] `NAVCOM/AS92.xml`
- [x] `NAVCOM/ASNAV.xml`
- [x] `NAVCOM/KAP140.xml`
- [x] `NAVCOM/NavComSystem.xml`
- [x] `NAVCOM/SimpleCom.xml`
- [x] `NAVCOM/Inputs/NavComSystem_Inputs.xml`
- [x] `NAVCOM/Inputs/SimpleCom_Inputs.xml`

##### Transponder

- [x] `Transponder/AS21.xml`
- [x] `Transponder/AS330.xml`
- [x] `Transponder/Transponder.xml`

Checked stock XML families in this batch are limited to the families covered by the generic runtime/input work and A320/A330 DevApi verification above:
- Common aircraft, handling, landing-gear, fuel, electrical, deice, engine, instrument, common-procedure, and autopilot event support was implemented from the mounted public XML paths and verified on both fixture routes with screenshots under the matching `backups/agent-browser/*-support/` folders.
- NAVCOM and Transponder support was implemented from `Asobo/NAVCOM/*` and `Asobo/Transponder/*` plus their input XMLs, then verified on both fixture routes with `backups/agent-browser/navcom-transponder-support/` screenshots.
- GPS, glass cockpit, generic complex, and misc XML families remain unchecked because their mounted stock XML contracts have not yet been exercised and verified as complete on both fixture routes.
- Lighting, pressurization, safety, and electrical subtemplate coverage is checked in this batch because the mounted XML paths were reviewed, generic compiler/runtime support exists for their stock input-event/key-event patterns, and A330/A320 DevApi verification with screenshots is recorded above under the matching support folders.

#### CFG Reference Targets

- [ ] `Additional_Information/File_Formats/CFG_Files.htm`
- [ ] `Content_Configuration/Cameras/Cameras_CFG/cameras_cfg.htm`
- [ ] `Content_Configuration/Models/model_cfg.htm`
- [ ] `Content_Configuration/SimObjects/Aircraft_SimO/Aircraft.htm`
- [ ] `Content_Configuration/SimObjects/Aircraft_SimO/aircraft_cfg.htm`
- [x] `Content_Configuration/SimObjects/Aircraft_SimO/cockpit_cfg.htm`
- [x] `Content_Configuration/SimObjects/Aircraft_SimO/engines_cfg.htm`
- [x] `Content_Configuration/SimObjects/Aircraft_SimO/flight_model_cfg.htm`
- [ ] `Content_Configuration/SimObjects/Aircraft_SimO/gameplay_cfg.htm`
- [x] `Content_Configuration/SimObjects/Aircraft_SimO/Instruments/panel_cfg.htm`
- [x] `Content_Configuration/SimObjects/Aircraft_SimO/systems_cfg.htm`
- [x] `Content_Configuration/SimObjects/Aircraft_SimO/target_performance_cfg.htm`
- [ ] `Content_Configuration/SimObjects/Living_Things/Living_Things_sim_cfg.htm`
- [ ] `Content_Configuration/Textures/texture_cfg.htm`

#### Reference Docs Pack

- [ ] `html/Introduction/Using_The_SDK.htm`
- [ ] `html/Introduction/Introduction.htm`
- [ ] `html/Content_Configuration/Models/Models.htm`
- [x] `html/Content_Configuration/Models/Model_Definitions.htm`
- [x] `html/Content_Configuration/Models/Model_Animation_Definitions.htm`
- [x] `html/Content_Configuration/Models/ModelBehaviors/Model_Behaviors.htm`
- [x] `html/Content_Configuration/Models/ModelBehaviors/General_Template_Definitions.htm`
- [x] `html/Content_Configuration/Models/ModelBehaviors/Input_Event_Definitions.htm`
- [x] `html/Content_Configuration/Models/ModelBehaviors/TemplateExplorer/Template_Explorer.html`
- [x] `html/mergedProjects/How_To_Make_An_Aircraft/Contents/Model_Behaviours/Default_Templates.htm`
- [ ] `html/Asset_Creation/3D_Models/General_Principles.htm`
- [ ] `html/Asset_Creation/Blender_Plugin/The_Blender_Plugin.htm`
- [ ] `html/Content_Configuration/SimObjects/SimObjects.htm`
- [x] `html/Content_Configuration/SimObjects/Aircraft_SimO/flight_model/interactive_points.htm`
- [ ] `html/Content_Configuration/VisualEffects/Visual_Effects_Landing_Templates.htm`
- [ ] `html/Content_Configuration/Checklists/Checklists.htm`
- [ ] `msfs2024/html/3_Models_And_Textures/Plugins/glTF_Schemas.htm`
- [ ] `msfs2024/flighting/html/3_Models_And_Textures/Textures/Materials/FlightSim_Materials.htm`
- [ ] `msfs2024/html/3_Models_And_Textures/Textures/Materials/FlightSim_Material_Parameters.htm`
- [x] `msfs2024/flighting/html/6_Programming_APIs/SimVars/Aircraft_SimVars/Aircraft_FlightModel_Variables.htm`
- [ ] `html/mergedProjects/How_To_Make_An_Aircraft/Contents/Modelling/Airframe/Texturing/Surface_Detail__agt_index.htm`

#### Template Explorer HTML Pack

- [x] Download the rendered Template Explorer HTML pages for the mounted stock XML set.
- [x] Keep the rendered HTML pack separate from the mounted runtime XML pack.
- [x] Use the rendered HTML pages as reference/debug support only, not as runtime behavior sources.

### 3. Implement Broader Generic CFG Support For Targeted MSFS CFG Files

- [x] Expand runtime and importer support beyond the current `aircraft.cfg`, `model.cfg`, and `texture.cfg` scope using the targeted CFG docs above.
- [x] Keep the CFG implementation authoritative to the mirrored docs and actual package data.

### 4. Verify A330 And A320 Routes After Each Completed Batch

- [x] Keep the A330 route clean after each completed batch.
- [x] Keep the A320 route clean after each completed batch.
- [ ] Replace mirrored fallbacks only when the official mounted XML path matches or exceeds current behavior.

### 5. Fix Lighting Issue Where Surfaces Look Too White When Viewed Directly

- [x] Reproduce and fix the direct-view lighting/whitening issue with a generic MSFS-compatible renderer or material change.
  - Fixed generically by unifying the active WebGL path onto `WebGPURenderer({ forceWebGL: true })` and keeping one shared PMREM/environment/material stack before falling back to legacy `WebGLRenderer`.

### 6. Fix The WebGPU Wing Lighting/Reflection Jitter During Camera Motion

- [x] Reproduce and fix the WebGPU wing lighting/reflection jitter with a generic renderer or material change.
  - Fixed generically by routing compressed RG normal maps through the existing WebGPU node-material decode path instead of leaving them on the incorrect plain-material path.

### 7. Revisit The A320 Wing Structure / Transform Issue

- [ ] Revisit the A320 wing structure/transform issue after stock XML and CFG coverage is expanded.
- [ ] Implement generic model-level `NodeAnimation` runtime support from official docs.
  Documented-first scope:
  - [x] Audit and list all `NodeAnimation` types present in mounted aircraft fixtures and stock docs.
  - [x] Confirm which `NodeAnimation` fields are already parsed and preserved from model XML.
  - [x] Implement generic runtime plumbing for documented `NodeAnimation` inputs and node targets.
  - [x] Implement `NodeAnimation type="WingFlex"` only up to the published contract:
    `WING FLEX PCT`, `wingflex_scalar`, `wingflex_surface_scalar`, `wingflex_offset`, and the documented 12-node layout.
  - [x] If the exact node deformation math is still not published, mark the remaining transform behavior as blocked rather than guessing.
  - [ ] Verify A320 and A330 with agent-browser screenshots before checking this item off.
  Current status:
  - 2026-05-13 audit: the mounted A320 and A330 model XML fixtures only contain `NodeAnimation type="WingFlex"`; the mounted stock XML mirror has no additional `NodeAnimation` entries. The importer currently preserves the documented `type` attribute and ordered `Node` list in `ModelNodeAnimation`.
  - The importer preserves `NodeAnimation type="WingFlex"` nodes and the runtime has generic plumbing for documented node targets and simvar/cfg inputs.
  - The runtime deliberately returns no WingFlex deformation bindings until the exact deformation math is backed by official docs or direct authoritative package/runtime evidence.
  - 2026-05-03: the implicit primitive/material-order decal depth-bias experiment for `ASOBO_material_blend_gbuffer` materials without explicit `ASOBO_material_draw_order` was rejected after A320 testing showed worse z-fighting; keep it reverted.
  - 2026-05-03: A32NX/A330 flap comparison found this is not a WingFlex or skin bind-pose bug. The affected A32NX `FLAPS_02_*` and `FLAPS_01_*` meshes contain `WINGS` base primitives and `ASOBO_material_blend_gbuffer` decal primitives (`METALFLAPS`, plus `RIBBONS` on `FLAPS_02_*`) inside the same skinned mesh. In bind pose, before runtime animation, `METALFLAPS` vertices already sit about 1.5-1.9 mm median from the covered `WINGS` surface, with p95 offsets about 4.1-5.1 mm. The current A330 flap meshes use ordinary `A339_AIRFRAME_WING_PARTS` / `A339_AIRFRAME_BLACK` primitives and do not have comparable flap-local blend-gbuffer decal primitives, matching the report that A330 does not show this issue.
  - 2026-05-03: landed generic renderer/depth work instead of a material-specific offset: blend-gbuffer drawables stay in their original base-pass layers and are added to the decal layer; the base pass hides blend materials, the decal pass hides non-blend materials on those drawables; the camera clip planes are tightened from visible per-mesh bounds with exact rest-pose skinned boxes. A320 browser verification reached `near ~= 0.027m` in the close flap view instead of the old `0.01m` floor.
  - 2026-05-03 follow-up: the first depth-only pass was not enough. The renderer now treats `ASOBO_material_blend_gbuffer` as a special decal pass closer to the SDK contract: decals render after the base/deferred pass and before normal transparent content; WebGPU node materials mask decal fragments against the base scene depth texture instead of relying on hardware depth fighting or polygon-offset bias. Split glTF primitives recover deterministic MSFS decal render order from `ASOBO_material_draw_order` plus original primitive/sub-material order.
  - 2026-05-03 deeper follow-up: depth masking fixes only visibility/occlusion. It does not resolve the A32NX flap surface alignment by itself because the viewer still shades the authored decal geometry as a forward surface. MSFS decals are not equivalent to independent forward transparent meshes; the SDK describes geometry decals as a special pass over a covered mesh with per-component blend factors into the background material/G-buffer.
  - 2026-05-03 fix: added a generic same-mesh `ASOBO_material_blend_gbuffer` projection fallback for this forward renderer. When a loaded glTF mesh instance has ordinary base primitives and blend-gbuffer decal primitives as siblings, the decal primitive bind-pose positions, normals, tangents, and skin influences are projected/interpolated from the sibling base primitives. This is intentionally limited to sibling primitives from the same loaded mesh instance, uses no aircraft names, material-name exceptions, draw-order offsets, distance thresholds, or polygon-offset tuning, and addresses the A32NX/A330 structural difference above. Full deferred/G-buffer blending is still needed for exact MSFS component-level material fidelity.
  - 2026-05-03 browser verification: A32NX WebGPU exterior load with `exteriorInterior=off` produced no page/console errors and a stable close-up of the left flap area. Runtime skinned geometry checks put all four A32NX `METALFLAPS` primitives within `2.8e-7m` max of their sibling `WINGS` surfaces after projection. The A339X exterior route also loaded cleanly after the generic change.
  - 2026-05-03 angle-clipping follow-up: projected same-surface decals still exposed exact depth-equality failure at grazing and zoomed-out views. The WebGPU decal mask now uses both the decal fragment and copied scene depth screen-space derivatives as the same-surface allowance, instead of a constant polygon offset or aircraft/material exception. A32NX wing-root, zoomed-out top-down, and oblique browser verification showed the flap decals no longer broadly clip while the fuselage still occludes them.
  - 2026-05-03 second angle-clipping follow-up: the remaining A32NX strips were isolated to color-contributing `METALFLAPS`, not `WingFlex` or zero-color `RIBBONS`. The renderer now keeps component-only `ASOBO_material_blend_gbuffer` materials (`baseColorBlendFactor=0` and `emissiveBlendFactor=0`) out of the forward color decal pass, and projected decal meshes measure their own projection displacement plus post-projection receiver residual. That geometry-derived envelope is added to the depth mask so large projected decal triangles that span receiver creases do not clip between projected vertices. This is generic material/geometry handling; it does not use aircraft names, material-name exceptions, draw-order offsets, or tuned polygon offsets.
  - The exact `WingFlex` node deformation math remains blocked by missing public documentation; do not re-enable the prior transform approximation unless authoritative math becomes available.
- [ ] If it still remains after the stock-support work, fix it generically, non-heuristically, and not aircraft-specifically.

### 8. Finish Selectable Cockpit / Interior LOD Support

- [x] Finish generic `?interiorLod=` support for cockpit/interior-view model loading.
  Current status:
  - local implementation is in progress in `src/main.ts`
  - `docs/query-parameters.md` has been updated locally to describe `interiorLod`
  - 2026-05-05: `bunx tsc --noEmit` equivalent via MCP TypeScript check passed with 0 diagnostics
  - 2026-05-05: added `typecheck` and `lint` package scripts backed by the repo's existing strict TypeScript validation; `bun run lint` passed
  - 2026-05-05: default A330 route opened cleanly through `agent-browser`; screenshot saved at `backups/agent-browser/interior-lod-verification/default-a330.png`
  - 2026-05-05: `/tmp/headwindsim-aircraft-a330-900/` and `/tmp/flybywire-aircraft-a320-neo/` fixture package roots were not present, so fixture-package A320/A330 route verification is blocked in this environment
  - 2026-05-05: `agent-browser` repeatedly reached explicit `interiorLod` routes but became unresponsive during screenshot capture even with a 20-second wait; direct Chrome headless captures with `--disable-gpu` completed, but those screenshots are invalid because the viewer failed with `Error creating WebGL context`
  - 2026-05-05: `agent-browser` investigation found the normal headless route drives Chrome's SwiftShader WebGL GPU helper above 300% CPU after viewer initialization; disabling all 3D APIs keeps `agent-browser` responsive but prevents the viewer from creating WebGL, and headed mode avoids the CPU spike but still hangs in `agent-browser screenshot` after the live canvas route initializes
  - 2026-05-05: forcing `agent-browser` Chrome onto WebGPU with `--enable-unsafe-webgpu,--enable-dawn-features=allow_unsafe_apis` kept the `?interiorLod=0` route responsive after a 20-second wait; runtime eval confirmed `WebGPUBackend`, and screenshot succeeded at `backups/agent-browser/interior-lod-verification/a330-interior-lod-0-agentbrowser-webgpu2-wait20.png`
  - 2026-05-05: the same WebGPU setup confirmed `WebGPUBackend` for `?interiorLod=1` after the 20-second wait, but still hung during screenshot capture; LOD1 visual verification remains pending
  - 2026-05-05: pressing `C` without focusing the canvas did not activate cockpit view; after focusing the canvas first, cockpit activation entered a heavier load path and did not return runtime stats within the timeout, even with `vcockpitSurfaces=off&cockpitTextures=range-low`; selected active interior LOD confirmation remains pending
  - 2026-05-05: user manually verified the remaining `interiorLod` runtime/visual behavior and requested this item be checked off
  Required behavior:
  - omitted, empty, or `auto` keeps the default cockpit/interior-view path
  - explicit values are validated as zero-based nonnegative integers
  - selected values are clamped to available interior LODs only after the active aircraft/interior model is known
  - cockpit activation, cockpit benchmarks, range-low cockpit texture loading, VCockpit surface binding, cockpit static batching experiments, runtime diagnostics, settings profiles, and query documentation all refer to the selected cockpit/interior LOD rather than assuming LOD00
  - 2026-05-12: auto cockpit/interior-view LOD selection now uses package `layout.json` model and sibling-buffer sizes to skip oversized default LODs in the web viewer while preserving explicit `?interiorLod=0`; Agent Browser verified the A320 default route auto-selected cockpit LOD1, reached `gltf:interior-upgrade:ready`, loaded 21 gauge runtimes, captured 15 visible gauges, and stayed around 60 FPS
  Verification before checkoff:
  - run typecheck/lint
  - verify the default A330 route still starts cleanly
  - verify an A320 fixture route with default `auto`
  - verify at least one explicit `interiorLod=0` route
  - verify at least one explicit nonzero `interiorLod` route on a fixture that exposes it
  - keep this generic; do not add aircraft-name, material-name, or package-specific exceptions

### 9. Prototype Experimental Native HTML Gauge Texture Path

- [ ] Evaluate Three.js `r184+` `HTMLTexture` / HTML-in-Canvas support against the current WebGPU-first renderer stack.
- [ ] Add a query-gated `?vcockpitGaugeMode=htmlTexture` prototype that is used only when native browser feature detection succeeds.
- [ ] Detect and report native browser support for `drawElementImage`, `texElementImage2D`, and WebGPU `copyElementImageToTexture`.
- [ ] Keep the current optimized dirty-driven `CanvasTexture` path as the fallback for normal browsers and for incompatible gauge documents.
- [ ] Verify whether sandboxed same-origin MSFS gauge iframes, custom elements, SVG, loaded fonts, and nested gauge canvases render correctly through the native path.
- [ ] Compare long-session CPU stability, capture duration, upload timing, and visual correctness against the current canvas compositor on both A330 and A320 routes.
- [ ] Keep this mode blocked from default use until it works without aircraft-specific assumptions and without requiring unstable browser APIs for normal users.
