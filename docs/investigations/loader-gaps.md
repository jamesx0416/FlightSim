# MSFS Aircraft Loader Gaps

This file tracks major MSFS aircraft-loader/runtime features that are still unsupported or only partially implemented in this project.

## Current Gaps

- Full MSFS material extension support
  - Many `ASOBO_material_*` behaviors are only partially interpreted.
  - Blend, decal, windshield, and detail-map fidelity are incomplete.

- Full model behavior include resolution
  - Stock `Asobo/...` behavior documents outside the imported package are still unresolved.

- Broad RPN/calculator support
  - Unsupported tokens still exist.
  - Compiler coverage is still partial.

- Event and system integration
  - The runtime variable/event host is minimal and is not yet a full sim-style environment.

- Panels and instruments
  - `panel.cfg`, HTML/JS instruments, and panel XML hosting are still out of scope.

- WASM
  - No WASM execution or bridge exists.

- Sound
  - No sound config/runtime exists.

- Full skinned-model compatibility
  - Some MSFS optimized/skinned mesh conventions still need better support.

- Full LOD policy fidelity
  - LOD loading works, but not yet with complete MSFS parity semantics.

- Lights and effects fidelity
  - Generic behavior exists, but not full MSFS light/effect runtime fidelity.

- Package inheritance breadth
  - Some config/reference resolution is implemented, but not everything MSFS can layer or fall back through.

- Rendering parity
  - Texture loading is materially better than before, but final visual fidelity is still below MSFS.

- WebGPU renderer path
  - The target direction is WebGPU, but the current viewer is still on WebGL.

## Status Note

The current implementation is a working generic MSFS loader slice, not a near-complete simulator-grade aircraft loader.
