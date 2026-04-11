# WebGPU Migration TODO

This file tracks the generic, authoritative migration from `WebGLRenderer` to `WebGPURenderer`.

## Reference Order

Use sources in this order:

1. `three` WebGPU implementation and official API contracts in the installed version.
2. Direct evidence from this repo's renderer and MSFS material pipeline.
3. Official MSFS SDK docs, schemas, and exporter/plugin code where rendering semantics overlap.
4. Reverse-engineered importers such as `bestdani/msfs2blend` only as secondary corroboration.

## Current State

- The viewer now has a generic renderer factory with a fixed bootstrap order.
- Startup now tries real `WebGPURenderer` first, then `WebGPURenderer({ forceWebGL: true })`, and only falls back to legacy `WebGLRenderer` if both fail.
- The WebGPU path currently uses a flat environment fallback when PMREM scene generation is unavailable.
- Signed compressed RG normal maps now use `three`'s WebGPU node-material conversion path and match the WebGL normal-scale application instead of re-scaling the blend factor a second time.
- DDS BC5/BC5S normal sources can now be decoded to standard RGB normal maps on the WebGPU load path, so those materials can stay closer to plain `MeshStandardMaterial` behavior instead of requiring node-material conversion just for compressed normals.
- `ASOBO_material_detail_map` now has a WebGPU node-material path for detail color, ORM, blend-mask, vertex-alpha blending, and detail-normal composition.
- `ASOBO_material_blend_gbuffer` factors are now wired into the WebGPU node-material path for opacity/color, roughness, metalness, occlusion, emissive, and normal intensity.
- The renderer now has generic two-pass decal groundwork for `blend_gbuffer` materials, but this is still not full MSFS parity.
- The viewer now forces a renderer clear color instead of relying on backend-specific `scene.background` handling, which removed a visible WebGPU/WebGL background mismatch on the A330.
- WebGPU node-material conversion is now restricted to supported material classes, eliminating the prior `ShaderMaterial` compatibility spam on clean WebGPU loads.
- On the current A330 and A320 fixtures, WebGPU is now effectively comparable to the current WebGL path for the exterior viewer.
- Current focus can shift back to broader MSFS loader coverage while keeping WebGPU parity intact.

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

- Keep the bootstrap order fixed and generic while parity work continues.
  - Real WebGPU remains the primary path.
  - Forced-WebGL on `WebGPURenderer` remains the primary fallback.
  - Legacy `WebGLRenderer` remains emergency compatibility only.

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
- Browser load on a WebGPU-capable device
- Browser load on a device/browser that falls through to forced-WebGL
- MCP screenshots for any visible output change
