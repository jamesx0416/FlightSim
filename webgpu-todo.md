# WebGPU Migration TODO

This file tracks the generic, authoritative migration from `WebGLRenderer` to `WebGPURenderer`.

## Reference Order

Use sources in this order:

1. `three` WebGPU implementation and official API contracts in the installed version.
2. Direct evidence from this repo's renderer and MSFS material pipeline.
3. Official MSFS SDK docs, schemas, and exporter/plugin code where rendering semantics overlap.
4. Reverse-engineered importers such as `bestdani/msfs2blend` only as secondary corroboration.

## Current State

- The viewer now has a generic renderer factory and an explicit renderer selection path.
- Default remains `webgl` because the current MSFS material compatibility layer uses `onBeforeCompile`, which `three` documents as WebGL-only.
- `?renderer=webgpu` or `VITE_RENDERER=webgpu` can be used to exercise the WebGPU bootstrap path.
- `?renderer=auto` now falls back cleanly to `webgl` if WebGPU initialization fails.
- The WebGPU path currently uses a flat environment fallback when PMREM scene generation is unavailable.
- Signed compressed RG normal maps now use `three`'s WebGPU node-material conversion path and match the WebGL normal-scale application instead of re-scaling the blend factor a second time.
- `ASOBO_material_detail_map` now has a WebGPU node-material path for detail color, ORM, blend-mask, vertex-alpha blending, and detail-normal composition.
- `ASOBO_material_blend_gbuffer` factors are now wired into the WebGPU node-material path for opacity/color, roughness, metalness, occlusion, emissive, and normal intensity.
- The renderer now has generic two-pass decal groundwork for `blend_gbuffer` materials, but this is still not full MSFS parity.

## Blocking Gaps

- Port WebGL-only material patches in `src/msfs/gltf/normalizeMsfsMaterials.ts` to WebGPU-native material customization.
  - Exact background-material `ASOBO_material_blend_gbuffer` decal blending still needs a deferred/G-buffer style decal pass, not just a color backdrop.
  - The next pass should use `three`'s own WebGPU pass/MRT infrastructure cleanly; the first raw-MRT attempt showed two real blockers:
    - WebGPU needs higher `maxColorAttachmentBytesPerSample` than the default budget for a full decal component buffer.
    - Direct ad-hoc MRT sampling in node materials is not yet reliable in this viewer path and needs a more authoritative pass integration.
  - Any later `ASOBO_material_*` shader behavior.

- Confirm DDS compressed texture support on the WebGPU path.
  - Require `texture-compression-bc` for compressed BC formats.
  - Define generic fallback behavior when the feature is unavailable.

- Validate PMREM/environment generation and lighting parity on the WebGPU backend.

- Confirm the loader/runtime path stays renderer-agnostic.
  - No aircraft-specific branches.
  - No WebGPU behavior keyed on one package or one asset.

## Migration Steps

- Keep renderer selection additive until parity is established.
  - `webgl` remains the stable default.
  - `webgpu` remains an explicit opt-in path.

- Introduce a WebGPU-native MSFS material layer.
  - Prefer NodeMaterial / TSL or another official WebGPU-compatible path.
  - Preserve current generic MSFS material semantics while replacing WebGL shader string patching.

- Port material features incrementally and verify each one visually.
  - Normals first.
  - Decal/blend behavior next.
  - Detail maps after that.

- Switch the default renderer only after:
  - major MSFS material features render correctly
  - DDS/BC feature handling is robust
  - the same aircraft packages render acceptably on both paths

## Verification

- `bun run build`
- Browser load with `?renderer=webgl`
- Browser load with `?renderer=webgpu`
- MCP screenshots for any visible output change
