# FlightSim Codebase Performance and Architecture Review

## Executive summary

The codebase is in a generally strong state. It has a clear engine first architecture, strict TypeScript configuration, a comprehensive and fast test suite, explicit diagnostics, good resource disposal, and useful separation between simulator neutral engine code and MSFS specific integration.

The main opportunities are concentrated in a few very large modules and several hot runtime paths. The highest value work is to reduce unchanged state publication, avoid repeated full scene traversal, lower default rendering cost, remove per frame allocations, and divide the largest modules into lifecycle focused components.

The best first implementation is changed only state storage and publication. It has a contained scope, existing test coverage, and affects continuous frame cost.

## Current codebase state

### Scale

The TypeScript source contains approximately 59,252 lines.

The largest files are:

1. `src/main.ts`, approximately 14,911 lines
2. `src/msfs/runtime.ts`, approximately 7,258 lines
3. `src/msfs/behavior.ts`, approximately 4,669 lines
4. `src/devApi.ts`, approximately 3,401 lines
5. `src/msfs/gltf/normalizeMsfsMaterials.ts`, approximately 2,247 lines
6. `src/msfs/importer.ts`, approximately 1,453 lines

These files contain several distinct responsibilities and are now large enough that maintenance cost, code discovery, and accidental coupling are becoming significant concerns.

### Validation results

At the time of inspection:

1. Type checking passed.
2. All 200 tests passed.
3. The test suite completed in approximately 1.44 seconds.
4. The production build passed in approximately 3.70 seconds.
5. The main production JavaScript chunk was approximately 2,019.37 kB minified and 539.50 kB compressed.
6. Vite warned that some chunks exceeded 500 kB.
7. The worker build included browser externalisation warnings for Node modules referenced by `workerpool`, including `worker_threads`, `os`, and `child_process`.

### Existing strengths

1. The architecture documentation clearly defines an engine first, simulator agnostic direction.
2. `src/sim/engine` is separated well from MSFS integration code.
3. TypeScript strict mode is enabled.
4. The test suite is broad and fast.
5. Existing expression dependency detection provides a strong basis for revision driven updates.
6. VCockpit capture already includes dirty tracking, adaptive intervals, and concurrency limits.
7. Aircraft loading exposes detailed phase diagnostics.
8. Static optimisation systems are already loaded dynamically.
9. Resource disposal is generally handled carefully.
10. Runtime and interaction diagnostics are unusually detailed and useful.

## Highest priority performance improvements

### 1. Stop publishing unchanged runtime variables every frame

`SharedMsfsRuntimeHost.tick()` calls the following methods every frame in `src/msfs/runtime.ts` around line 1837:

1. `publishPropulsionVariables`
2. `publishControlVariables`
3. `publishElectricalVariables`

These methods republish many values even when their values have not changed. This creates repeated state lookups, object creation, revision increments, map writes, dependency evaluation, and garbage collection pressure.

Recommended changes:

1. Track the previously published value for every runtime variable.
2. Publish only when the source value has materially changed.
3. Use an appropriate tolerance for floating point simulation values.
4. Keep exact equality for booleans, strings, integer states, and identifiers.
5. Add a batch update API so multiple changed variables can be committed together.
6. Record counters for attempted publications, skipped unchanged publications, and committed changes.

Expected benefit:

This should reduce continuous CPU and garbage collection cost across every frame, particularly when the aircraft is idle or changing slowly.

### 2. Make `SimStateStore.set()` a true no operation for equivalent values

`SimStateStore.set()` in `src/sim/engine/state.ts` around line 76 currently reads the previous entry, creates a new entry, increments the revision, writes it, and then reads the selected entry before checking equivalence.

Recommended changes:

1. Compare the incoming source value with the existing source value before allocating a new entry.
2. Return immediately when the source value is equivalent.
3. Increment revisions only for meaningful changes.
4. Avoid downstream selector work when the selected value cannot change.
5. Add a batch setter for related updates.
6. Preserve source priority semantics and source fallback behaviour.

Expected benefit:

This is the most contained high value optimisation because it reduces work at the central state boundary and benefits every producer that writes repeated values.

### 3. Lower the default renderer pixel ratio

`src/rendering/createAppRenderer.ts` uses a default pixel ratio of 2 around lines 41, 51, and 180, with antialiasing enabled.

