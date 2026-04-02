# MSFS Compatibility Contracts

Phase 0 defines the compatibility surface and the internal schemas that every later phase will target. These contracts are package-generic by design: the importer and runtime are not allowed to hard-code A320-, A380-, or vendor-specific logic into the default path.

## Documented Surface Inventory

- Package/config surface: `aircraft.cfg`, `model.cfg`, `panel.cfg`, `panel.xml`, `sound.xml`, manifest/layout metadata, and referenced assets under `SimObjects`, `html_ui`, `ModelBehaviorDefs`, and package-level shared folders.
- Behavior surface: model XML LOD declarations, behavior includes, template references, calculator/RPN expressions, animation bindings, node visibility, and interaction definitions.
- Runtime surface: SimVars, LVars, BVars, key/input events, deterministic update timing, animation state, node visibility, and attachment/effect triggers.
- Panel surface: HTML/JS gauges, panel textures/surfaces, simulator bridge bindings, and hosted instrument lifecycle.
- WASM surface: documented aircraft-facing APIs only, with version separation for 2020 vs 2024 behavior.
- Sound surface: sound XML triggers, Wwise package declarations, RTPC bindings, and local/simvar-driven conditions.

## Internal Contracts

The canonical Phase 0 schemas live in [`src/msfs/contracts.ts`](/Users/4980/.t3/worktrees/FlightSim/t3code-ccbef850/src/msfs/contracts.ts).

- `NormalizedPackageImportCache`: package-level IR emitted by the importer.
- `CompiledBehaviorContract`: the placeholder schema for Phase 2 output, so importer/runtime work does not invent its own ad hoc formats later.
- `RuntimeContracts`: the host service contract for variables, events, animation, nodes, panels, sound, and lifecycle.
- `CompatibilityTestMatrix`: fixture classes and exit criteria used to judge subsystem readiness.

## Compatibility Categories

- `package-import`: discovery, normalization, asset manifests, cache generation.
- `behavior-compile`: XML include/template resolution and compiled graph output.
- `runtime-vars-events`: runtime variable/event host semantics.
- `model-behaviors`: animation, node visibility, interaction, and effect execution.
- `panels`: `panel.cfg`, hosted HTML/JS gauges, and simulator JS bridge behavior.
- `wasm-host`: documented host shim for aircraft WASM usage.
- `sound`: sound XML parsing, condition evaluation, and audio parameter routing.
- `overrides`: explicit escape hatches for edge cases without polluting the generic path.

## Test Matrix Intent

Phase 0 keeps the matrix at the fixture-class level instead of pinning it to one airplane. Current coverage explicitly includes:

- single-aircraft packages
- base-container variant packages
- HTML instrument packages
- WASM-assisted packages
- sound-heavy packages

That keeps the importer/runtime generic and lets aircraft-specific fixtures serve only as verification targets.
