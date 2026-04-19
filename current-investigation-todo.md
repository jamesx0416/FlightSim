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

- Status: planned, not implemented yet.
- Findings:
  - the repo currently imports `panel.cfg` as package data, but it does not yet render `VCockpit` panel textures or execute `htmlgauge` / `WasmInstrument` entries
  - the A320 cockpit path is substantially heavier than the exterior-only path, so enabling it by default now would make the current startup-time problem worse
  - cockpit shell/interior geometry, HTML gauges, and WASM-backed instruments should be treated as separate milestones rather than one feature
- Plan:
  - add cockpit shell/interior loading first as an opt-in path, not a default path
  - add `VCockpit` dynamic texture binding next, using `panel.cfg` surface definitions generically
  - add HTML gauge rendering after that, one family at a time, with a runtime bridge for panel textures
  - treat WASM instruments as a later milestone with explicit blocker handling if the required runtime environment is not available
- Constraint:
  - keep cockpit/instrument work behind query flags or equivalent opt-in controls until the loader has a generic progressive-loading path that protects the exterior test loop
