# Cockpit Interaction Milestone One — Remaining Work

This is the authoritative remaining-work checklist for milestone one. Items stay here until implemented and verified against mounted stock templates and the local A330 fixture.

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
