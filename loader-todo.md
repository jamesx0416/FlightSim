# Aircraft Loader Master TODO

This is the master planning document for the loader/runtime/viewer work in this repo.

It consolidates:
- general loader roadmap work
- current active problems
- viewer/runtime issue tracking
- stock XML / CFG support tracking

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

## Current Problems

These are the current high-priority problems on the active A320/A330 fixture path.

### 1. A320 Wing Structure Issue

The A320 still looks structurally wrong in the wing area.

Current strongest lead:
- the main wing skin is now mostly correct; the remaining visible defect is the floating under-wing support / fairing attachment chain rather than the whole wing surface
- the old `X180 * bind * X180` experiment is explicitly rejected as heuristic: it helped a narrow subset, but it is not documented by MSFS and it broke other left-side skinned parts
- current generic direction is to treat rigid one-bone MSFS attachment skins as a distinct loader class and keep narrowing the remaining floating-part transform/bind mismatch from there

### 2. Remaining Engine Visual Mismatch

The engine spin is much better than before, but the fan/cone relationship can still look slightly wrong.

Current hypothesis:
- remaining runtime animation fidelity issue rather than the old multi-state visibility failure

### 3. A320 Floating Canoe / Fairing Attachment

The A320 still has a remaining floating canoe / fairing-like attachment in the wing-root area.

Current strongest lead:
- this is no longer the whole-wing inversion problem; the main wing surfaces are broadly correct
- the remaining defect is in a narrower attachment/fairing subset near the wing root
- the floating canoe body sits in the root-level rigid one-bone skinned-mesh class with authored local rotation, and that class now has a generic rebind fix
- the remaining visible floaters are a different skinning class, not another copy of the canoe problem
- the confirmed remaining front-view floaters are `WIRE_LEFT`, `WIRE_RIGHT`, and `C_WIRE`
- those wires are root-level translated multi-bone skins driven by gear/suspension chains, and live inspection shows the bad term is in bind-space translation rather than the node translation itself

### 4. Interior Fuselage / Cockpit Mesh Overlap

The interior view inside the A320 fuselage still shows broken overlapping mesh sheets instead of a clean shell/window assembly.

Current strongest lead:
- this looks like a transform / duplicate-shell / inner-versus-outer mesh-space problem rather than a material-only transparency issue
- cockpit glazing and nearby interior shell pieces appear to be intersecting or stacked in the wrong space
- this should be investigated as a generic importer/skinning/transform issue, not as an aircraft-specific cockpit patch

### 5. MSFS-Native Skinning Architecture

The loader still relies on targeted normalization passes instead of a single MSFS-native skinning model.

Current strongest lead:
- MSFS docs say inverse-bind matrices are ignored, but the current path still starts from Three/glTF inverse-bind semantics and repairs only the mismatching classes
- the canoe fix suggests rigid root-level one-bone skins are one such mismatching class
- the remaining wire/helper floaters are likely another class and probably need the same broader architectural direction, but not the exact same rigid-mesh rule
- the cleaner long-term fix is to reconstruct skin rest/bind state from the assembled MSFS joint graph and authored node transforms instead of layering more post-load class-specific rebinding rules

### 6. Broader Stock Coverage Is Still Incomplete

Many downloaded stock XML families are not yet exercised or verified on the current A320/A330 fixture path.

This is a completeness gap, but not the most urgent visible problem on the current routes.

## Recently Resolved

### 1. Direct-View Lighting Washout

Fixed generically.

Result:
- the direct-view washout was not an aircraft-specific material quirk
- the remaining mismatch came from divergence between the legacy WebGL material path and the WebGPU/node-material path
- the viewer now boots through a shared renderer stack order: real WebGPU, then `WebGPURenderer({ forceWebGL: true })`, then legacy `WebGLRenderer` only as an emergency fallback

### 2. WebGPU Wing / Reflection Jitter

Fixed generically.

Result:
- the WebGPU shimmer came from compressed RG normal maps not using the repo's existing WebGPU decode/material path
- wiring the dormant WebGPU compressed-normal path removed the reflection/wing instability without aircraft-specific logic

