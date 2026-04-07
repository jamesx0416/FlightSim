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

- Extend generic `ASOBO_material_*` rendering support.
  - Implement more of `ASOBO_material_blend_gbuffer`.
  - Complete `ASOBO_material_detail_map` fidelity.
  - Match the exact simulator response for `blendMaskTexture` + `blendThreshold` once the authoritative shader contract is identified.
  - Implement additional `ASOBO_material_shadow_options` behaviors where they affect runtime rendering.

- Resolve remaining livery/decal fidelity gaps.
  - Verify decal layering against `drawOrderOffset`.
  - Confirm blend/decal behavior on multiple aircraft packages.

- Tighten stock behavior include resolution.
  - Resolve simulator-provided `Asobo/...` behavior definitions through a generic source path.

- Improve optimized/skinned mesh compatibility.
  - Keep using authoritative layout evidence from built assets and official exporter expectations.

- Broaden validation fixtures.
  - Confirm generic loader behavior on more than the current A330 and A320 packages.

## Current Material Focus

- `ASOBO_material_blend_gbuffer`
- `ASOBO_material_draw_order`
- `ASOBO_material_shadow_options`
- `ASOBO_material_detail_map`
