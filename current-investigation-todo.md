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
  - tone mapping and exposure plumbing matched, so the issue was not generic renderer setup
  - WebGPU was taking a separate fallback environment path that added a `HemisphereLight`
- Implemented:
  - replaced the split sky/fallback path with one shared PMREM environment path for both renderers
  - removed the WebGPU-only hemisphere-light fallback path
  - added a renderer-generic WebGPU exposure correction so the final image is close to WebGL on the live deployment

## 3. Check Whether Reflections Jitter While The Camera Moves

- Status: mitigated with the lighting/environment fix.
- Findings:
  - this issue is likely linked to the environment/specular path rather than any aircraft-specific data
  - the shared environment map had been only `256x128`, which is coarse enough to cause visible stepping on glossy reflections during motion
- Implemented:
  - increased the shared environment texture resolution to `1024x512`
  - kept the environment static and shared across renderers so reflections are not switching lighting models while the camera moves
- Verification:
  - moving WebGPU capture sequence now shows consistent frame-to-frame changes rather than a changing light rig

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
