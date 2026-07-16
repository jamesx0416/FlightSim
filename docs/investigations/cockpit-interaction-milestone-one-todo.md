# Cockpit Interaction Milestone One — Remaining Work

This is the authoritative remaining-work checklist for milestone one. Items stay here until implemented and verified against mounted stock templates and the local A330 fixture.

## Profiles, remapping, and Settings

- Resolve physical mouse inputs through the selected profile instead of hardcoded browser button and wheel mappings.
- Add binding capture and same-context conflict validation while allowing intentional context-exclusive sharing.
- Add profile create, duplicate, rename, delete, reset, global selection, and per-aircraft selection.
- Complete version migration, corrupt-store recovery diagnostics, DevApi import/export, and atomic draft Apply/Save/Cancel/Reset behavior.
- Expose the complete profile and remapping workflow in Settings.

## Mouse and scheduler lifecycle

- Emit native single, second-single, and matching double actions without delaying either single action.
- Dispatch authored `DownRepeat` and `MoveRepeat` routes.
- Honor authored long press, repeat timing, minimum-held duration, delayed release, and spring return through the simulator scheduler.
- Complete and verify cancellation on lost capture, blur, cockpit exit, aircraft/LOD replacement, profile replacement, target loss, and Escape.

## Complete history and detailed tracing

- Add the 120 ms wheel-burst aggregation window.
- Record logical mouse, cockpit drag, camera pan/zoom, settings/profile, aircraft/cockpit/app-version, cancellation, unsupported, and unavailable actions.
- Coalesce each logical gesture and exact Set/Adjust operation into one compact history entry.
- Bound detailed tracing by both 10,000 records and approximately 16 MB, dropping oldest records with an overflow marker.
- Feed detailed tracing canonical/MSFS events, movement samples, hit tests, blockers, InputEvent/RPN routes, variable access, events, feedback, animation, sound, cancellation, and scheduler timing.
- Add explicit detailed-trace export without persistent low-level recording.

## DevApi contract completion

- Resolve and capability-check semantic `variant` selectors; reject ambiguous defaults with valid suggestions.
- Preserve every canonical field through `dispatch()`, including phase, pointer, axis, delta, drag percentage, and device-independent values.
- Add control kind to `list()` and complete `describe()` provenance, declaration occurrence, typed parameters, covers/blockers, and diagnostics.
- Complete `active()` fire-and-forget status, release-by-held-target behavior, trace export, and profile management operations.
- Verify all named methods, selectors, state helpers, synchronous reads, immediately-started Promises, cancellation, and structured failure envelopes.

## Exact Set/Adjust authority

- Replace blind timeout/animation-frame settling with watched authoritative value notifications, authored settle timing, and two simulator ticks.
- Read authoritative state independently of tooltip expressions where package metadata provides it.
- Compile authoritative transition graphs, bounds, dynamic increments, typed parameters, and unit relationships needed to prove exact reachability before mutation.
- Verify direct Set, converged Set, Adjust, shortest cyclic routing, cancellation, target loss, no progress, value cycles, and exact result payloads.

## Feedback and localization completion

- Localize authored action labels, descriptions, enum/state values, and unavailable feedback.
- Apply authored value formatting rather than generic numeric formatting where metadata provides it.
- Complete rich Legacy cursor/tooltip presentation and Lock highlight, current-value, and available-action presentation.

## Hit testing and camera arbitration

- Ensure blockers, covers, and claimed VCockpit/gauge surfaces always consume input and never start camera movement.
- Verify package priority, depth, `PrioritizeVCockpits`, `IgnoreZTest`, disabled/unavailable controls, and compound-control separation.
- Verify pointer capture and wheel arbitration across interaction meshes, fallback hitboxes, gauges, blockers, LOD replacement, and target disappearance.

## Acceptance and documentation

- Run direct-mouse and DevApi acceptance across the complete representative A330 control matrix in Legacy and Lock.
- Run the same generic acceptance against a second mounted aircraft package.
- Complete the documented compiler/control matrix for all channels, phases, callback kinds, EventID/InputEvent routes, compound controls, timing modes, precedence, and unsupported 2024 diagnostics.
- Confirm zero aircraft-specific runtime rules and zero fixture edits.
- Remove stale documentation for deleted raw input helpers and document the completed interactions, profiles, history, and trace APIs.

## Structured metadata still required

- Preserve model-specific cursors, including directional/center cursor fields and center radius.
- Compile rich and animated tooltip entries rather than flattening them to one title/description.
- Compile and honor `LockFlagsTemporary`.
- Compile and honor `DragFlagsLockable`.
- Compile and honor `DragUseAnimLag`.
- Compile CallbackDragging `XScale`, `YScale`, and `ZScale` independently.
- Preserve interaction `GroupID` for authored grouping and arbitration.
- Diagnose any unknown future interaction-model instance instead of silently ignoring it. Mounted MSFS 2020 stock currently uses only `IMDefault` and `IMDrag`.

## Fail-closed compiler behavior

- Remove the fallback that invents `LeftSingle` when no route can be discovered.
- Record a structured diagnostic when an interaction candidate is dropped because its target, callback, template, or route cannot be compiled.
- Distinguish unsupported-template, unsupported-event, dynamic-route-unproven, and invalid-expression failures.
- Add compiler totals for candidates, compiled bindings, rejected bindings, and rejection reasons.

## Runtime observability

- Add cumulative dispatcher miss counters by reason, including `raycast-miss`, `operation-unsupported`, `interaction-unavailable`, `target-busy`, blocker/cover rejection, and target loss.
- Keep the latest miss details, but do not overwrite the only evidence of earlier failures.
- Add unsupported and unavailable mouse attempts to compact interaction history.
- Add pre-dispatch rejection records to detailed tracing.
- Expose compiler and dispatcher rejection totals through `__DevApi.report()` and interaction diagnostics.

The current report exposes aggregate attempts/executions and only the latest miss reason, so it cannot provide a trustworthy historical rejection total. A clean session with zero mouse attempts proves only that no runtime action was attempted. Until cumulative counters exist, route audits must be reported as read-only potential failures rather than observed user failures.

## Verification

- Scan every mounted stock MouseRect interaction-model instance and MouseFlags token.
- Verify that every advertised operation resolves in Legacy and Lock or has an explicit diagnostic.
- Verify model-specific cursor, tooltip, timing, scale, and lock metadata on focused stock fixtures.
- Load the local A330 and report compiler candidates, compiled bindings, rejected bindings, runtime attempts, executions, and cumulative misses.
- Confirm unsupported behavior consumes a real interaction target without falling through to the camera.
