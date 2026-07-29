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
- The WebGPU path uses a flat environment fallback instead of attempting Three's WebGL PMREM generator, avoiding incompatible internal `ShaderMaterial` builds before aircraft loading starts.
- Signed compressed RG normal maps now use `three`'s WebGPU node-material conversion path and match the WebGL normal-scale application instead of re-scaling the blend factor a second time.
- DDS BC5/BC5S normal sources can now be decoded to standard RGB normal maps on the WebGPU load path, so those materials can stay closer to plain `MeshStandardMaterial` behavior instead of requiring node-material conversion just for compressed normals.
- `ASOBO_material_detail_map` now has a WebGPU node-material path for detail color, ORM, blend-mask, vertex-alpha blending, and detail-normal composition.
- `ASOBO_material_blend_gbuffer` factors are now wired into the WebGPU node-material path for opacity/color and emissive contribution. Component-only blend-gbuffer materials with no base-color or emissive contribution are suppressed in the forward color decal pass until a real deferred component blend exists. The special decal pass masks node-material decal fragments against the copied base scene depth with a screen-space same-surface allowance plus the measured projection displacement/receiver residual, so projected geometry decals can render without coplanar depth fighting while still being occluded by nearer opaque geometry.
- The renderer now has generic two-pass decal groundwork for `blend_gbuffer` materials. Decals render in a special pass after base opaque surfaces, avoid depth-testing against their covered base surface, and recover MSFS decal ordering from `ASOBO_material_draw_order` plus original glTF primitive/sub-material order.
- The viewer now forces a renderer clear color instead of relying on backend-specific `scene.background` handling, which removed a visible WebGPU/WebGL background mismatch on the A330.
- WebGPU node-material conversion is now restricted to supported material classes, eliminating the prior `ShaderMaterial` compatibility spam on clean WebGPU loads.
- On the current A330 and A320 fixtures, WebGPU is now effectively comparable to the current WebGL path for the exterior viewer.
- Current focus can shift back to broader MSFS loader coverage while keeping WebGPU parity intact.

## Blocking Gaps

- Port WebGL-only material patches in `src/msfs/gltf/normalizeMsfsMaterials.ts` to WebGPU-native material customization.
  - Exact background-material `ASOBO_material_blend_gbuffer` component blending still needs a real deferred/G-buffer style decal pass, not just a forward color decal pass with depth masking.
  - A32NX flap investigation confirmed why a depth-only approximation was insufficient: the `METALFLAPS` and `RIBBONS` blend-gbuffer primitives are authored millimeters away from the covered `WINGS` primitives and are expected to be resolved as geometry decals against the covered surface/G-buffer, not shaded as independent forward surfaces.
  - The A32NX/A330 difference is structural: A32NX flap markings are skinned `ASOBO_material_blend_gbuffer` decal primitives layered over sibling `WINGS` primitives, while the A330 fixture's flaps are ordinary wing-part geometry with no equivalent local blend-gbuffer decal stack.
  - Static A32NX inspection found the raw `METALFLAPS` vertices are authored millimeters off the covered `WINGS` receiver, and animated endpoint inspection found `FLAPS_01` decal skin weights diverge from the receiver by roughly 8-11 cm median and up to roughly 27 cm in the MSFS-style bind mode. Generic same-mesh receiver projection plus receiver-interpolated skin weights collapses those animated distances to numerical noise in the investigation script.
  - The loader now has a generic same-mesh projection fallback so sibling blend-gbuffer primitives inherit the covered base surface positions/normals/tangents/skin influences in the forward renderer. The special decal pass now samples an explicitly copied base-pass depth texture instead of relying on `viewportDepthTexture()`'s frame-scoped automatic copy; this keeps the decal depth mask synchronized with the current camera angle/zoom. This is still not a full replacement for deferred component blending.
  - 2026-07-29 A330 right-engine result: projected decals that span multiple receiver primitives now compose directly into the shared aircraft G-buffer. All related receivers write into the same depth-tested buffer, so the nearest receiver wins per pixel and the combined material is lit once with the receiver geometry. The decal geometry is not manually offset and `polygonOffset` remains disabled. Clipping is handled by writing a slightly nearer decal fragment depth from the locally measured projection allowance after converting it through camera view space, plus a small two-pixel depth-buffer tolerance. The earlier dedicated lit-overlay and premultiplied-map experiment was discarded because it bypassed this shared composition path. Its 3.04 ms versus 5.54 ms benchmark is historical only and does not represent the current implementation; the current path still needs a controlled benchmark.
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
