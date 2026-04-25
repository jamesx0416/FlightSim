# Exterior Shell Investigation

This file records the current non-aircraft-specific explanations for the A330 exterior shell appearing inside-out in the viewer.

## Ruled Out

- Missing `doubleSided` on the exterior shell materials.
  - The shell materials `A339_AIRFRAME_FRONT`, `A339_AIRFRAME_MID`, and `A339_AIRFRAME_REAR` are not marked `doubleSided` in the built glTF.
  - The loader is not stripping that flag; materials that are authored `doubleSided` still load as `DoubleSide` in the live scene.
- A simple visibility or hidden-node metadata miss.
  - The affected shell nodes do not carry obvious hide/show extras in the built glTF.
- A WebGPU-only renderer problem.
  - The shell issue reproduces in both WebGL and WebGPU.

## Strongest Confirmed Lead

### `ASOBO_primitive` Triangle Order Is Not Plain glTF

A reverse-engineered built-package importer (`bestdani/msfs2blend`) reconstructs `ASOBO_primitive` faces in reversed index order:

- source face order in that importer:
  - `(idx[i + 2], idx[i + 1], idx[i + 0])`
- not plain glTF order:
  - `(idx[i + 0], idx[i + 1], idx[i + 2])`

It also honors `BaseVertexIndex` when present.

That is strong evidence that the optimized built-mesh path is not meant to be consumed as plain stock glTF triangle order.

The current loader now applies a metadata-driven primitive winding rewrite for all triangle `ASOBO_primitive` meshes instead of the earlier geometry-guessing repair.

The practical reason is that the optimized mesh path in current fixtures is broader than `VTX`:
- A330 LOD00:
  - `VTX`: 275 primitives
  - `BLEND1`: 69 primitives
  - `BLEND4`: 12 primitives
- A320 LOD00:
  - `VTX`: 229 primitives
  - `BLEND1`: 64 primitives
  - `BLEND4`: 56 primitives

The A330 engine shells that still looked one-sided were `BLEND1`, which confirmed that restricting the rewrite to `VTX` was too narrow.

## Secondary Remaining Possibilities

### 1. Incomplete `ASOBO_asset_optimized` Mesh Interpretation

The affected shell meshes are part of the optimized built-package path and carry `ASOBO_primitive` metadata such as `VertexType: VTX` and `VertexVersion: 2`.

This is still the broader umbrella explanation. The loader already needs generic compatibility fixes for other optimized-mesh data:
- primitive slicing via `StartIndex` and `PrimitiveCount`
- nonstandard texcoord encoding
- nonstandard vertex colors
- packed/interleaved skinned attributes

The shell issue appears to have been one missing part of that same optimized-mesh contract.

### 2. Index Or Primitive Interpretation Is Still Incomplete

The current loader rewrites `ASOBO_primitive.StartIndex` and `PrimitiveCount` into ordinary glTF index accessors and now reverses optimized triangle winding.

If MSFS applies additional optimized-mesh rules that are not represented directly in stock glTF, the loader could still be assembling triangle order or base-vertex selection incorrectly even though the primitive slices are now correct.

One confirmed remaining field is `BaseVertexIndex`:
- present in the A320 optimized mesh path
- honored by `msfs2blend`
- in the current A320 case, both primitives already share the same full vertex accessor, so the sliced indices are already absolute into that shared vertex pool
- that means a blind rebase in this loader would be wrong for the currently observed fixture data
- it still needs to be handled authoritatively if a future optimized mesh uses primitive-local attribute accessors instead of the shared-accessor pattern

### 3. Hidden Front-Face Convention In The Optimized Mesh Path

There may be an implicit front-face or handedness convention for `VTX` / `VertexVersion: 2` meshes that is handled by the simulator runtime but not documented in the public built glTF.

No authoritative public metadata has been found yet that explicitly marks these shell meshes as reversed or double-sided.

### 4. Coordinate-System Conversion Difference

Part of the optimized built mesh path may require an additional coordinate-space or handedness conversion that MSFS applies internally.

If that conversion is missing only on some mesh streams, the result would match the current symptom: geometry exists, textures exist, but front-face culling rejects the outer shell.

## What To Check Next

- Validate the metadata-driven `ASOBO_primitive` winding rewrite across more optimized aircraft meshes.
- Add authoritative support for `BaseVertexIndex` where built meshes rely on it.
- Compare affected and unaffected `VTX` meshes in the same LOD to see whether more optimized-mesh rules are still missing.