## Viewer / Runtime Issues

These are the current aircraft-viewer issues that still need generic MSFS loader or renderer fixes.

### 1. A320 Wing / Structural Transform Problem

- Reproduce the flipped or malformed wing on the A320.
- Check optimized primitive metadata, transforms, and shared-accessor behavior.
- Confirm whether the issue is another missing `ASOBO_primitive` rule, transform-space conversion, or visibility/LOD problem.
- Current finding:
  - the A320 model XML uses the documented 12-node `NodeAnimation type="WingFlex"` layout
  - `flight_model.cfg` supplies documented `wingflex_scalar = 0.75` and `wingflex_offset = -0.25`
  - the importer preserves the `NodeAnimation` block and the runtime binds it generically
  - the runtime now applies `WingFlex` in a shared aircraft/world-up basis transformed into each node parent space, instead of assuming local +Y on mirrored wing branches
  - this specifically addresses the authored `WING_right` 180-degree X rotation that previously made the right wing respond in the wrong local basis
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
  - documented animation `<Lag>` values are now honored in the runtime
- Remaining check:
  - verify whether any residual oscillation is now purely from the demo runtime host values rather than missing behavior-template expansion
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

### 5b. A320 Floating Canoe / Fairing Piece

- Reproduce the remaining floating canoe / fairing attachment on the A320 wing-root area.
- Confirm the exact object family still detached in the live viewer.
- Check whether the remaining error is on the normal skinned path, shared accessor/bind data, or another transform-space mismatch.
- Do not revive the removed rigid one-bone reduction path unless an authoritative generic rule supports it.

### 5c. Interior Fuselage / Cockpit Mesh Breakage

- Reproduce the broken overlapping mesh sheets visible from inside the fuselage / cockpit window area.
- Check whether the issue is duplicate inner/outer shell geometry, incorrect transform accumulation, or a skin/bind mismatch on interior assemblies.
- Distinguish mesh-space breakage from window material/transparency handling.
- Fix it generically.

### 6. Missing Stock Templates / Includes

- Reproduce and inventory the remaining unresolved stock Asobo includes and templates.
- Distinguish between:
  - missing official package roots that are not mounted in this environment
  - missing compiler coverage for stock templates that could be supported generically without those roots
- Updated finding:
  - public stock Asobo XMLs from the official Template Explorer are now downloaded locally and mounted by default from `/vendor/msfs-stock/`
  - package-level `Behavior include Asobo\\... could not be resolved` warnings have dropped to `0`
  - the remaining stock-behavior failures are no longer root-resolution failures; they are parser/compiler gaps against stock Asobo XML syntax and template coverage
  - several official stock XMLs use template syntax such as dynamic parameterized tag names (`<#PARAM_NAME#>`) that is not plain XML and still needs broader generic preprocessing/support

### 7. Revalidate Local Stock-Template Implementations

- Once public/offline stock Asobo XMLs are mounted locally, re-check every locally implemented stock-template behavior against the official XML definitions.
- In particular, revisit:
  - `ASOBO_GT_Update`
  - `ASOBO_GT_Helper_Recursive_ID`
  - `ASOBO_FuelHose_InteractivePoint_Template`
  - stock handling template shims
  - any stock gear/tire template support added before the official XMLs are mounted
- Remove or adjust any approximation that does not match the official template contract.
- Current state:
  - the official public stock XML set is now mounted locally
  - the compiler now consumes the public stock XML path directly for the stock constructs that were previously blocking that:
    - `<Parameters Type="Default|Override">`
    - stock `Condition` / `Switch` parameter branches
    - stock `Process="Int|Float|Param"`
    - direct `<Update>` nodes
    - `ASOBO_GT_Anim` in both simvar and code forms
    - direct stock `<Animation>` nodes from the mounted Asobo templates
    - documented animation `<Lag>` values in the runtime
  - the active A320/A330 fixture routes now compile their handling animations from the mounted official templates with `builtinFallbackHits = []`
  - built-in stock shims remain only as dormant safety nets when a referenced template is genuinely absent from the mounted public XML set
  - those remaining shims were tightened against the mounted official XML definitions during this pass