A pixel ratio of 2 can render up to four times as many pixels as a ratio of 1. This can dominate GPU cost on high density displays.

Recommended changes:

1. Default to a pixel ratio of 1 or 1.25.
2. Add a user selectable quality setting.
3. Add dynamic resolution scaling based on recent frame time.
4. Increase resolution gradually when frame time remains below target.
5. Reduce resolution quickly when frame time exceeds target.
6. Clamp the maximum according to device capability and viewport size.
7. Consider disabling antialiasing at lower quality levels.

Expected benefit:

This is likely the largest single GPU performance improvement, especially on Retina displays and integrated graphics.

### 4. Build one reusable GLTF scene inventory

The GLTF load path in `src/main.ts`, approximately lines 10321 to 10397, performs several separate whole scene traversals for:

1. Skin repair
2. Skin normalisation
3. Texture coordinate processing
4. Vertex colour processing
5. Normal and tangent processing
6. Base vertex processing
7. Winding correction
8. Material normalisation

Several normaliser modules also traverse the scene independently.

Recommended changes:

Create a single `MsfsSceneInventory` during the first traversal. It should contain:

1. All meshes
2. All skinned meshes
3. All geometries
4. All materials
5. Nodes indexed by name
6. Material slots indexed by name
7. Parent and child relationships when useful
8. Flags indicating which repair or normalisation passes are required

Pass this inventory to subsequent processors instead of traversing the scene again.

Expected benefit:

Aircraft loading should become faster and more predictable, particularly for large models with many nodes and materials.

### 5. Index VCockpit surface matching

The VCockpit binder in `src/main.ts`, around lines 5425 and 5472, traverses the root once for each parsed surface. It then performs another traversal around line 5542 to replace materials.

The current complexity is approximately the number of surfaces multiplied by the number of scene nodes.

Recommended changes:

1. Traverse the model once.
2. Build indexes for node names, mesh names, material names, and material slots.
3. Resolve every VCockpit surface through these indexes.
4. Apply material replacement from the indexed matches.
5. Preserve deterministic ordering when duplicate names exist.
6. Include unmatched and ambiguous surface diagnostics.

Expected benefit:

This should significantly reduce VCockpit binding time on aircraft with many surfaces or large scene graphs.

### 6. Reduce the initial JavaScript bundle

The main production chunk is approximately 2 MB minified. A large portion of the application is loaded before the user needs it.

Recommended dynamic import candidates:

1. Benchmark diagnostics
2. Detailed trace export
3. Full settings interface
4. Advanced DevApi implementation after the small boot API is ready
5. HTML gauge capture
6. Overlay projection tools
7. Static optimisation tools
8. Hitbox visualisation
9. Material inspection tools
10. Other developer only diagnostics

Recommended structure:

1. Keep initial boot, renderer creation, aircraft selection, and core loading in the entry chunk.
2. Load developer systems only when the DevApi or diagnostic interface requests them.
3. Load gauge and overlay systems only when an aircraft requires them.
4. Split large settings panels by feature group.

Expected benefit:

This should improve startup time, parsing time, memory use, and cache efficiency.

## Runtime allocation and update improvements

### 7. Replace dependency value arrays with revision based dependency handles

Expression bindings in `src/msfs/runtime.ts`, including animation, visibility, and material bindings around lines 471, 541, 588, and 1448, repeatedly build arrays with `dependencies.map(...)` to determine whether inputs changed.

Recommended changes:

1. Resolve each dependency once to a stable variable handle.
2. Store the last observed revision for each handle.
3. Skip evaluation when none of the dependency revisions changed.
4. Avoid allocating a new values array every frame.
5. Evaluate directly from handles when a revision changes.
6. Share this mechanism across animation, visibility, and material bindings.

Expected benefit:

This removes recurring allocations and reduces expression evaluation work across potentially thousands of bindings.

### 8. Use selective invalidation for the runtime read cache

The runtime host read cache is cleared every frame and on every write in `src/msfs/runtime.ts`, around lines 1837 and 1971.

Recommended changes:

1. Associate cached reads with variable revisions.
2. Invalidate only entries affected by a write.
3. Use a frame generation only for values that are inherently frame scoped.
4. Keep stable computed values cached until one of their dependencies changes.
5. Measure hit rate, invalidation count, and cache size.

Expected benefit:

