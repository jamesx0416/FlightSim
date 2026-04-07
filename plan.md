# MSFS 2020 SimObjects Parser and Compatibility Runtime Plan

**Important:** Do not implement, exit, or add anything that is aircraft-specific or heuristic. All bug fixes and changes must be generic MSFS loader fixes that apply broadly and authoritatively, not patches tailored to a specific aircraft.

## Summary

Build the project as a generic MSFS 2020 built-package importer plus behavior runtime, not as an aircraft loader. The first milestone is: the browser imports a built MSFS 2020 package served from a local repo/tmp path, normalizes it through a generic SimObjects parser, and renders the package with generic behavior-driven animation and visibility. Panels, WASM, and sound stay out of scope until that works.

The A330 is the only initial test fixture, but it is not a special-case target. The implementation must contain no A330-specific code paths, assumptions, or overrides. The acceptance statement is: "the A330 works through the same generic path intended for any MSFS 2020 built aircraft package."

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