### Cross-Cutting Checks

- Look for other dropped or ignored metadata that affects:
  - opacity
  - visibility
  - transforms
  - optimized primitive assembly
- Keep fixes aircraft-generic and avoid per-aircraft patches.

## General Loader Work

This section tracks the next authoritative, aircraft-generic loader work.

### Next Work

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
  - Public stock Asobo XMLs from the official Template Explorer are now mounted locally at `/vendor/msfs-stock/`.
  - Package-level stock include resolution is working through that mounted root.
  - The compiler now supports the missing stock XML constructs that were blocking mounted public Asobo XML use in practice:
    - dynamic tag preprocessing
    - `<Parameters Type="Default|Override">`
    - stock `Condition` / `Switch` parameter-block branches
    - stock `Process="Int|Float|Param"`
    - direct `<Update ...>` compilation
    - `ASOBO_GT_Anim` simvar-driven and code-driven forms
    - direct stock `<Animation>` node compilation
    - documented animation `Lag`
  - Next step is to keep replacing remaining mirrored built-ins only when the general XML evaluator can consume the stock template family without regressions.

- Tighten stock/shared texture fallback resolution.
  - Generic additional package-root support is now in place for texture fallback lookup as well.
  - Current finding on the A320 route:
    - `../../../../texture/Glass` is the relevant shared fallback path for the missing glass maps under investigation
    - `../../../../texture/Interiors` appears in the standard fallback chain but is not implicated by the current missing A320 texture names
    - several missing `*_COMP` files are genuine dangling package-local refs and should not be treated as shared-stock-texture misses
  - Next step is to validate against real dependency packages such as `fs-base-aircraft-common`.

- Improve optimized/skinned mesh compatibility.
  - Keep using authoritative layout evidence from built assets and official exporter expectations.
  - Add explicit generic handling for rigid one-bone skinned attachments that behave like bone children rather than true deforming skins.
  - Use this to resolve the remaining floating under-wing support/fairing assemblies without reintroducing aircraft-specific half-turn patches.
  - Design and document a cleaner MSFS-native skinning architecture that derives bind/rest state from assembled joints and node transforms instead of trusting glTF inverse-bind accessors by default.

- Broaden validation fixtures.
  - Confirm generic loader behavior on more than the current A330 and A320 packages.

## Other Generic Repo Issues

- 3D tiles material replacement plugin still does not support multi-material meshes.
  - Current failure path throws `Multiple materials are not supported yet.` in `src/plugins/TileMaterialReplacementPlugin.ts`.
- 3D tiles material replacement plugin still leaks replaced materials on dispose.
  - Current file already notes this in `src/plugins/TileMaterialReplacementPlugin.ts`; track it here so it is not lost outside the source comment.

### Current Fixture State

- Current A330 and A320 fixture imports are clean:
  - no package diagnostics on the A330 route after mounting the public stock XML root
- The remaining loader gaps are now more clearly in stock XML parsing/compiler coverage and runtime semantics, not just missing include roots.

### Current Material Focus

- `ASOBO_material_blend_gbuffer`
- `ASOBO_material_draw_order`
- `ASOBO_material_shadow_options`
- `ASOBO_material_detail_map`

## Stock Support TODO

This checklist tracks authoritative MSFS stock support work against the mounted public Asobo XML set and mirrored CFG docs.

Rules:
- Prefer the official mounted XML/docs over local approximations.
- Keep fixes generic and reusable across aircraft.
- Mark items done only when the loader/compiler/runtime support is implemented and verified on at least the A330 and A320 routes where relevant.
- Stock XML items can only be checked when the relevant official docs/reference pages have been read for that area and the implementation has been updated or confirmed against them.
- Reference-doc items can only be checked when they have actually been reviewed during implementation, not merely downloaded.
- No item can be checked off unless an `agent-browser` verification pass has been run on both the A330 and A320 routes, screenshots have been taken, and those screenshots indicate nothing is broken and the change likely works.
- Continue the implementation until every checklist item that is in scope for this repo is either completed and checked off or explicitly blocked with a documented reason; do not stop early just because a subset is finished.