Repeated reads within and across frames can reuse valid values rather than rebuilding the same results.

### 9. Avoid overlay work when nothing changed

The overlay updater in `src/main.ts`, around line 8354, constructs `new URLSearchParams(window.location.search)` every frame. It also projects overlays and writes iframe styles every frame.

Recommended changes:

1. Parse the projection mode once at startup and update it only when the URL changes.
2. Track revisions for camera transform, viewport size, aircraft model transform, and overlay configuration.
3. Reproject only when a relevant revision changes.
4. Write style properties only when the resulting values differ.
5. Pause hidden or offscreen overlay updates.
6. Use a lower update frequency for overlays that do not require frame accurate movement.

Expected benefit:

This reduces main thread work and layout related browser overhead.

### 10. Reuse render pass scratch state

`src/rendering/createMsfsRenderPasses.ts` creates a new `Map` during every blend frame around line 142.

Recommended changes:

1. Keep a persistent scratch map.
2. Clear and reuse it rather than allocating a new map.
3. Precompute material and object render capabilities during refresh.
4. Rebuild capability data only when the scene or material configuration changes.
5. Avoid repeated property discovery in the frame loop.

Expected benefit:

This removes avoidable per frame allocation and reduces repeated render classification work.

### 11. Reconsider ranged GLTF loading defaults

`src/worker/tasks/prepareMsfsGltfLod.ts` uses 256 kB range requests with concurrency 6 around lines 23 and 118, even though the complete buffer is required before parsing.

Recommended changes:

1. Benchmark one complete request against ranged requests.
2. Prefer a complete request for local Vite hosting unless measurements show a benefit from ranges.
3. Use ranged requests only when partial content, remote latency, retry isolation, or cache behaviour provides a measured advantage.
4. Adjust concurrency according to source type.
5. Avoid slicing and reassembling buffers when it does not improve elapsed load time.

Expected benefit:

A complete request may reduce request overhead, memory copies, and buffer assembly cost for local development and local package files.

## Duplicated code and abstraction opportunities

### 12. Unify the two frame loop branches

The frame loop in `src/main.ts`, around line 3176, has separate profiling and normal execution branches with duplicated frame work.

Recommended changes:

1. Extract one frame execution function.
2. Pass an optional profiler or instrumentation interface.
3. Keep render, simulation, input, overlay, and diagnostic order identical in both modes.
4. Use no operation instrumentation when profiling is disabled.

Expected benefit:

This reduces drift between modes and makes future frame loop optimisation safer.

### 13. Consolidate MSFS package path helpers

Similar path normalisation and package path logic exists in:

1. `src/main.ts`, around line 11040
2. `src/msfs/importer.ts`, around line 252
3. `src/msfs/behavior.ts`, around line 4631

Recommended change:

Create `src/msfs/packagePath.ts` containing the canonical implementations for:

1. Path separator normalisation
2. Package relative path handling
3. Case handling rules
4. URI and file path conversion
5. Parent and child path resolution
6. Path comparison

Expected benefit:

This prevents subtle disagreement between loading, importing, and behaviour systems.

### 14. Extract a common dependency tracked evaluator

Animation, visibility, and material binding code in `src/msfs/runtime.ts`, around lines 471, 541, and 588, repeats the same pattern:

1. Resolve dependencies
2. Read dependency values
3. Compare with previous values
4. Evaluate an expression
5. Apply a result

Recommended changes:

1. Extract a common dependency tracked evaluator.
2. Keep each binding type's result application explicit.
3. Use revision based invalidation rather than copied value arrays.
4. Expose evaluation and skip counters by binding category.

Expected benefit:

This removes duplicated mechanics while preserving clear domain specific behaviour.

### 15. Avoid duplicate importer passes

`src/msfs/importer.ts`, around lines 148 to 159, performs a lightweight pass and then a full pass. When an explicit aircraft identifier is selected, the selected aircraft can effectively be processed twice.

Recommended changes:

1. Cache imported package records between passes.
2. Return lightweight metadata and the fully imported selected record from one pass where possible.
3. Defer full import until selection only when no explicit identifier exists.
4. Replace repeated array lookup in `resolveLayoutEntrySize`, around line 310, with a map keyed by normalised package path.

Expected benefit:

This reduces package parsing, file lookup, and object construction during aircraft selection and loading.

### 16. Unify VCockpit surface and backend gauge loading

