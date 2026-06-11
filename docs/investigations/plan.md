# MSFS 2020 SimObjects Parser and Compatibility Runtime Plan

> Historical note: this was the earlier MSFS-loader-first strategy. The current
> architecture is a simulator-agnostic engine with MSFS as the first adapter.
> See [Simulation Engine Architecture](../architecture/simulation-engine.md).

**Important:** Do not implement, exit, or add anything that is aircraft-specific or heuristic. All bug fixes and changes must be generic MSFS loader fixes that apply broadly and authoritatively, not patches tailored to a specific aircraft.

## Summary

Build the project as a generic MSFS 2020 built-package importer plus behavior runtime, not as an aircraft loader. The first milestone is: the browser imports a built MSFS 2020 package served from a local repo/tmp path, normalizes it through a generic SimObjects parser, and renders the package with generic behavior-driven animation and visibility. Panels, WASM, and sound stay out of scope until that works.

The A330 is the only initial test fixture, but it is not a special-case target. The implementation must contain no A330-specific code paths, assumptions, or overrides. The acceptance statement is: "the A330 works through the same generic path intended for any MSFS 2020 built aircraft package."

## Reference Sources

Use reference material in this order:

1. Official MSFS SDK schemas, docs, and exporter/plugin code.
2. Direct evidence from the built package data imported by this repo.
3. Reverse-engineered importers only as secondary corroboration.

Current secondary reference:

- `bestdani/msfs2blend`
  - GitHub: `https://github.com/bestdani/msfs2blend`
  - Relevant file: `io_msfs_gltf.py`
  - Use only as supporting evidence for built-asset interpretation, never as the authoritative source over SDK docs or direct package evidence.

## Key Changes

### 1. Reframe the architecture around three layers

- SimObjects parser/importer
  - Input: built MSFS 2020 aircraft package served by the dev app from a repo `tmp` folder.
  - Parse and normalize package structure and references from `aircraft.cfg`, `model.cfg`, `panel.cfg`, sound config references, model behavior XML references, and asset locations.
  - Output a typed internal IR for one imported aircraft package.

- Behavior compiler
  - Resolve model behavior XML includes and templates for MSFS 2020 only.
  - Parse calculator/RPN expressions into internal IR/bytecode once at import time.
  - Produce symbol tables for nodes, animations, variables, and events needed for runtime evaluation.

- Runtime host
  - Execute a deterministic update loop for generic behavior evaluation.
  - Support only the runtime state needed for the first milestone:
    - variable reads/writes required by model behavior execution
    - animation outputs
    - node visibility outputs
  - Defer panels, WASM, and sound entirely.

### 2. Lock the first-slice boundaries

- Supported input
  - Built MSFS 2020 aircraft package folders only.
  - No raw SDK project source support in v1.
  - No MSFS 2024 support in v1, but importer/compiler interfaces must remain versionable.

- Package access model
  - The browser imports from a package folder exposed by the dev server from a local repo `tmp` path.
  - Do not build file-picker import in the first slice.
  - Do not build an offline precompiler first.

- First supported outputs
  - Generic visual model import
  - Generic animation output evaluation
  - Generic node visibility evaluation

- Explicitly deferred
  - `panel.cfg`/`panel.xml` hosting or JS instrument runtime
  - WASM host support
  - sound logic/runtime
  - aircraft-specific overrides

### 3. Define the internal interfaces before implementation

Create versioned internal IR/interfaces for:

- `ImportedPackage`
  - package root metadata
  - aircraft identity/config references
  - resolved asset graph
  - model behavior source references
  - normalized model entries

- `CompiledBehaviorSet`
  - expanded XML behavior graph
  - compiled calculator/RPN expressions
  - node/animation binding tables
  - variable/event symbol registry

- `RuntimeState`
  - variable store
  - animation channel values
  - node visibility state
  - import diagnostics and missing-feature flags

The IR may evolve during the first slice, but it must be explicitly versioned from the start so cache and diagnostics can be changed safely.

### 4. Deliver in four implementation phases

1. Phase 0: Contracts and fixture harness
   - Add a documented API inventory for the MSFS 2020 aircraft-facing surfaces relevant to model behaviors.
   - Define importer IR, compiled behavior IR, runtime state interfaces, and diagnostic types.
   - Add a fixture harness that points at a built A330 package under the repo `tmp` area.
   - Add a hard rule in docs/tests that the loader must remain generic even though only the A330 is used as the first fixture.

