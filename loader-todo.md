# Aircraft Loader TODO

This file tracks the next authoritative, aircraft-generic loader work.

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

## Next Work

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
  - Next step is to validate against real stock package roots so simulator-provided `Asobo/...` definitions resolve end-to-end.

- Tighten stock/shared texture fallback resolution.
  - Generic additional package-root support is now in place for texture fallback lookup as well.
  - Next step is to validate against real dependency packages such as `fs-base-aircraft-common`.

- Improve optimized/skinned mesh compatibility.
  - Keep using authoritative layout evidence from built assets and official exporter expectations.

- Broaden validation fixtures.
  - Confirm generic loader behavior on more than the current A330 and A320 packages.

## Current Fixture State

- Current A330 and A320 fixture imports are clean:
  - no package diagnostics
  - no compiled behavior diagnostics
- This means the next loader gaps are more likely to surface when real stock/shared MSFS dependency packages are mounted, not from the two current standalone fixtures alone.

## Current Material Focus

- `ASOBO_material_blend_gbuffer`
- `ASOBO_material_draw_order`
- `ASOBO_material_shadow_options`
- `ASOBO_material_detail_map`
