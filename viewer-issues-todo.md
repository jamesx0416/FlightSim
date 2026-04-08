# Viewer Issues TODO

This file tracks the current aircraft-viewer issues that still need generic MSFS loader or renderer fixes.

## Reference Order

Use sources in this order:

1. Official MSFS SDK docs, schemas, and exporter/plugin code.
2. Direct evidence from the built package data in this repo.
3. Reverse-engineered importers such as `bestdani/msfs2blend` only as corroboration.

## Active Issues

### 1. A320 Wing / Structural Transform Problem

- Reproduce the flipped or malformed wing on the A320.
- Check optimized primitive metadata, transforms, and shared-accessor behavior.
- Confirm whether the issue is another missing `ASOBO_primitive` rule, transform-space conversion, or visibility/LOD problem.
- Current finding: the right-wing glTF branch is authored with a 180-degree X rotation, but the live wing-bone transforms are still symmetric after import. The remaining likely loader gap is no longer raw primitive assembly; it may be missing custom node-animation support such as `NodeAnimation type="WingFlex"` or another behavior-layer contract.
- Fix it generically.

### 2. External Helper Visibility In Flight

- Reproduce the hanging GPU cord and any similar external-helper artifacts.
- Check model-behavior visibility, material invisibility, and any package/config metadata that should hide ground equipment in flight.
- Do not hand-remove a specific helper; find the generic visibility contract.
- Fixed generically:
  - nested `DefaultTemplateParameters` / `OverrideTemplateParameters` are now preserved during behavior traversal
  - stock `ASOBO_GT_Update` bindings now execute in the runtime
  - stock `ASOBO_GT_Helper_Recursive_ID` now expands engine visibility subtemplates
  - node visibility now resolves case-insensitively, which fixed XML `NODE_ID` versus glTF node-name casing mismatches
  - stock `ASOBO_FuelHose_InteractivePoint_Template` now emits a visibility binding for the target node using `A:INTERACTIVE POINT OPEN:<ID>`, which the SDK defines as hose/cable deployment percentage for fuel-hose interactive points
- Verified result: `GROUND_GPUPIPE` / `GROUND_GPUPipe` is now hidden in the live A320/A330 viewer instead of hanging out in flight.

### 3. Window Transparency / Opacity Handling

- Reproduce the rectangular window alpha issue on the A330.
- Audit material alpha mode, alpha cutoff, transparent/decal handling, DDS alpha preservation, and any window-specific MSFS material extensions.
- Check whether other opacity-related metadata is being dropped or reinterpreted incorrectly.
- Fixed generically:
  - materials with official `extras.ASOBO_material_code = "Porthole"` now force transparent window treatment when the built glTF omitted `alphaMode`
- Verified result: `A339_HUBLOT` and the A320 `hublots` material now load as transparent materials instead of opaque alpha squares.

### 4. Engine Spin / Oscillation

- Reproduce the engine/fan oscillation or glitch.
- Check imported animations, runtime bindings, and whether the current animation evaluation is using the right source channel/value space.
- Confirm whether MSFS behavior variables or prop/fan visibility rules are partially implemented and causing the visual glitch.
- Fixed generically in part:
  - engine visibility templates now compile through recursive helper expansion
  - only the expected still/slow/blur fan state is visible at a time instead of all of them rendering simultaneously
  - `ANIM_DELTA` is now honored in the runtime, so delta-style turbine animations accumulate instead of resetting to the per-frame increment
- Remaining check:
  - verify whether any residual oscillation is now purely from the demo runtime host values rather than missing behavior-template expansion.
  - investigate the remaining cone/fan mismatch where the spinner/cone appears to drift at a different speed or direction from the fan state

### 4b. Landing Gear Compression / Ground Contact Behavior

- Reproduce the gear posture issue where the gear visually tilts/flattens incorrectly relative to ground contact.
- Current finding:
  - the aircraft model XML supplies direct gear/door animations through local `L:A32NX_GEAR_*` variables
  - the current demo runtime host does not provide those `L:` variables, so they default to `0`
  - stock tire templates (`ASOBO_GEAR_Center_Tire_Template`, `ASOBO_GEAR_Left_Tire_Template`, `ASOBO_GEAR_Right_Tire_Template`) are still unresolved, so wheel blur/still and any stock tire behavior are incomplete
- Investigate whether the missing posture is driven by:
  - missing stock Asobo gear templates
  - missing custom local vars that would normally come from aircraft systems code
  - additional ground-contact / suspension metadata not yet interpreted by the runtime

### 5. Reflection / Width Distortion

- Reproduce the “plane looks wider straight on” reflection issue.
- Check whether the problem is renderer FOV/camera, environment mapping, normal interpretation, or material roughness/metalness handling.
- Verify whether WebGL and WebGPU differ after both exposures were normalized to `1`.
- Additional WebGPU-specific issue:
  - while the camera moves, wing reflections appear to shimmer or glitch
  - investigate whether this is environment-map resolution, PMREM/backend differences, normal-map interpretation, or a WebGPU material-path instability

### 6. Missing Stock Templates / Includes

- Reproduce and inventory the remaining unresolved stock Asobo includes and templates.
- Distinguish between:
  - missing official package roots that are not mounted in this environment
  - missing compiler coverage for stock templates that could be supported generically without those roots
- Current finding:
  - unresolved `Asobo\\Exterior.xml` / `Asobo\\Generic\\FX.xml` is primarily a missing stock-package-root problem in this environment
  - unresolved stock template warnings are a mix of:
    - missing official package content
    - incomplete compiler support for some stock template families already referenced by local templates

### 7. Revalidate Local Stock-Template Implementations

- Once public/offline stock Asobo XMLs are mounted locally, re-check every locally implemented stock-template behavior against the official XML definitions.
- In particular, revisit:
  - `ASOBO_GT_Update`
  - `ASOBO_GT_Helper_Recursive_ID`
  - `ASOBO_FuelHose_InteractivePoint_Template`
  - stock handling template shims
  - any stock gear/tire template support added before the official XMLs are mounted
- Remove or adjust any approximation that does not match the official template contract.

## Cross-Cutting Checks

- Look for other dropped or ignored metadata that affects:
  - opacity
  - visibility
  - transforms
  - optimized primitive assembly
- Keep fixes aircraft-generic and avoid per-aircraft patches.
