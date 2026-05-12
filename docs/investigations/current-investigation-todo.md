# Current Investigation TODO

This file tracks the immediate investigation items for the live aircraft viewer.

## 1. Check Whether The `aircraft` Query Is Being Ignored

- Status: fixed.
- Findings:
  - the current portless default package contains only A330 aircraft IDs
  - the earlier A320 URL was not being “ignored”; it was falling back because that aircraft did not exist in the loaded package
  - aircraft IDs also contain `#fltsim.N`, so they must be URL-encoded as `%23fltsim.N`
- Implemented:
  - generic `package=` URL override so the loaded package root can be selected from the URL
  - requested-aircraft lookup now fails clearly instead of silently falling back to another aircraft
- Working A320 pattern:
  - `?package=/tmp/flybywire-aircraft-a320-neo/&aircraft=SimObjects/AirPlanes/FlyByWire_A320_NEO%23fltsim.0`

## 2. Check Whether WebGPU Lighting Is Darker Than WebGL

- Status: fixed to near parity.
- Findings:
  - WebGPU was materially darker on the portless A330 deployment
  - the remaining mismatch was not aircraft-specific lighting data
  - the main divergence was that the legacy WebGL path and the WebGPU/node-material path were no longer evaluating the same renderer/material stack
- Implemented:
  - replaced the split sky/fallback path with one shared PMREM environment path
  - removed the backend-specific hemisphere-light fallback path
  - moved the primary WebGL path onto `WebGPURenderer({ forceWebGL: true })` so WebGL and WebGPU share the same node-material pipeline before any legacy fallback is considered

## 3. Check Whether Reflections Jitter While The Camera Moves

- Status: fixed generically.
- Findings:
  - the visible shimmer was tied to the WebGPU compressed-normal path
  - compressed RG normal maps were not using the repo's intended WebGPU node-material decode path
- Implemented:
  - wired the dormant WebGPU compressed-normal decode/material path into the active material normalization flow
- Verification:
  - moving WebGPU capture sequence no longer shows the previous wing/reflection instability

## 4. Check Whether Aircraft Data/Metadata Controls Hidden Or Exposed Components

- Status: investigated, no change required yet.
- Audit the current generic visibility sources:
  - model behavior visibility bindings
  - material-level invisibility flags
  - draw/shadow-related material extensions
- Confirm whether there is a single authoritative “hide this component” flag or whether visibility is distributed across multiple MSFS systems.
- Document which mechanisms are currently supported by this loader and which are still missing.
- Keep the answer aircraft-generic and grounded in SDK/package evidence.

## 5. Check Whether Exterior Shell Meshes Are Inside-Out

- Status: fixed generically.
- Findings:
  - the A330 exterior shell issue reproduced in both WebGL and WebGPU, so it was not a renderer-only bug
  - the affected fuselage shell meshes were ordinary `Mesh` instances with positive transforms and normal `FrontSide` materials
  - forcing those materials to `DoubleSide` or `BackSide` immediately restored the shell, which proved the issue was triangle winding and face culling rather than hidden-node metadata
- Implemented:
  - added a generic MSFS winding-normalization pass that compares sampled geometric face normals against stored vertex normals
  - when an indexed opaque mesh is overwhelmingly inverted, the loader flips its triangle winding once during import
- Why it was missed:
  - earlier loader work focused on DDS/material/runtime issues, and this failure can look like a visibility or texture problem until culling is isolated directly
  - no single MSFS metadata flag was missing here; this was a geometry-compatibility issue in the optimized mesh path

## 6. Check Missing Texture Fallback Provenance

- Status: investigated, no change committed yet.
- Findings:
  - the current A320 missing glass names line up with shared fallback lookup, especially `../../../../texture/Glass`
  - `texture/Interiors` appears to be a generic fallback-chain entry, but it is not implicated by the specific missing A320 texture names currently under investigation
  - `GLASS_DEFAULTDIRT_COMP.PNG.DDS` and `GLASS_DETAILMAP02_MASK.PNG.DDS` are absent from the A320 package but do exist in the local A330 package, which is consistent with a shared/fallback asset expectation
  - `PASSENGER_DOOR_COMP.PNG.DDS`, `CARGO_DOOR_COMP.PNG.DDS`, `RIVETS_COMP.PNG.DDS`, and `CARGO_SOUTE_COMP.PNG.DDS` are still dangling package-local refs rather than shared glass assets
