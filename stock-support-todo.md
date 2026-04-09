# Stock Support TODO

This checklist tracks authoritative MSFS stock support work against the mounted public Asobo XML set and mirrored CFG docs.

Rules:
- Prefer the official mounted XML/docs over local approximations.
- Keep fixes generic and reusable across aircraft.
- Mark items done only when the loader/compiler/runtime support is implemented and verified on at least the A330 and A320 routes where relevant.
- Stock XML items can only be checked when the relevant official docs/reference pages have been read for that area and the implementation has been updated or confirmed against them.
- Reference-doc items can only be checked when they have actually been reviewed during implementation, not merely downloaded.
- No item can be checked off unless an `agent-browser` verification pass has been run on both the A330 and A320 routes, screenshots have been taken, and those screenshots indicate nothing is broken and the change likely works.
- Continue the implementation until every checklist item that is in scope for this repo is either completed and checked off or explicitly blocked with a documented reason; do not stop early just because a subset is finished.

## 1. Create A Granular Stock-Support Checklist

- [x] Create a granular stock-support checklist covering each mounted XML family and each targeted CFG file.

## 2. Implement Deeper Generic Stock Behavior Support Across Mounted Asobo XML Families

### Core Plumbing

- [x] Support mounted stock `layout.json` for behavior-root resolution.
- [x] Mount public stock Asobo XML root by default.
- [x] Resolve stock behavior includes across mounted roots.
- [x] Support dynamic stock XML tag preprocessing.
- [x] Support `<Parameters Type="Default|Override">`.
- [x] Support parameter-block `Condition` / `Switch`.
- [x] Support `Process="Int|Float|Param"`.
- [x] Support direct `<Update ...>` nodes.
- [x] Support `ASOBO_GT_Anim` in simvar and code forms.
- [ ] Replace remaining mirrored stock-template fallbacks where the general XML evaluator can do so safely.
  Current blockers:
  - mirrored helper fallbacks still exist as safety net templates when a referenced template is absent from the mounted stock XML set
  - the official mounted `Asobo/Exterior.xml`, `Asobo/Common.xml`, `Asobo/Common/Index.xml`, `Asobo/Generic.xml`, `Asobo/Generic/FX.xml`, and `Asobo/Generic/Index.xml` paths now compile and run cleanly on both the A330 and A320 routes after the generic condition-truthiness and direct `<Animation>` support fixes
  - the next remaining reduction step is to prove the broader helper/input/template families match or exceed the mirrored fallback behavior across both fixtures before deleting those shims

### Stock XML Files

Scope note:
- See [stock-support-scope.md](/Users/4980/.t3/worktrees/FlightSim/msfs-combined-375b8e3b-fresh/stock-support-scope.md) for the currently exercised public stock XML set on the A320/A330 fixture routes.
- The current fixture include graph exercises `Common.xml`, `Common/Index.xml`, `Exterior.xml`, `Generic.xml`, `Generic/FX.xml`, and `Generic/Index.xml`.
- XML files outside that exercised set should stay unchecked until they are either:
  - exercised and verified on the fixture routes, or
  - explicitly documented as blocked / out of current runtime scope.

#### AircraftTypes

- [ ] `AircraftTypes/Gliders.xml`
- [ ] `AircraftTypes/Rotorcrafts.xml`

#### Airliner

- [ ] `Airliner/AS02A.xml`
- [ ] `Airliner/Airbus.xml`
- [ ] `Airliner/AirlinerCommon.xml`
- [ ] `Airliner/Boeing.xml`
- [ ] `Airliner/FMC.xml`
- [ ] `Airliner/GlassCockpit.xml`
- [ ] `Airliner/Inputs/Airliner_Inputs.xml`

#### Common

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

#### Common Inputs

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

#### Common Subtemplates

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

#### Exterior

- [x] `Exterior.xml`

#### GPS

- [ ] `GPS/AS430.xml`
- [ ] `GPS/AS530.xml`
- [ ] `GPS/Aera.xml`
- [ ] `GPS/Inputs/AS430_Inputs.xml`
- [ ] `GPS/Inputs/Aera_Inputs.xml`

#### Generic

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

#### Generic Complex

- [ ] `Generic/Complex/Index.xml`
- [ ] `Generic/Complex/Joystick.xml`
- [ ] `Generic/Complex/Knob.xml`
- [ ] `Generic/Complex/Lever.xml`
- [ ] `Generic/Complex/Misc.xml`
- [ ] `Generic/Complex/PushButton.xml`
- [ ] `Generic/Complex/Switch.xml`

#### Generic Subtemplates

- [ ] `Generic/Subtemplates/Animations_Subtemplates.xml`
- [ ] `Generic/Subtemplates/Interactions_Subtemplates.xml`
- [ ] `Generic/Subtemplates/Updates_Subtemplates.xml`

#### GlassCockpit

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

#### Inputs

- [ ] `Inputs/Generic.xml`
- [ ] `Inputs/Helpers.xml`
- [ ] `Inputs/Index.xml`
- [ ] `Inputs/Templates.xml`

#### Misc

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

#### NAVCOM

- [ ] `NAVCOM/ADF.xml`
- [ ] `NAVCOM/AS92.xml`
- [ ] `NAVCOM/ASNAV.xml`
- [ ] `NAVCOM/KAP140.xml`
- [ ] `NAVCOM/NavComSystem.xml`
- [ ] `NAVCOM/SimpleCom.xml`
- [ ] `NAVCOM/Inputs/NavComSystem_Inputs.xml`
- [ ] `NAVCOM/Inputs/SimpleCom_Inputs.xml`

#### Transponder

- [ ] `Transponder/AS21.xml`
- [ ] `Transponder/AS330.xml`
- [ ] `Transponder/Transponder.xml`

### CFG Reference Targets

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

### Reference Docs Pack

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

### Template Explorer HTML Pack

- [x] Download the rendered Template Explorer HTML pages for the mounted stock XML set.
- [x] Keep the rendered HTML pack separate from the mounted runtime XML pack.
- [x] Use the rendered HTML pages as reference/debug support only, not as runtime behavior sources.

## 3. Implement Broader Generic CFG Support For Targeted MSFS CFG Files

- [x] Expand runtime and importer support beyond the current `aircraft.cfg`, `model.cfg`, and `texture.cfg` scope using the targeted CFG docs above.
- [x] Keep the CFG implementation authoritative to the mirrored docs and actual package data.

## 4. Verify A330 And A320 Routes After Each Completed Batch

- [x] Keep the A330 route clean after each completed batch.
- [x] Keep the A320 route clean after each completed batch.
- [ ] Replace mirrored fallbacks only when the official mounted XML path matches or exceeds current behavior.

## 5. Fix Lighting Issue Where Surfaces Look Too White When Viewed Directly

- [ ] Reproduce and fix the direct-view lighting/whitening issue with a generic MSFS-compatible renderer or material change.

## 6. Fix The WebGPU Wing Lighting/Reflection Jitter During Camera Motion

- [ ] Reproduce and fix the WebGPU wing lighting/reflection jitter with a generic renderer or material change.

## 7. Revisit The A320 Wing Structure / Transform Issue

- [ ] Revisit the A320 wing structure/transform issue after stock XML and CFG coverage is expanded.
- [ ] If it still remains after the stock-support work, fix it generically, non-heuristically, and not aircraft-specifically.