### 1. Create A Granular Stock-Support Checklist

- [x] Create a granular stock-support checklist covering each mounted XML family and each targeted CFG file.

### 2. Implement Deeper Generic Stock Behavior Support Across Mounted Asobo XML Families

#### Core Plumbing

- [x] Support mounted stock `layout.json` for behavior-root resolution.
- [x] Mount public stock Asobo XML root by default.
- [x] Resolve stock behavior includes across mounted roots.
- [x] Support dynamic stock XML tag preprocessing.
- [x] Support `<Parameters Type="Default|Override">`.
- [x] Support parameter-block `Condition` / `Switch`.
- [x] Support `Process="Int|Float|Param"`.
- [x] Support direct `<Update ...>` nodes.
- [x] Support `ASOBO_GT_Anim` in simvar and code forms.
- [x] Replace remaining mirrored stock-template fallbacks where the general XML evaluator can do so safely.
  Verified:
  - the built-in stock-template fallback path has been removed from the compiler
  - the active A320/A330 fixture routes still compile and run cleanly through the mounted official XML path with `builtinFallbackHits = []`

#### Stock XML Files

Scope note:
- See [stock-support-scope.md](/Users/4980/.t3/worktrees/FlightSim/msfs-combined-375b8e3b-fresh/stock-support-scope.md) for the currently exercised public stock XML set on the A320/A330 fixture routes.
- The current fixture include graph exercises `Common.xml`, `Common/Index.xml`, `Exterior.xml`, `Generic.xml`, `Generic/FX.xml`, and `Generic/Index.xml`.
- XML files outside that exercised set should stay unchecked until they are either:
  - exercised and verified on the fixture routes, or
  - explicitly documented as blocked / out of current runtime scope.

##### AircraftTypes

- [ ] `AircraftTypes/Gliders.xml`
- [ ] `AircraftTypes/Rotorcrafts.xml`

##### Airliner

- [ ] `Airliner/AS02A.xml`
- [ ] `Airliner/Airbus.xml`
- [ ] `Airliner/AirlinerCommon.xml`
- [ ] `Airliner/Boeing.xml`
- [ ] `Airliner/FMC.xml`
- [ ] `Airliner/GlassCockpit.xml`
- [ ] `Airliner/Inputs/Airliner_Inputs.xml`

##### Common

- [x] `Common.xml`
- [ ] `Common/Aircraft.xml`
- [ ] `Common/Autopilot.xml`
- [ ] `Common/Deice.xml`
- [ ] `Common/Electrical.xml`
- [ ] `Common/Engine.xml`
- [ ] `Common/Fuel.xml`
- [ ] `Common/Handling.xml`
- [x] `Common/Index.xml`
- [ ] `Common/Instrument.xml`
- [ ] `Common/LandingGear.xml`
- [ ] `Common/Lighting.xml`
- [ ] `Common/Passenger.xml`
- [ ] `Common/Pilot.xml`
- [ ] `Common/Pressurization.xml`
- [ ] `Common/Safety.xml`

##### Common Inputs

- [ ] `Common/Inputs/Aircraft_Inputs.xml`
- [ ] `Common/Inputs/Autopilot_Inputs.xml`
- [ ] `Common/Inputs/Common_Inputs.xml`
- [ ] `Common/Inputs/Deice_Inputs.xml`
- [ ] `Common/Inputs/Electrical_Inputs.xml`
- [ ] `Common/Inputs/Engine_Inputs.xml`
- [ ] `Common/Inputs/Fuel_Inputs.xml`
- [ ] `Common/Inputs/Handling_Inputs.xml`
- [ ] `Common/Inputs/Instrument_Inputs.xml`
- [ ] `Common/Inputs/LandingGear_Inputs.xml`
- [ ] `Common/Inputs/Lighting_Inputs.xml`
- [ ] `Common/Inputs/Passenger_Inputs.xml`
- [ ] `Common/Inputs/Pressurization_Inputs.xml`
- [ ] `Common/Inputs/Safety_Inputs.xml`