VCockpit surface loading and backend gauge loading in `src/main.ts`, around lines 5307 and 5364, repeat similar lifecycle logic.

Recommended changes:

Create a shared loader with a mode describing:

1. Source type
2. Capture strategy
3. Surface binding strategy
4. Update interval
5. Failure behaviour
6. Disposal behaviour
7. Diagnostics

Expected benefit:

This reduces lifecycle duplication and makes failure handling consistent.

## Architecture and maintainability improvements

### 17. Introduce an `AircraftSession`

The current `init()` implementation captures a very large mutable application lifecycle.

Recommended interface:

```ts
interface AircraftSession {
  load(): Promise<void>;
  updateFrame(deltaSeconds: number): void;
  setInterior(enabled: boolean): void;
  applySettings(settings: ViewerSettings): void;
  collectDiagnostics(): AircraftSessionDiagnostics;
  dispose(): void;
}
```

The session should own:

1. Loaded aircraft scene resources
2. MSFS runtime instances
3. Interaction systems
4. VCockpit systems
5. Overlay systems
6. Aircraft specific event listeners
7. Aircraft diagnostics
8. Aircraft disposal

Expected benefit:

This creates a clear lifecycle boundary and reduces reliance on captured mutable state inside `main.ts`.

### 18. Split `src/main.ts` by responsibility

Suggested module structure:

```text
src/viewer/bootstrap.ts
src/viewer/AircraftSession.ts
src/viewer/frameLoop.ts
src/viewer/settings/
src/viewer/diagnostics/
src/msfs/modelLoading/
src/msfs/vcockpit/runtime.ts
src/msfs/vcockpit/capture.ts
src/msfs/vcockpit/overlay.ts
src/msfs/vcockpit/materialBinding.ts
src/input/cockpitController.ts
```

Recommended migration approach:

1. Extract pure helpers first.
2. Extract systems with clear construction and disposal boundaries.
3. Introduce `AircraftSession` after ownership is clearer.
4. Leave `main.ts` as composition and startup code.
5. Preserve DevApi behaviour through each extraction.

### 19. Split `src/msfs/runtime.ts` by subsystem

Suggested module structure:

```text
src/msfs/runtime/AircraftRuntime.ts
src/msfs/runtime/SharedMsfsRuntimeHost.ts
src/msfs/runtime/runtimeVariables.ts
src/msfs/runtime/runtimeEvents.ts
src/msfs/runtime/runtimeSounds.ts
src/msfs/runtime/canonicalAircraftFactory.ts
src/msfs/runtime/runtimeBindings.ts
```

Recommended ownership:

1. `AircraftRuntime.ts` owns one aircraft runtime instance.
2. `SharedMsfsRuntimeHost.ts` owns shared scheduling and state integration.
3. `runtimeVariables.ts` owns variable definitions, handles, and revisions.
4. `runtimeEvents.ts` owns simulator and interaction events.
5. `runtimeSounds.ts` owns sound state and playback coordination.
6. `canonicalAircraftFactory.ts` owns canonical setup construction.
7. `runtimeBindings.ts` owns animation, visibility, and material binding evaluation.

Expected benefit:

This reduces merge conflicts, makes hot paths easier to profile, and clarifies subsystem ownership.

### 20. Add a real linting configuration

The current `lint` script only runs TypeScript type checking. The TypeScript configuration has `noUnusedLocals` and `noUnusedParameters` disabled.

Recommended changes:

1. Enable unused local and unused parameter checking after an initial cleanup.
2. Add a formatter.
3. Add a small correctness focused lint configuration.
4. Avoid a large stylistic rule set that creates noisy churn.
5. Add rules for floating promises, accidental fallthrough, unsafe non null assertions where appropriate, and unreachable code.
6. Keep type checking and linting as separate scripts.

Expected benefit:

This catches dead code and common correctness issues before they accumulate in the largest files.

### 21. Replace `workerpool` with a native module worker

Only two worker methods appear to require worker dispatch, while `workerpool` adds package weight and browser externalisation warnings.

Recommended changes:

1. Use a native module `Worker`.
2. Define typed request and response messages.
3. Assign request identifiers.
4. Transfer `ArrayBuffer` values instead of copying them.
5. Add explicit cancellation and worker restart behaviour.
6. Keep worker task functions independently testable.

