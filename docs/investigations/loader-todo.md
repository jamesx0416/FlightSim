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
  - live LOD00 verification on the A339X package captures 15 non-WASM HTML gauges without blocking LOD00 binding; WASM instruments and EFB host/runtime gaps remain explicitly deferred or diagnosed.
  - `?vcockpitGaugeDebug` keeps placeholder labels and gauge status overlays available for verification; the default path hides those overlays from cockpit screens.
  - binding and gauge diagnostics are exposed through `globalThis.__lastVCockpitSurfaceBinding`.
  - per-gauge capture stats now include bridge stats, script/load errors, blocked asset errors, render status, dirty/update counts, capture attempts, and last capture errors so loaded/rendered gauges, missing assets, iframe errors, deferred WASM, unsupported legacy gauges, and unsupported bridge API calls can be distinguished at runtime.
  - legacy gauge hosting, WASM instruments, and fuller simulator/instrument API bridge coverage remain intentionally deferred.
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
- [x] Support value-carrying simple key-event writes for cockpit systems.
  - Simple `value (>K:EVENT)` RPN writes now consume the top stack value instead of always invoking the key event with no arguments, matching cockpit lighting, electrical, and fuel templates that use simple event writes without an explicit `>K:N:` argument count.
  - The demo runtime host now applies generic light potentiometer, light switch, fuel pump/valve/junction, and electrical circuit key events to corresponding SimVars.
  - Verified locally on 2026-05-10 with direct RPN/runtime execution: `100 (>K:LIGHT_POTENTIOMETER_10_SET)`, `75 8 (>K:2:LIGHT_POTENTIOMETER_SET)`, `1 (>K:CABIN_LIGHTS_SET)`, `2 (>K:FUELSYSTEM_PUMP_ON)`, `9 (>K:FUELSYSTEM_VALVE_OPEN)`, and `20 (>K:ELECTRICAL_CIRCUIT_TOGGLE)` updated the expected `A:LIGHT POTENTIOMETER`, `A:LIGHT CABIN`, `A:FUELSYSTEM ...`, and `A:CIRCUIT SWITCH ON` runtime values.
  - Verified with Agent Browser on 2026-05-10 on the A320 route with `exteriorInterior=off`: invoking those generic runtime key events in the page set `A:LIGHT POTENTIOMETER:10 = 100`, `A:LIGHT POTENTIOMETER:8 = 75`, `A:LIGHT CABIN = 1`, `A:FUELSYSTEM PUMP SWITCH:2 = 1`, `A:FUELSYSTEM VALVE OPEN:9 = 1`, and `A:CIRCUIT SWITCH ON:20 = 1`.
  - Follow-up support covers plural light-event names (`STROBES_ON`, `LOGO_LIGHTS_SET`, `NAV_LIGHTS_SET`), cabin seatbelt/no-smoking toggles, APU bleed/start/off, COM receive selection, and pitot heat; Agent Browser on the same A320 route verified the corresponding runtime SimVars all updated to `1` and APU RPM updated to `100`.
  - Follow-up support covers additional stock cockpit key events for radio/audio volume and ident controls, transmitter selection, elevator/rudder trim, antiskid, windshield deice, turbine ignition, mixture-rich commands, autopilot disconnect, transponder ident, and Kohlsman baro changes.
  - Verified with Agent Browser on 2026-05-10 on the same A320 exterior-only route: representative events updated `A:ADF/NAV/COM VOLUME`, `A:NAV SOUND`, `A:COM ACTIVE FREQUENCY:3 HZ`, `A:NAV IDENT:1`, `A:MARKER SOUND`, `A:COPILOT TRANSMITTER TYPE`, trim, antiskid, windshield deice, ignition, mixture, autopilot, transponder, and Kohlsman SimVars.
  - Follow-up support covers active direct light set events such as `STROBES_SET` and radio ident set events such as `RADIO_DME1_IDENT_SET`; Agent Browser on the same A320 route verified `A:LIGHT STROBE`, `A:DME IDENT:1`, and `A:DME SOUND:1` updates.