2. Phase 1: MSFS 2020 SimObjects parser
   - Implement package discovery from a served folder root.
   - Parse and resolve `aircraft.cfg`, `model.cfg`, and referenced model behavior sources.
   - Produce normalized asset and behavior-source manifests.
   - Emit structured diagnostics for missing files, unsupported constructs, and broken references.

3. Phase 2: Behavior compiler
   - Resolve XML includes and template expansion for MSFS 2020 behavior definitions.
   - Compile calculator/RPN expressions into internal IR/bytecode.
   - Bind compiled outputs to named nodes and animation targets.
   - Reject or flag unsupported behavior constructs explicitly rather than silently skipping them.

4. Phase 3: Generic runtime + renderer integration
   - Execute compiled behavior output in the browser runtime.
   - Feed animation channels and node visibility into the model/render layer.
   - Prove end-to-end success with the A330 fixture using only generic logic.
   - Add import/runtime diagnostics UI or console reporting so unsupported features are visible.

## Public Interfaces and Repo Shape

- Introduce a generic importer boundary such as:
  - `importBuiltMsfs2020Package(rootUrl): Promise<ImportedPackage>`
  - `compileMsfs2020Behaviors(pkg): CompiledBehaviorSet`
  - `createAircraftRuntime(compiled, hostServices): AircraftRuntime`
- Expose a dev-only package source configuration for the served `tmp` package root.
- Keep the renderer/model layer generic: it consumes normalized nodes, animations, and visibility outputs, not aircraft-specific names.

## Test Plan

- Fixture acceptance
  - A built A330 package in the repo `tmp` area imports through the generic path.
  - The same path contains no A330-specific branching, bindings, or overrides.
  - The rendered aircraft shows behavior-driven animation and node visibility changes from compiled runtime outputs.

- Importer tests
  - parses built package structure and resolves config references correctly
  - reports missing or invalid referenced files with structured diagnostics
  - normalizes package data deterministically

- Behavior compiler tests
  - resolves includes/templates for supported MSFS 2020 behavior content
  - compiles calculator/RPN expressions once at import time
  - binds compiled outputs to generic node/animation lookup tables

- Runtime tests
  - updates animation channels deterministically
  - updates node visibility deterministically
  - surfaces unsupported features as explicit diagnostics instead of silent failure

## Assumptions and Defaults

- Start with MSFS 2020 built packages only.
- The browser imports directly from a dev-served package folder under the repo `tmp` area.
- The A330 is the only initial fixture, but it is used strictly as a generic acceptance test, not as a special-case implementation target.
- The first milestone is import + generic behavior-driven render.
- Panels, WASM, and sound are deferred until the model behavior runtime works.
- The loader must remain generic across aircraft, even while only one package is used for initial testing.

## Cockpit / HTML Gauge Performance Addendum

Track a generic experimental `VCockpit` HTML gauge texture path based on the browser HTML-in-Canvas proposal and Three.js `HTMLTexture`.

- Goal:
  - let the browser render compatible HTML gauge content into a canvas or GPU texture directly, instead of manually walking iframe DOM/SVG/text/canvas trees.
- Proposed query-gated mode:
  - `?vcockpitGaugeMode=htmlTexture`
- Prerequisites:
  - upgrade Three.js to `r184+` only after confirming the project renderer path remains compatible
  - feature-detect native HTML-in-Canvas support such as `drawElementImage`, `texElementImage2D`, or WebGPU `copyElementImageToTexture`
  - document that current Chromium builds may require `chrome://flags/#canvas-draw-element`
- Required behavior:
  - never make this path the default until the browser APIs are stable enough for normal users
  - fall back to the current optimized `CanvasTexture` capture path when native HTML-in-Canvas support is unavailable
  - keep material-texture output so cockpit lighting, occlusion, reflections, and post effects still apply
  - keep all implementation generic to MSFS `panel.cfg` / `VCockpit` surface definitions and avoid aircraft-specific gauge assumptions
- Validation:
  - verify whether same-origin sandboxed gauge documents, custom elements, SVG, fonts, and gauge canvases are supported by the native browser path
  - compare capture timing, texture upload timing, visual correctness, and long-session CPU stability against the current dirty-driven canvas path