##### Common Subtemplates

- [ ] `Common/Subtemplates/Aircraft_Subtemplates.xml`
- [ ] `Common/Subtemplates/Autopilot_Subtemplates.xml`
- [ ] `Common/Subtemplates/Deice_Subtemplates.xml`
- [ ] `Common/Subtemplates/Electrical_Subtemplates.xml`
- [ ] `Common/Subtemplates/Engine_Subtemplates.xml`
- [ ] `Common/Subtemplates/Fuel_Subtemplates.xml`
- [ ] `Common/Subtemplates/Handling_Subtemplates.xml`
- [ ] `Common/Subtemplates/Instrument_Subtemplates.xml`
- [ ] `Common/Subtemplates/LandingGear_Subtemplates.xml`
- [ ] `Common/Subtemplates/Lighting_Subtemplates.xml`
- [ ] `Common/Subtemplates/Passenger_Subtemplates.xml`
- [ ] `Common/Subtemplates/Pressurization_Subtemplates.xml`
- [ ] `Common/Subtemplates/Safety_Subtemplates.xml`

##### Exterior

- [x] `Exterior.xml`

##### GPS

- [ ] `GPS/AS430.xml`
- [ ] `GPS/AS530.xml`
- [ ] `GPS/Aera.xml`
- [ ] `GPS/Inputs/AS430_Inputs.xml`
- [ ] `GPS/Inputs/Aera_Inputs.xml`

##### Generic

- [x] `Generic.xml`
- [ ] `Generic/AnimationTriggers.xml`
- [ ] `Generic/Animations.xml`
- [ ] `Generic/Emissive.xml`
- [x] `Generic/FX.xml`
- [ ] `Generic/Helpers.xml`
- [x] `Generic/Index.xml`
- [ ] `Generic/Interactions.xml`
- [ ] `Generic/Updates.xml`
- [ ] `Generic/Visibility.xml`

##### Generic Complex

- [ ] `Generic/Complex/Index.xml`
- [ ] `Generic/Complex/Joystick.xml`
- [ ] `Generic/Complex/Knob.xml`
- [ ] `Generic/Complex/Lever.xml`
- [ ] `Generic/Complex/Misc.xml`
- [ ] `Generic/Complex/PushButton.xml`
- [ ] `Generic/Complex/Switch.xml`

##### Generic Subtemplates

- [ ] `Generic/Subtemplates/Animations_Subtemplates.xml`
- [ ] `Generic/Subtemplates/Interactions_Subtemplates.xml`
- [ ] `Generic/Subtemplates/Updates_Subtemplates.xml`

##### GlassCockpit

- [ ] `GlassCockpit/AS1000.xml`
- [ ] `GlassCockpit/AS3000.xml`
- [ ] `GlassCockpit/AS307.xml`
- [ ] `GlassCockpit/AS3X.xml`
- [ ] `GlassCockpit/AS3X_Touch.xml`
- [ ] `GlassCockpit/AS5.xml`
- [ ] `GlassCockpit/AS580.xml`
- [ ] `GlassCockpit/AS650.xml`
- [ ] `GlassCockpit/Inputs/AS1000_Inputs.xml`
- [ ] `GlassCockpit/Inputs/AS3X_Inputs.xml`
- [ ] `GlassCockpit/Inputs/AS5_Inputs.xml`

##### Inputs

- [ ] `Inputs/Generic.xml`
- [ ] `Inputs/Helpers.xml`
- [ ] `Inputs/Index.xml`
- [ ] `Inputs/Templates.xml`

##### Misc