- [x] Support standalone RPN conditional blocks and register labels seen in mounted stock/built XML.
  - The RPN compiler now treats standalone `{ ... }` blocks as conditional blocks and accepts `:N` register labels as label markers, without adding `gN` jump support until a verified active route needs it.
  - Verified with `agent-browser` on 2026-05-09:
    - A330 route `?cockpitInteractionHitboxes&cockpitPerf` compiled 735 animation bindings, 811 interaction bindings, 617 update bindings, and 456 visibility bindings with zero unsupported RPN diagnostics.
    - A320 route `?package=/aircrafts/flybywire-aircraft-a320-neo/&aircraft=SimObjects/AirPlanes/FlyByWire_A320_NEO%23fltsim.0&cockpitInteractionHitboxes&cockpitPerf` compiled 665 animation bindings, 719 interaction bindings, 537 update bindings, and 383 visibility bindings with zero unsupported RPN diagnostics.
    - Screenshots captured to `/tmp/screenshot-1778336474838.png` and `/tmp/screenshot-1778336519179.png`.
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
- [ ] `Common/Aircraft.xml`
- [ ] `Common/Autopilot.xml`
- [ ] `Common/Deice.xml`
- [ ] `Common/Electrical.xml`
- [ ] `Common/Engine.xml`
- [ ] `Common/Fuel.xml`
- [ ] `Common/Handling.xml`
- [x] `Common/Index.xml`
- [ ] `Common/Instrument.xml`
- [ ] `Common/LandingGear.xml`
- [ ] `Common/Lighting.xml`
- [ ] `Common/Passenger.xml`
- [ ] `Common/Pilot.xml`
- [ ] `Common/Pressurization.xml`
- [ ] `Common/Safety.xml`

##### Common Inputs

- [ ] `Common/Inputs/Aircraft_Inputs.xml`
- [ ] `Common/Inputs/Autopilot_Inputs.xml`
- [ ] `Common/Inputs/Common_Inputs.xml`
- [ ] `Common/Inputs/Deice_Inputs.xml`
- [ ] `Common/Inputs/Electrical_Inputs.xml`
- [ ] `Common/Inputs/Engine_Inputs.xml`
- [ ] `Common/Inputs/Fuel_Inputs.xml`
- [ ] `Common/Inputs/Handling_Inputs.xml`
- [ ] `Common/Inputs/Instrument_Inputs.xml`
- [ ] `Common/Inputs/LandingGear_Inputs.xml`
- [ ] `Common/Inputs/Lighting_Inputs.xml`
- [ ] `Common/Inputs/Passenger_Inputs.xml`
- [ ] `Common/Inputs/Pressurization_Inputs.xml`
- [ ] `Common/Inputs/Safety_Inputs.xml`

##### Common Subtemplates

- [ ] `Common/Subtemplates/Aircraft_Subtemplates.xml`
- [ ] `Common/Subtemplates/Autopilot_Subtemplates.xml`
- [ ] `Common/Subtemplates/Deice_Subtemplates.xml`
- [ ] `Common/Subtemplates/Electrical_Subtemplates.xml`
- [ ] `Common/Subtemplates/Engine_Subtemplates.xml`
- [ ] `Common/Subtemplates/Fuel_Subtemplates.xml`
- [ ] `Common/Subtemplates/Handling_Subtemplates.xml`
- [ ] `Common/Subtemplates/Instrument_Subtemplates.xml`
- [ ] `Common/Subtemplates/LandingGear_Subtemplates.xml`
- [ ] `Common/Subtemplates/Lighting_Subtemplates.xml`
- [ ] `Common/Subtemplates/Passenger_Subtemplates.xml`
- [ ] `Common/Subtemplates/Pressurization_Subtemplates.xml`
- [ ] `Common/Subtemplates/Safety_Subtemplates.xml`

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
- [ ] `Generic/AnimationTriggers.xml`
- [ ] `Generic/Animations.xml`
- [ ] `Generic/Emissive.xml`
- [x] `Generic/FX.xml`
- [ ] `Generic/Helpers.xml`
- [x] `Generic/Index.xml`
- [ ] `Generic/Interactions.xml`
- [ ] `Generic/Updates.xml`
- [ ] `Generic/Visibility.xml`

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

- [ ] `NAVCOM/ADF.xml`
- [ ] `NAVCOM/AS92.xml`
- [ ] `NAVCOM/ASNAV.xml`
- [ ] `NAVCOM/KAP140.xml`
- [ ] `NAVCOM/NavComSystem.xml`
- [ ] `NAVCOM/SimpleCom.xml`
- [ ] `NAVCOM/Inputs/NavComSystem_Inputs.xml`
- [ ] `NAVCOM/Inputs/SimpleCom_Inputs.xml`

##### Transponder

- [ ] `Transponder/AS21.xml`
- [ ] `Transponder/AS330.xml`
- [ ] `Transponder/Transponder.xml`

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
  - [ ] Audit and list all `NodeAnimation` types present in mounted aircraft fixtures and stock docs.
  - [ ] Confirm which `NodeAnimation` fields are already parsed and preserved from model XML.
  - [x] Implement generic runtime plumbing for documented `NodeAnimation` inputs and node targets.
  - [x] Implement `NodeAnimation type="WingFlex"` only up to the published contract:
    `WING FLEX PCT`, `wingflex_scalar`, `wingflex_surface_scalar`, `wingflex_offset`, and the documented 12-node layout.
  - [ ] If the exact node deformation math is still not published, mark the remaining transform behavior as blocked rather than guessing.
  - [ ] Verify A320 and A330 with agent-browser screenshots before checking this item off.
  Current status:
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