- Next step:
  - validate texture fallback behavior against a real SDK/shared-sim asset root before deciding on any generic loader fallback policy

## 7. Stage Cockpit / Instrument Support Without Regressing Startup

- Status: in progress.
- Findings:
  - the repo currently imports `panel.cfg` as package data, but it does not yet render `VCockpit` panel textures or execute `htmlgauge` / `WasmInstrument` entries
  - the A320 cockpit path is substantially heavier than the exterior-only path, so enabling it by default now would make the current startup-time problem worse
  - cockpit shell/interior geometry, HTML gauges, and WASM-backed instruments should be treated as separate milestones rather than one feature
  - the MSFS glTF loader previously fetched each LOD as text, parsed it for MSFS sanitizing, stringified it again, and then let `GLTFLoader` parse the JSON a second time
  - Three r182 accepts a parsed glTF JSON object directly, so the loader now passes the sanitized object into `GLTFLoader` without the second stringify/parse cycle
  - this reduces transient CPU work and peak JS heap during cold internal cockpit LOD00 loads without changing asset semantics
  - model components now carry generic load diagnostics with per-phase timings for fetch, JSON parse, MSFS sanitization, Three glTF parse, skin repair, normalization passes, material normalization, optional static batching, texture stripping, and resource-stat collection
  - cockpit interior swap benchmark events now include scene-graph swap, runtime rebuild, and render-pass refresh timings
  - model components can now carry resource accounting for unique geometries, materials, textures, geometry attribute/index bytes, known texture bytes, and estimated texture bytes; normal startup avoids that extra walk unless cockpit diagnostics or a benchmark requests it
  - cockpit benchmark component-loaded events and `__cockpitPerf.getActiveInteriorStats()` expose those diagnostics for the active cockpit/interior component
  - optional cockpit static instancing/merging modules are now imported lazily only when their query flags are used, keeping the default startup bundle smaller without changing visuals
  - when exterior-visible interior loading is deferred, startup now compiles only exterior model behavior first; full exterior+interior behavior compilation runs progressively before deferred interior attachment or cockpit use
  - when the URL specifies `aircraft=...`, package import now fully resolves only that requested aircraft and keeps the other variations as lightweight selector entries; this avoids model XML, texture fallback, cfg, and preview-state parsing for unrelated liveries/variants
  - when no `aircraft=...` is specified, package import now builds lightweight variation rows first, selects the default from those rows, and fully resolves only that default aircraft; unrelated variations no longer pay full model/texture/cfg import cost at startup
  - ASOBO primitive index normalization now edits typed index arrays directly and avoids eager bounds recomputation, reducing CPU work and temporary math churn during model load without changing final geometry
  - MSFS texcoord, normal/tangent, and vertex-color conversion passes now read source typed arrays directly instead of calling per-component BufferAttribute accessors in large loops
  - cockpit LOD00 can now opt into `cockpitTextures=range-low`, which reads DDS headers first and then loads only the selected small mip byte range for ordinary compressed DDS textures when HTTP `Range` is supported
  - the range-low texture path falls back to placeholders instead of full DDS downloads when range requests are unavailable, and decoded normal/transparent DDS sources now decode selected low mip ranges without reintroducing full-buffer CPU decode and RAM spikes
  - range-low cockpit textures now default to a `1024` max mip dimension, with `cockpitTextureSize=` available for `128` to `2048`, because `256` can erase small text in cockpit label atlases
  - `VCockpit` surface binding now runs by default for cockpit LOD00 and can be disabled with `?vcockpitSurfaces=off`
  - `[VCockpitXX]` panel sections are parsed into typed surface IR with texture targets, dimensions, background color, and gauge entries
  - cockpit LOD00 can now create placeholder dynamic textures for resolved `VCockpit` surfaces and bind them to matching cockpit material names
  - `globalThis.__lastVCockpitSurfaceBinding` exposes parsed surfaces, binding counts, and diagnostics for unresolved/invalid surfaces
  - non-WASM `htmlgaugeXX` entries now resolve through generic package/dependency roots and load through a serialized queued sandboxed iframe loader so cockpit LOD binding does not wait for gauge iframe startup or burst many instruments at once
  - `?vcockpitGaugeDebug` enables placeholder labels, grids, and HTML gauge load/deferred/missing status overlays for verification; the default dynamic texture path keeps these diagnostics off the visible cockpit screens
  - WASM-backed `htmlgauge` hosts are explicitly diagnosed as deferred rather than treated as normal HTML instruments
  - MSFS HTML gauge documents now adapt `import-script` tags and absolute `/Pages` / `/JS` asset paths into browser-loadable iframe documents
  - sandboxed HTML gauges now get a minimal generic `BaseInstrument` / `registerInstrument` host so template-based gauges can mount visible DOM
  - the iframe bridge now provides a generic demo `simvar` backend with power/brightness/default flight values so standalone gauges are not all driven by null/zero host data
  - the iframe bridge now provides generic MSFS browser-host shims for `vcockpit-panel`, `RunwayDesignator`, `Avionics.Utils`, `EmptyCallback`, `GameState`, listener handles, fast registered simvars, global vars, and dynamic `coui://html_ui` image/style URLs
  - cockpit `>H:` RPN writes now route through a generic runtime HTML interaction-event bridge; loaded VCockpit iframes receive `OnInteractionEvent`, and instrument elements receive `onInteractionEvent(args)`, verified on the A320 MCDU `PUSH_MCDUL_1` path
  - `UseInputEvent` aliases can now compile into runtime `B:` dispatch bindings when the resolved stock parameters provide an InputEvent source/name, binding aliases, and event code; Agent Browser verified the A320 ECP emergency-cancel `B:A32NX_PED_ECP_EMER_CANCEL_PB_Push` / `Release` aliases dispatch to the expected `H:A32NX_ECP_EMER_CANCEL_*` events
  - paired directional-axis fallback interactions now preserve both positive and negative code paths; Agent Browser verified A320 `LEVER_FLAPS` normal click drives `FLAPS_INCR` to 25% and `WheelDown` drives `FLAPS_DECR` back to 0 with matching flap animation values
  - simple value-carrying `>K:` writes now consume one stack value, so cockpit lighting/fuel/electrical templates such as `LIGHT_POTENTIOMETER_10_SET`, `CABIN_LIGHTS_SET`, `FUELSYSTEM_PUMP_ON`, `FUELSYSTEM_VALVE_OPEN`, and `ELECTRICAL_CIRCUIT_TOGGLE` update runtime SimVars instead of dropping their argument
  - runtime key-event handling now also covers common airliner sequence events for strobe/logo/nav lights, cabin seatbelt/no-smoking toggles, APU bleed/start/off, COM receive selection, and pitot heat
  - runtime key-event handling now covers additional stock cockpit inputs for radio/audio volumes and ident toggles, pilot/copilot transmitter selection, trim and antiskid controls, windshield deice, turbine ignition, mixture-rich commands, autopilot disconnect, transponder ident, and Kohlsman baro adjustment; Agent Browser verified representative events on the A320 exterior-only route
  - active direct light set events and radio ident set events such as `STROBES_SET` and `RADIO_DME1_IDENT_SET` now update runtime SimVars; Agent Browser verified the A320 exterior-only route
  - powered cockpit panel text/decal emissive bindings now receive generic panel power, light potentiometer, and common airliner bus-powered variables; black MSFS text materials are promoted to white emissive when a positive override binding is active so intensity changes are visible
  - unitless local/internal `*Brightness` variables now use the stock 0..1 brightness scale rather than the 0..100 light-potentiometer scale, so MCDU/FMC screen emissive bindings such as `I:XMLVAR_MCDU_#ID#_Brightness` are not overdriven when they fall back through the generic runtime
  - aircraft `sound.xml` metadata is now imported generically, and package-declared SimVar/LocalVar range sounds emit observable runtime start/stop events; Agent Browser verified A320/A330 sound metadata and events, while real browser audio playback remains blocked on Wwise `.PCK` bank support
  - iframe SimVar writes and key events now use fire-and-forget runtime notifications after updating the local gauge-side state, so offline browser gauges do not accumulate false timeout diagnostics while the parent runtime still receives write/event requests
  - common simulator host-service registration calls such as `INTERCEPT_KEY_EVENT` and nearest-search session/filter setup are now counted as supported no-op `Coherent.call` host services instead of unsupported bridge calls
  - generic key-event interception now delivers runtime `K:` / `F:KeyEvent` events to loaded gauges that explicitly call `INTERCEPT_KEY_EVENT`, and gauge-side `TRIGGER_KEY_EVENT` calls route back to the shared runtime; Agent Browser verified A320 FCU-style key events through this bridge
  - A320 MCDU startup now has the generic host pieces it expected (`InputBar`, `Utils.generateGUID`, `Avionics.Curve` / `CurveTool`, extra `Avionics.Utils` navigation helpers, and string game-vars), and Agent Browser verified cockpit `MENU` / `L1` buttons can move from MCDU MENU to the IDENT page
  - live A330 LOD00 verification showed the MCDU iframe loading its menu with no iframe errors, no unsupported bridge calls, and no runtime errors after the host-service cleanup; cockpit `PUSH_MCDUL_L1` delivers `A320_Neo_CDU_1_BTN_L1` into the iframe and changes the powered A330 MCDU from the menu to the A330 ident/status page
  - MSFS HTML gauge imports now inline `.html` dependency documents, skip dev-server fallback HTML for missing optional imports, expose labelled placeholder map host APIs for unavailable map imports, and resolve `/VFS/...` gauge fetches to package-root files; Agent Browser verified the A330 EFB no longer reports `MapInstrument.html`, Vite fallback, JSON5 config, `_developer`, `chartLimits`, or `defaultPaxWeight` gauge errors
  - `NO_TEXTURE` VCockpit `htmlgaugeXX` entries now load as backend-only runtimes even when they are normal HTML hosts rather than WASM bridge hosts; Agent Browser verified the A339X SystemsHost and ExtrasHost load, bringing A330 `gauges` and `loadedGauges` both to 24 while visible captures remain 18
  - accessible non-WASM iframe DOM is now composited into the bound cockpit `CanvasTexture` with an origin-clean SVG/canvas/text renderer so browser `foreignObject` tainting does not upload black GPU textures
  - `?vcockpitGaugeMode=overlay` adds an experimental direct-HTML path that projects live gauge iframes over matched VCockpit material bounds instead of converting DOM into images/textures every refresh
  - `?vcockpitGaugeMode=video` adds an experimental mesh-texture path that streams the composited VCockpit canvas through `captureStream()` into a Three `VideoTexture`, with `?vcockpitGaugeVideoFps=` controlling the stream frame rate
  - `?vcockpitGaugeRasterScale=` can lower texture/video-mode hidden iframe viewports and dynamic texture dimensions generically for performance testing, while leaving overlay mode at full scale
  - outside-view VCockpit gauge updates are disabled by default; `?vcockpitGaugeUpdateOutside=on` and the Settings panel row can re-enable them for debugging only
  - runtime animation/visibility evaluation is scoped to active scene targets, while generic update bindings continue running so exterior-view behavior state still changes without paying for absent cockpit animation targets
  - repeated runtime host variable reads are cached within each tick and invalidated on writes/events, which removes the cold-dark full-cockpit RPN read bottleneck without skipping behavior evaluation
  - live texture/video capture is now dirty-driven and rate-capped: the generic iframe bridge posts output-change versions for DOM mutations and Canvas2D writes, and the parent only recaptures dirty gauges/surfaces without letting per-frame iframe draws bypass `?vcockpitGaugeCaptureFps=`
  - HTML gauge capture now defaults to live refresh with adaptive generic instrument `Update()` scheduling based on SimVar/game-var dependencies; `?vcockpitGaugeUpdateMs=` or `?vcockpitGaugeUpdateHz=` can force periodic iframe updates, `?vcockpitGaugeUpdateMs=off` restores every-animation-frame updates, and `?vcockpitLiveGauges=off` switches to a bounded first-successful-frame pass that caches captured pixels and releases hidden iframes
  - live LOD00 verification on the A339X package now captures 15 non-WASM HTML gauges without blocking LOD00 binding; WASM hosts and the EFB remain explicitly deferred or diagnosed
  - cockpit/interior-view LOD selection is generalized beyond the hard-coded LOD00 cockpit path with `?interiorLod=` and profile/settings support
    - verified on 2026-05-10 with `tsc --noEmit` and Agent Browser on the A320 route: default auto selected active cockpit LOD0 with bound VCockpit surfaces, and explicit `?interiorLod=2` selected active cockpit LOD2 without a VCockpit binding because that lower-detail LOD has no bound panel surfaces
  - auto cockpit/interior-view LOD selection now uses package `layout.json` file-size estimates to avoid browser-hostile preferred LODs while preserving explicit `?interiorLod=0`; Agent Browser verified the A320 default route auto-selected cockpit LOD1, loaded 21 gauge runtimes, captured 15 visible gauges, and stayed around 60 FPS after the 150 MB LOD00 buffer crashed the browser context
  - external-power availability local variables are now treated as dynamic runtime values instead of stale stored defaults; Agent Browser verified A320 `PUSH_OVHD_ELEC_EXTPWR` changes both `L:A32NX_OVHD_ELEC_EXT_PWR_PB_IS_ON` and `A:EXTERNAL POWER ON` from 0 to 1
  - turbine fuel-valve side effects now publish placeholder engine spool values consistently; Agent Browser verified A320 `KNOB_ENGINES_MODE`, `SWITCH_ENGINES_ENG1`, and `SWITCH_ENGINES_ENG2` set ignition, fuel valves, combustion, RPM, N1, and N2 from cold values to running placeholder values