- [ ] `Misc/ASDigiflo.xml`
- [ ] `Misc/ASDigitalFuelMeter_FP5L.xml`
- [ ] `Misc/ASPropeller.xml`
- [ ] `Misc/ASVigilus.xml`
- [ ] `Misc/AS_EPM.xml`
- [ ] `Misc/Accelerometer.xml`
- [ ] `Misc/Clock.xml`
- [ ] `Misc/GX2.xml`
- [ ] `Misc/GroundVehicles.xml`
- [ ] `Misc/Pl463.xml`
- [ ] `Misc/SimObjects.xml`
- [ ] `Misc/VoltsAmps.xml`
- [ ] `Misc/Inputs/Misc_Inputs.xml`

##### NAVCOM

- [ ] `NAVCOM/ADF.xml`
- [ ] `NAVCOM/AS92.xml`
- [ ] `NAVCOM/ASNAV.xml`
- [ ] `NAVCOM/KAP140.xml`
- [ ] `NAVCOM/NavComSystem.xml`
- [ ] `NAVCOM/SimpleCom.xml`
- [ ] `NAVCOM/Inputs/NavComSystem_Inputs.xml`
- [ ] `NAVCOM/Inputs/SimpleCom_Inputs.xml`

##### Transponder

- [ ] `Transponder/AS21.xml`
- [ ] `Transponder/AS330.xml`
- [ ] `Transponder/Transponder.xml`

#### CFG Reference Targets

- [ ] `Additional_Information/File_Formats/CFG_Files.htm`
- [ ] `Content_Configuration/Cameras/Cameras_CFG/cameras_cfg.htm`
- [ ] `Content_Configuration/Models/model_cfg.htm`
- [ ] `Content_Configuration/SimObjects/Aircraft_SimO/Aircraft.htm`
- [ ] `Content_Configuration/SimObjects/Aircraft_SimO/aircraft_cfg.htm`
- [x] `Content_Configuration/SimObjects/Aircraft_SimO/cockpit_cfg.htm`
- [x] `Content_Configuration/SimObjects/Aircraft_SimO/engines_cfg.htm`
- [x] `Content_Configuration/SimObjects/Aircraft_SimO/flight_model_cfg.htm`
- [ ] `Content_Configuration/SimObjects/Aircraft_SimO/gameplay_cfg.htm`
- [x] `Content_Configuration/SimObjects/Aircraft_SimO/Instruments/panel_cfg.htm`
- [x] `Content_Configuration/SimObjects/Aircraft_SimO/systems_cfg.htm`
- [x] `Content_Configuration/SimObjects/Aircraft_SimO/target_performance_cfg.htm`
- [ ] `Content_Configuration/SimObjects/Living_Things/Living_Things_sim_cfg.htm`
- [ ] `Content_Configuration/Textures/texture_cfg.htm`

#### Reference Docs Pack

- [ ] `html/Introduction/Using_The_SDK.htm`
- [ ] `html/Introduction/Introduction.htm`
- [ ] `html/Content_Configuration/Models/Models.htm`
- [x] `html/Content_Configuration/Models/Model_Definitions.htm`
- [x] `html/Content_Configuration/Models/Model_Animation_Definitions.htm`
- [x] `html/Content_Configuration/Models/ModelBehaviors/Model_Behaviors.htm`
- [x] `html/Content_Configuration/Models/ModelBehaviors/General_Template_Definitions.htm`
- [x] `html/Content_Configuration/Models/ModelBehaviors/Input_Event_Definitions.htm`
- [x] `html/Content_Configuration/Models/ModelBehaviors/TemplateExplorer/Template_Explorer.html`
- [x] `html/mergedProjects/How_To_Make_An_Aircraft/Contents/Model_Behaviours/Default_Templates.htm`
- [ ] `html/Asset_Creation/3D_Models/General_Principles.htm`
- [ ] `html/Asset_Creation/Blender_Plugin/The_Blender_Plugin.htm`
- [ ] `html/Content_Configuration/SimObjects/SimObjects.htm`
- [x] `html/Content_Configuration/SimObjects/Aircraft_SimO/flight_model/interactive_points.htm`
- [ ] `html/Content_Configuration/VisualEffects/Visual_Effects_Landing_Templates.htm`
- [ ] `html/Content_Configuration/Checklists/Checklists.htm`
- [ ] `msfs2024/html/3_Models_And_Textures/Plugins/glTF_Schemas.htm`
- [ ] `msfs2024/flighting/html/3_Models_And_Textures/Textures/Materials/FlightSim_Materials.htm`
- [ ] `msfs2024/html/3_Models_And_Textures/Textures/Materials/FlightSim_Material_Parameters.htm`
- [x] `msfs2024/flighting/html/6_Programming_APIs/SimVars/Aircraft_SimVars/Aircraft_FlightModel_Variables.htm`
- [ ] `html/mergedProjects/How_To_Make_An_Aircraft/Contents/Modelling/Airframe/Texturing/Surface_Detail__agt_index.htm`