Expected benefit:

This should reduce bundle weight, remove Node compatibility warnings, and make browser worker behaviour easier to understand.

### 22. Optimise the Vite package revision plugin

The package revision plugin in `vite.config.ts`, around lines 91 and 235, recursively walks and stats every aircraft package at startup. Nested unbounded `Promise.all` operations can create excessive file system concurrency.

Recommended changes:

1. Calculate revisions lazily for the selected package.
2. Prefer layout metadata or known package manifests when they provide sufficient revision information.
3. Use the file watcher to update revisions incrementally.
4. Bound file system concurrency.
5. Cache the aircraft index until watcher invalidation.
6. Avoid rescanning unrelated aircraft packages after a local change.

Expected benefit:

This should reduce development server startup time and unnecessary file system pressure in large package libraries.

## General quality improvements

### Performance measurement

Add stable counters and timings for:

1. State publication attempts
2. State publication skips
3. State commits
4. Binding evaluations
5. Binding evaluation skips
6. Scene traversal count
7. Overlay projections
8. Overlay style writes
9. Render pass allocations
10. GLTF fetch time
11. GLTF parse time
12. Scene normalisation time
13. VCockpit binding time
14. Frame CPU time by subsystem
15. Dynamic resolution changes

Expose these through the existing DevApi and benchmark tools.

### Performance budgets

Define measurable budgets for:

1. Initial JavaScript transferred size
2. Initial JavaScript parse and execution time
3. Aircraft package discovery time
4. Time to first rendered aircraft frame
5. GLTF normalisation time
6. VCockpit binding time
7. Main thread frame time
8. GPU frame time where measurable
9. Idle frame allocations
10. Memory after aircraft unload and reload

### Regression tests

Add tests that verify:

1. Equivalent `SimStateStore.set()` calls do not increment revisions.
2. Unchanged runtime publication does not trigger binding evaluation.
3. Source priority changes still update selected values correctly.
4. Batch updates produce deterministic revisions.
5. Scene inventory results match the previous traversal based implementation.
6. VCockpit indexed matching preserves existing matching behaviour.
7. Profiling and non profiling frame modes execute the same frame stages.
8. Aircraft session disposal releases all owned resources.
9. Dynamic imports do not change DevApi availability contracts.
10. Worker cancellation and failure recovery work correctly.

## Recommended implementation order

1. Make state storage ignore equivalent source values.
2. Stop unconditional per frame publication of static or unchanged runtime state.
3. Introduce variable revisions and remove per frame dependency value arrays.
4. Lower the renderer pixel ratio and add dynamic resolution.
5. Build one reusable GLTF scene inventory.
6. Index VCockpit surface matching.
7. Unify the profiling and normal frame loops.
8. Split VCockpit and diagnostic systems and load optional systems dynamically.
9. Remove the duplicate importer pass.
10. Replace `workerpool` and optimise development package revision scanning.
11. Introduce `AircraftSession` and continue splitting the largest modules.
12. Add linting and stricter unused code checks after the structural cleanup.

## Suggested first patch

The first patch should focus on changed only state storage and publication.

Scope:

1. Add source value equivalence checks to `SimStateStore.set()`.
2. Preserve all existing source priority and fallback semantics.
3. Prevent revision changes for equivalent source writes.
4. Update runtime publication helpers to skip unchanged values before calling the store where practical.
5. Add counters for attempted, skipped, and committed publications.
6. Add focused tests for equivalent values, source replacement, fallback behaviour, floating point tolerance, and batch updates.
7. Run the complete test suite and production build.

Why this should be first:

1. It affects a continuous frame cost.
2. It has a contained implementation surface.
3. The state system already has strong test coverage.
4. It creates the revision semantics needed by later dependency tracking improvements.
5. It should improve performance without changing visible aircraft behaviour.

## Constraints to preserve

All performance work should continue to follow the repository architecture rules:

1. Keep simulator neutral behaviour in `src/sim/engine`.
2. Keep MSFS specific adaptation in `src/msfs`.
3. Do not introduce aircraft specific heuristic fixes into the general engine.
4. Keep all viewer capabilities available through `window.__DevApi`.
5. Use `bun` for scripts and verification.
6. Do not modify aircraft fixture data to hide an engine problem.
7. Validate changes with type checking, focused tests, the complete test suite, and a production build.
