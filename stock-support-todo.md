# Stock Support TODO

This checklist tracks authoritative MSFS stock support work against the mounted public Asobo XML set and mirrored CFG docs.

Rules:
- Prefer the official mounted XML/docs over local approximations.
- Keep fixes generic and reusable across aircraft.
- Mark items done only when the loader/compiler/runtime support is implemented and verified on at least the A330 and A320 routes where relevant.
- Stock XML items can only be checked when the relevant official docs/reference pages have been read for that area and the implementation has been updated or confirmed against them.
- Reference-doc items can only be checked when they have actually been reviewed during implementation, not merely downloaded.
- No item can be checked off unless an `agent-browser` verification pass has been run on both the A330 and A320 routes, screenshots have been taken, and those screenshots indicate nothing is broken and the change likely works.

## Core Plumbing

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

## Stock XML Files

### AircraftTypes

- [ ] `AircraftTypes/Gliders.xml`
- [ ] `AircraftTypes/Rotorcrafts.xml`

### Airliner

- [ ] `Airliner/AS02A.xml`
- [ ] `Airliner/Airbus.xml`
- [ ] `Airliner/AirlinerCommon.xml`
- [ ] `Airliner/Boeing.xml`
- [ ] `Airliner/FMC.xml`
- [ ] `Airliner/GlassCockpit.xml`
- [ ] `Airliner/Inputs/Airliner_Inputs.xml`

### Common

- [ ] `Common.xml`
- [ ] `Common/Aircraft.xml`
- [ ] `Common/Autopilot.xml`
- [ ] `Common/Deice.xml`
- [ ] `Common/Electrical.xml`
- [ ] `Common/Engine.xml`
- [ ] `Common/Fuel.xml`
- [ ] `Common/Handling.xml`
- [ ] `Common/Index.xml`
- [ ] `Common/Instrument.xml`
- [ ] `Common/LandingGear.xml`
- [ ] `Common/Lighting.xml`
- [ ] `Common/Passenger.xml`
- [ ] `Common/Pilot.xml`
- [ ] `Common/Pressurization.xml`
- [ ] `Common/Safety.xml`

### Common Inputs

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

### Common Subtemplates

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

### Exterior

- [ ] `Exterior.xml`

### GPS

- [ ] `GPS/AS430.xml`
- [ ] `GPS/AS530.xml`
- [ ] `GPS/Aera.xml`
- [ ] `GPS/Inputs/AS430_Inputs.xml`
- [ ] `GPS/Inputs/Aera_Inputs.xml`

### Generic

- [ ] `Generic.xml`
- [ ] `Generic/AnimationTriggers.xml`
- [ ] `Generic/Animations.xml`
- [ ] `Generic/Emissive.xml`
- [ ] `Generic/FX.xml`
- [ ] `Generic/Helpers.xml`
- [ ] `Generic/Index.xml`
- [ ] `Generic/Interactions.xml`
- [ ] `Generic/Updates.xml`
- [ ] `Generic/Visibility.xml`

### Generic Complex

- [ ] `Generic/Complex/Index.xml`
- [ ] `Generic/Complex/Joystick.xml`
- [ ] `Generic/Complex/Knob.xml`
- [ ] `Generic/Complex/Lever.xml`
- [ ] `Generic/Complex/Misc.xml`
- [ ] `Generic/Complex/PushButton.xml`
- [ ] `Generic/Complex/Switch.xml`

### Generic Subtemplates

- [ ] `Generic/Subtemplates/Animations_Subtemplates.xml`
- [ ] `Generic/Subtemplates/Interactions_Subtemplates.xml`
- [ ] `Generic/Subtemplates/Updates_Subtemplates.xml`

### GlassCockpit

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

### Inputs

- [ ] `Inputs/Generic.xml`
- [ ] `Inputs/Helpers.xml`
- [ ] `Inputs/Index.xml`
- [ ] `Inputs/Templates.xml`

### Misc

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

### NAVCOM

- [ ] `NAVCOM/ADF.xml`
- [ ] `NAVCOM/AS92.xml`
- [ ] `NAVCOM/ASNAV.xml`
- [ ] `NAVCOM/KAP140.xml`
- [ ] `NAVCOM/NavComSystem.xml`
- [ ] `NAVCOM/SimpleCom.xml`
- [ ] `NAVCOM/Inputs/NavComSystem_Inputs.xml`
- [ ] `NAVCOM/Inputs/SimpleCom_Inputs.xml`