#### Template Explorer HTML Pack

- [x] Download the rendered Template Explorer HTML pages for the mounted stock XML set.
- [x] Keep the rendered HTML pack separate from the mounted runtime XML pack.
- [x] Use the rendered HTML pages as reference/debug support only, not as runtime behavior sources.

### 3. Implement Broader Generic CFG Support For Targeted MSFS CFG Files

- [x] Expand runtime and importer support beyond the current `aircraft.cfg`, `model.cfg`, and `texture.cfg` scope using the targeted CFG docs above.
- [x] Keep the CFG implementation authoritative to the mirrored docs and actual package data.

### 4. Verify A330 And A320 Routes After Each Completed Batch

- [x] Keep the A330 route clean after each completed batch.
- [x] Keep the A320 route clean after each completed batch.
- [ ] Replace mirrored fallbacks only when the official mounted XML path matches or exceeds current behavior.

### 5. Fix Lighting Issue Where Surfaces Look Too White When Viewed Directly

- [x] Reproduce and fix the direct-view lighting/whitening issue with a generic MSFS-compatible renderer or material change.
  - Fixed generically by unifying the active WebGL path onto `WebGPURenderer({ forceWebGL: true })` and keeping one shared PMREM/environment/material stack before falling back to legacy `WebGLRenderer`.

### 6. Fix The WebGPU Wing Lighting/Reflection Jitter During Camera Motion

- [x] Reproduce and fix the WebGPU wing lighting/reflection jitter with a generic renderer or material change.
  - Fixed generically by routing compressed RG normal maps through the existing WebGPU node-material decode path instead of leaving them on the incorrect plain-material path.

### 7. Revisit The A320 Wing Structure / Transform Issue

- [ ] Revisit the A320 wing structure/transform issue after stock XML and CFG coverage is expanded.
- [ ] Implement generic model-level `NodeAnimation` runtime support from official docs.
  Documented-first scope:
  - [ ] Audit and list all `NodeAnimation` types present in mounted aircraft fixtures and stock docs.
  - [ ] Confirm which `NodeAnimation` fields are already parsed and preserved from model XML.
  - [x] Implement generic runtime plumbing for documented `NodeAnimation` inputs and node targets.
  - [x] Implement `NodeAnimation type="WingFlex"` only up to the published contract:
    `WING FLEX PCT`, `wingflex_scalar`, `wingflex_surface_scalar`, `wingflex_offset`, and the documented 12-node layout.
  - [ ] If the exact node deformation math is still not published, mark the remaining transform behavior as blocked rather than guessing.
  - [ ] Verify A320 and A330 with agent-browser screenshots before checking this item off.
  Current status:
  - A generic additive `WingFlex` node runtime is implemented from model XML and documented simvar/cfg inputs.
  - It runs on the A320/A330 fixture routes and does not override behavior XML.
  - The earlier local-Y basis bug in the `WingFlex` runtime has now been replaced with parent-space offsets derived from a shared aircraft/world-up direction.
  - The next step is fixture verification, not more XML parsing work, unless the wing issue still remains after this runtime correction.
- [ ] If it still remains after the stock-support work, fix it generically, non-heuristically, and not aircraft-specifically.
