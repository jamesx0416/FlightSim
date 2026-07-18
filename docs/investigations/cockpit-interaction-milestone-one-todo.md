# Cockpit Interaction Milestone One - Status

This is the authoritative implementation and remaining-work checklist for milestone one. Completed items are collected first. Browser-only claims remain unchecked until exercised against a mounted package.

Final automated verification on 2026-07-18: 187 tests passed with 805 expectations; typecheck, lint, and `git diff --check` passed.

## Completed

### Profiles, remapping, and Settings

- [x] Resolve physical mouse inputs through the selected effective profile instead of hardcoded browser button and wheel mappings.
- [x] Capture all three mouse buttons and both wheel directions, reject same-context conflicts, and allow intentional interaction-versus-empty-cockpit sharing.
- [x] Support profile create, duplicate, rename, delete, reset, global selection, package-plus-aircraft selection, and removal of an aircraft override.
- [x] Migrate version 1, preserve corrupt stores under recovery keys, validate DevApi import/export, and use one atomic Settings draft.
- [x] Apply saves once; Cancel and Resume discard; Escape cancels an active capture or otherwise closes and discards; Reset remains a draft until Apply.
- [x] Expose the complete workflow through Settings and `window.__DevApi.interactions.profiles`.

Browser evidence on 2026-07-17 covered Mouse0/Mouse1/Mouse2/WheelUp/WheelDown capture, same-context conflict text, cross-context sharing, draft isolation, Resume discard, Apply persistence, deletion, and restoration to the protected `MSFS Mouse` profile. The post-fix Escape rerun remains listed under acceptance because browser authorization became unavailable after the regression was fixed.

### Mouse and scheduler lifecycle

- [x] Emit the first single, second single, and matching double without delaying either single.
- [x] Dispatch authored `DownRepeat` and `MoveRepeat` routes.
- [x] Honor authored repeat timing, long press, minimum hold, delayed release, and spring return through the simulator-time scheduler.
- [x] Wire cancellation for lost capture, pointer cancellation, blur, Escape, cockpit exit, aircraft/runtime/LOD replacement, profile replacement, target loss, and explicit cancellation.

### Complete history and detailed tracing

- [x] Aggregate wheel bursts within 120 ms.
- [x] Record logical mouse, cockpit drag, camera pan/zoom, settings/profile, aircraft/cockpit/app-version, cancellation, unsupported, unavailable, and claimed gauge-surface actions.
- [x] Coalesce each logical click, drag, camera gesture, wheel burst, and exact Set/Adjust operation into one compact history entry.
- [x] Persist a versioned latest-300 history, migrate the legacy raw array, and include structured detail plus stable one-line formatting.
- [x] Bound memory-only detailed tracing by 10,000 records and approximately 16 MB, dropping the oldest records into one coalesced overflow marker.
- [x] Trace canonical and selected MSFS routes, movement, hit tests, blockers, variable reads/writes, InputEvent/RPN, key/HTML/bridge events, feedback-driven animation state, effects, sound, scheduler timing, cancellation, and provenance.
- [x] Keep detailed tracing disabled and lazy by default and export timestamped JSON explicitly through DevApi.

### DevApi contract

- [x] Resolve only authored semantic `variant` selectors and reject missing or ambiguous variants with structured diagnostics and suggestions.
- [x] Preserve every canonical field through `dispatch()`, including phase, source, pointer, channel, axis, axis value, delta, drag percentage, steps, direction, value, unit, and timestamp.
- [x] Return an authoritative control kind or `unknown` with diagnostics from `list()`, and expose provenance, declaration occurrence, typed parameters, variants, covers/blockers, localization, timing, and diagnostics from `describe()`.
- [x] Return structured active lifecycle state, release a held target by stored identity, expose shared history/trace, export trace JSON, and provide complete profile management.
- [x] Keep reads synchronous, start action Promises immediately, preserve structured failure envelopes, and remove the deleted raw pointer/key/wheel helpers from documentation.

### Exact Set/Adjust authority

- [x] Replace blind timeout/animation-frame settling with watched authoritative value changes, authored settle timing, and two complete simulator ticks.
- [x] Read exact state independently of tooltip expressions and reject tooltip-only state as non-authoritative.
- [x] Compile and preflight static setters, transition graphs, bounds, static/asymmetric increments, inclusive cyclic bounds, and directly proven unit relationships.
- [x] Compile typed `BINDING_INC`/`BINDING_DEC`/`BINDING_SET` parameter schemas, pure current-state dynamic increments, deterministic numeric Set transforms, and authoritative compatible unit conversions.
- [x] Cover direct Set, converged Set, Adjust, shortest cyclic routing with Increase winning ties, cancellation, target loss, no progress, state cycles, and fail-closed result codes in focused tests.

### Feedback and localization

- [x] Resolve package-authored static titles, descriptions, enum/state labels, action hints, and unavailable feedback through one shared viewer/DevApi presentation resolver.
- [x] Render the proven Legacy cursor/tooltip and Lock highlight, current value, and available-action presentation with explicit diagnostics for unknown metadata.

### Hit testing and camera arbitration