### Transponder

- [ ] `Transponder/AS21.xml`
- [ ] `Transponder/AS330.xml`
- [ ] `Transponder/Transponder.xml`

## CFG Reference Targets

- [ ] `Additional_Information/File_Formats/CFG_Files.htm`
- [ ] `Content_Configuration/Cameras/Cameras_CFG/cameras_cfg.htm`
- [ ] `Content_Configuration/Models/model_cfg.htm`
- [ ] `Content_Configuration/SimObjects/Aircraft_SimO/Aircraft.htm`
- [ ] `Content_Configuration/SimObjects/Aircraft_SimO/aircraft_cfg.htm`
- [ ] `Content_Configuration/SimObjects/Aircraft_SimO/cockpit_cfg.htm`
- [ ] `Content_Configuration/SimObjects/Aircraft_SimO/engines_cfg.htm`
- [ ] `Content_Configuration/SimObjects/Aircraft_SimO/flight_model_cfg.htm`
- [ ] `Content_Configuration/SimObjects/Aircraft_SimO/gameplay_cfg.htm`
- [ ] `Content_Configuration/SimObjects/Aircraft_SimO/Instruments/panel_cfg.htm`
- [ ] `Content_Configuration/SimObjects/Aircraft_SimO/systems_cfg.htm`
- [ ] `Content_Configuration/SimObjects/Aircraft_SimO/target_performance_cfg.htm`
- [ ] `Content_Configuration/SimObjects/Living_Things/Living_Things_sim_cfg.htm`
- [ ] `Content_Configuration/Textures/texture_cfg.htm`

## Reference Docs Pack

- [ ] `html/Introduction/Using_The_SDK.htm`
- [ ] `html/Introduction/Introduction.htm`
- [ ] `html/Content_Configuration/Models/Models.htm`
- [ ] `html/Content_Configuration/Models/Model_Definitions.htm`
- [ ] `html/Content_Configuration/Models/Model_Animation_Definitions.htm`
- [ ] `html/Content_Configuration/Models/ModelBehaviors/Model_Behaviors.htm`
- [ ] `html/Content_Configuration/Models/ModelBehaviors/General_Template_Definitions.htm`
- [ ] `html/Content_Configuration/Models/ModelBehaviors/Input_Event_Definitions.htm`
- [ ] `html/Content_Configuration/Models/ModelBehaviors/TemplateExplorer/Template_Explorer.html`
- [ ] `html/mergedProjects/How_To_Make_An_Aircraft/Contents/Model_Behaviours/Default_Templates.htm`
- [ ] `html/Asset_Creation/3D_Models/General_Principles.htm`
- [ ] `html/Asset_Creation/Blender_Plugin/The_Blender_Plugin.htm`
- [ ] `html/Content_Configuration/SimObjects/SimObjects.htm`
- [ ] `html/Content_Configuration/SimObjects/Aircraft_SimO/flight_model/interactive_points.htm`
- [ ] `html/Content_Configuration/VisualEffects/Visual_Effects_Landing_Templates.htm`
- [ ] `html/Content_Configuration/Checklists/Checklists.htm`
- [ ] `msfs2024/html/3_Models_And_Textures/Plugins/glTF_Schemas.htm`
- [ ] `msfs2024/flighting/html/3_Models_And_Textures/Textures/Materials/FlightSim_Materials.htm`
- [ ] `msfs2024/html/3_Models_And_Textures/Textures/Materials/FlightSim_Material_Parameters.htm`
- [ ] `msfs2024/flighting/html/6_Programming_APIs/SimVars/Aircraft_SimVars/Aircraft_FlightModel_Variables.htm`
- [ ] `html/mergedProjects/How_To_Make_An_Aircraft/Contents/Modelling/Airframe/Texturing/Surface_Detail__agt_index.htm`

## Template Explorer HTML Pack

- [ ] Download the rendered Template Explorer HTML pages for the mounted stock XML set.
- [ ] Keep the rendered HTML pack separate from the mounted runtime XML pack.
- [ ] Use the rendered HTML pages as reference/debug support only, not as runtime behavior sources.

## Verification

- [ ] A330 route stays clean while stock support expands.
- [ ] A320 route stays clean while stock support expands.
- [ ] Replace mirrored fallbacks only when the official mounted XML path matches or exceeds current behavior.
