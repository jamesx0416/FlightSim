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
  - non-WASM `htmlgaugeXX` entries now resolve through generic package/dependency roots and load through a small queued sandboxed iframe loader so cockpit LOD binding does not wait for gauge iframe startup
  - `?vcockpitGaugeDebug` enables placeholder labels, grids, and HTML gauge load/deferred/missing status overlays for verification; the default dynamic texture path keeps these diagnostics off the visible cockpit screens
  - WASM-backed `htmlgauge` hosts are explicitly diagnosed as deferred rather than treated as normal HTML instruments
  - MSFS HTML gauge documents now adapt `import-script` tags and absolute `/Pages` / `/JS` asset paths into browser-loadable iframe documents
  - sandboxed HTML gauges now get a minimal generic `BaseInstrument` / `registerInstrument` host so template-based gauges can mount visible DOM
  - the iframe bridge now provides a generic demo `simvar` backend with power/brightness/default flight values so standalone gauges are not all driven by null/zero host data
  - the iframe bridge now provides generic MSFS browser-host shims for `vcockpit-panel`, `RunwayDesignator`, `Avionics.Utils`, `EmptyCallback`, `GameState`, listener handles, fast registered simvars, global vars, and dynamic `coui://html_ui` image/style URLs
  - accessible non-WASM iframe DOM is now composited into the bound cockpit `CanvasTexture` with an origin-clean SVG/canvas/text renderer so browser `foreignObject` tainting does not upload black GPU textures
  - HTML gauge capture now defaults to a bounded first-successful-frame pass with `?vcockpitLiveGauges` available for continuous refresh
  - live LOD00 verification on the A339X package now captures 15 non-WASM HTML gauges without blocking LOD00 binding; WASM hosts and the EFB remain explicitly deferred or diagnosed
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