- [x] Use an explicit `active`/`consumed`/`miss` result so claimed, unbound, unsupported, busy, unavailable, blocker, cover, and gauge-surface hits cannot start camera pan or zoom.
- [x] Expose deduplicated bound VCockpit surface meshes as input claims while retaining them as occluders, so a gauge screen consumes input and still hides controls behind it.
- [x] Preserve package priority, depth, `PrioritizeVCockpits`, `IgnoreZTest`, fallback hitboxes, pointer capture, LOD/target cancellation, and true-miss camera routing in the generic viewer path.
- [x] Cover priority/depth, blocker/cover occlusion, fallback hitboxes, `PrioritizeVCockpits`, `IgnoreZTest`, and claimed gauge surfaces with focused geometric tests.

### Observability, acceptance, and documentation

- [x] Keep cumulative dispatcher miss counters for `raycast`, `unsupported`, `unavailable`, `busy`, blocker, cover, and target loss, plus the latest structured detail.
- [x] Add unsupported, unavailable, busy, and claimed-gauge mouse attempts to compact history; keep blockers in cumulative counters and detailed trace.
- [x] Add pre-dispatch rejection and detailed hit records to trace.
- [x] Expose compiler/runtime diagnostics and cumulative dispatcher totals through `__DevApi.report()` and the interaction APIs.
- [x] Load the local A339X and record its 1,619 compiled interactions, zero runtime errors during acceptance, DevApi/profile results, exact preflight blockers, history, and trace export.
- [x] Verify with focused tests that claimed interaction and gauge outcomes consume input while only a true miss can select camera behavior.
- [x] Confirm the milestone diff adds no aircraft-specific runtime rules and changes no `aircrafts/` fixture data.
- [x] Document the completed interactions, profiles, shared history, and trace APIs and remove stale raw-input documentation.

## Remaining

### Exact Set/Adjust

- [ ] Compile mutable runtime-counter acceleration expressions. Unproven acceleration remains fail closed.
- [ ] Complete mounted-package exact Set/Adjust browser acceptance. The A339X scan found 23 increment/decrement candidates, but only three also had current value, bounds, unit, and static step metadata; each correctly returned `VALUE_REACHABILITY_UNKNOWN` with zero steps and no mutation because an authoritative state read was unavailable. No mounted target exposed both two or more `setStates` and readable current state.

### Presentation and structured metadata

- [ ] Compile authored dynamic/rich value formatting instead of falling back to `Intl.NumberFormat` when the format cannot be proven.
- [ ] Compile rich and animated tooltip entries rather than flattening them to one title/description.
- [ ] Preserve model-specific directional/center cursor fields and center radius.
- [ ] Compile and honor `LockFlagsTemporary`.
- [ ] Compile and honor `DragFlagsLockable`.
- [ ] Compile and honor `DragUseAnimLag`.
- [ ] Compile CallbackDragging `XScale`, `YScale`, and `ZScale` independently.
- [ ] Preserve interaction `GroupID` for authored grouping and compound arbitration.
- [ ] Diagnose any unknown future interaction-model instance instead of silently ignoring it. Mounted MSFS 2020 stock currently uses only `IMDefault` and `IMDrag`.

### Fail-closed compiler behavior

- [ ] Remove the compiler fallback that invents `LeftSingle` when no route can be discovered.
- [ ] Record a structured diagnostic whenever an interaction candidate is dropped because its target, callback, template, or route cannot be compiled.
- [ ] Distinguish unsupported-template, unsupported-event, dynamic-route-unproven, and invalid-expression failures.
- [ ] Add compiler totals for candidates, compiled bindings, rejected bindings, and rejection reasons.

### Browser acceptance and verification

- [ ] Complete live browser cancellation acceptance for actual pointer-capture loss, LOD replacement, and target disappearance. Deterministic lifecycle tests cover the implementation, but these DOM/package paths have not all been exercised live.
- [ ] Complete direct browser acceptance for interaction meshes, fallback hitboxes, gauges, blockers/covers, LOD replacement, and target disappearance.
- [ ] Run direct-mouse and DevApi acceptance across the complete representative A330 control matrix in both Legacy and Lock, including presentation and exact controls. Profile/DevApi behavior and one representative EFB button passed.
- [ ] Rerun Settings Escape and claimed-hit camera arbitration in Agent Browser after the local browser-command authorization service recovers. Focused regression tests pass, but the post-fix live rerun was denied by a 503 from the approval service.
- [ ] Run the same generic acceptance against a second mounted aircraft package. The selector currently exposes only three liveries from the same Headwind A339X package.
- [ ] Complete the compiler/control matrix for every channel, phase, callback kind, EventID/InputEvent route, compound control, timing mode, precedence rule, and unsupported MSFS 2024 diagnostic.
- [ ] Scan every mounted stock MouseRect interaction-model instance and MouseFlags token.
- [ ] Verify every advertised operation in Legacy and Lock or retain an explicit unsupported diagnostic.
- [ ] Verify model-specific cursor, tooltip, timing, scale, and lock metadata on focused stock fixtures.
- [ ] Repeat the claimed-hit camera check with real browser coordinates after browser authorization recovers.