- Plan:
  - add cockpit shell/interior loading first as an opt-in path, not a default path
  - continue `VCockpit` dynamic texture binding, using `panel.cfg` surface definitions generically
    - parse `[VCockpitXX]` sections into typed surface IR, including `texture`, `pixel_size`, `size_mm`, background color, and gauge entries
    - resolve each surface `texture=` target to cockpit material/texture slots by package data, not by aircraft-specific display names
    - create one dynamic texture per surface and first bind a placeholder/debug pattern to verify material binding
    - emit diagnostics for unresolved textures, invalid dimensions, duplicate targets, and unsupported panel entries
  - add HTML gauge rendering after that, one family at a time, with a runtime bridge for panel textures
    - resolve gauge assets through generic package/dependency roots
    - render gauges into the already-bound `VCockpit` dynamic textures using documented panel coordinates/order
    - provide a minimal generic instrument bridge for documented simvars, local vars, events, and update ticks
    - report missing assets, unsupported bridge calls, blocked resources, and update/render timings as diagnostics
    - next: broaden the minimal instrument bridge and verify which gauge families need simulator APIs before their real content renders correctly
  - treat WASM instruments as a later milestone with explicit blocker handling if the required runtime environment is not available
- Constraint:
  - keep cockpit/instrument work behind query flags or equivalent opt-in controls until the loader has a generic progressive-loading path that protects the exterior test loop
- Benchmark blocker:
  - the local `/tmp/headwindsim-aircraft-a330-900/` and `/tmp/flybywire-aircraft-a320-neo/` fixture package roots were not present in this worktree environment, so fresh cold/warm cockpit timings could not be captured during this pass
