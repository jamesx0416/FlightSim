# Runtime Authority vs Name Heuristics

Status: planning / backlog  
Date: 2026-07-22  
Related: speedbrake lever bounce (O:Position armed feedback loop), interaction IR (`inferInteractionInversion`, `discreteGate`), MSFS compatibility bridge

## Goal

If a package works in Microsoft Flight Simulator, it should work here with the same behavior.

Authority must match MSFS, not reinvent encodings in TypeScript:

1. **Expanded package code** (templates → RPN Update/Drag/callback, B: bindings)
2. **Package overrides** (exact LVars, input events, aircraft-specific expanded numbers)
3. **Exact platform contracts** (known A: simvars, K: key events, units, bridge aliases)
4. **Name heuristics** (`includes('SPOILER')`, gate math) — last resort only; never fight (1)–(3)

Template expansion is not a separate “hint system.” After expand, the RPN *is* the package. Do not re-read `ARMED_POSITION` into a second runtime encoder if the expanded Update code already uses those values.

---

## What went wrong (worked example)

### Symptom

A330neo speedbrake lever bounced 0↔1 at full retract with no user input.

### Mechanism

1. Package `UPDATE_CODE` (FBW spoilers template) re-publishes `O:LEVER_SPEEDBRAKE:POSITION` from LVars every frame:
   - armed → `0`
   - not armed, retract → `1`
   - deploy → `1 + handle * STEPS`
2. Runtime `applySpoilerObjectPosition` treated every O: write as a control command and mapped `position === 1` → armed (ASOBO-style encoding).
3. FBW uses inverted arm gate (`ARMED_POSITION=0`, retract=`1`). Side-effect flipped armed every frame → Update wrote the other O: value → oscillation.

### Fix landed (partial)

- Stop mapping discrete O: gates to armed; K/B/A/L + canonical state own armed.
- Publish/read `A:SPOILERS ARMED` from canonical state; do not let generic `SPOILER` percent heuristic swallow ARMED.
- Residual: O:Position still maps continuous deploy ratio with hard `<=3` / `/200` math (still a spoiler heuristic).

### Lesson

The package was already correct (level 1). The bug was level-4 side-effects rewriting control state from local O: mirrors. Prefer **trust expanded RPN + events** over **read template params into a second encoder**.

---

## What’s wrong (systemic)

| Problem | Why it breaks MSFS parity |
|--------|---------------------------|
| O:/component vars written by Update can side-effect controls | Update is often a **visual mirror**, not a pilot command. Feedback loops. |
| `includes('NAME')` on writes/reads | Matches wrong symbols (ARMED vs POSITION, HANDLE vs surface, left/right). |
| Hardcoded gate encodings (arm=1, steps=2, length=200) | Aircraft templates disagree; ASOBO vs FBW vs stock airliner. |
| Heuristic fallbacks winning over stored/package values | Package LVar/Update loses to substring catch-all. |
| Generic key-event name matching | Can apply flap/spoiler/gear rules to unrelated events sharing a substring. |
| Incomplete use of interaction IR params | Invert/steps/gates already compiled from XML in some paths; other paths ignore them and guess. |

These are **not** aircraft-specific bugs. They are adapter/runtime authority bugs that surface first on complex packages (e.g. A339X).

---

## How to fix (rules)

### Do

1. **Execute expanded package RPN** for Update/Drag/interaction as the behavior source of truth.
2. **Map exact contracts** (A:/K:/known L: aliases) through the compatibility bridge and publish paths.
3. **Compile interaction semantics from template params** into IR (`inverted`, `discreteGate`, value get/set, steps) — the flaps reverse-scroll model.
4. **Classify writes by role**:
   - Interaction / key / input event → may change controls
   - Update mirror of local O: → store for animation only; **no control rewrite**
5. **Heuristics only fill missing reads**, never override stored values or package mutations.
6. **Log once** when a level-4 path mutates control state (key + path) to find the next loop.

### Don’t

1. Add per-aircraft branches (`if A330 then arm=0`).
2. Build a parallel “template param → control encoder” that re-implements what expanded RPN already does.
3. Treat all O:Position writes as authoritative control inputs.
4. Grow `includes('FLAP'|'SPOILER'|...)` write side-effects.

### Package overrides

MSFS order in practice:

1. Base template defaults  
2. Aircraft `UseTemplate` / Override / aircraft model behavior XML (expanded into final RPN)  
3. Runtime state set by that RPN and by systems (LVars, B: events)

We do not need a special “override table” if we execute the **already-expanded** package graph. Overrides are already baked into the compiled expressions and bindings.

---

## Affected areas (code)

Primary:

- [`src/msfs/runtime.ts`](../../src/msfs/runtime.ts)
  - `writeVariable` / `applyVariableSideEffects`
  - `applySpoilerObjectPosition` / `isSpoilerObjectPositionKey`
  - `resolveHeuristicValue` / `resolveDynamicControlFallbackValue`
  - `applyGenericControlEventName`
  - `publishControlVariables`
- [`src/msfs/behavior.ts`](../../src/msfs/behavior.ts)
  - template expand, `inferInteractionInversion`, `discreteGate`, interaction metadata
- [`src/msfs/interactionAdapter.ts`](../../src/msfs/interactionAdapter.ts)
  - uses IR invert/gates for user input
- [`src/msfs/compatibilityBridge.ts`](../../src/msfs/compatibilityBridge.ts)
  - exact A:/L: → canonical engine state

Surfaces / symptoms:

- Spoilers / speedbrake levers (done partially)
- Flaps / slats handles and index
- Gear handle / position
- Parking brake lever anim vs switch
- Flight controls (aileron/elevator/rudder) name fallbacks
- Throttle / N1 / reverser substring fallbacks
- Any lever with `ASOBO_GT_Update` writing `O:Position` from sim state

---

## Change list (what should be fixed)

### P0 — same disease as speedbrake bounce

| ID | Item | Current (4) | Target | Notes |
|----|------|-------------|--------|-------|
| P0.1 | O: write policy | O: spoiler/speedbrake position can rewrite controls | Store-only for Update/local mirrors; controls only via K/B/A/L/interaction | Generic; prevents whole class of loops |
| P0.2 | Residual `applySpoilerObjectPosition` deploy math | Hard `<=3` / `/200` → `spoilersTarget` | Remove if stock always emits set events; else only when write is interaction-sourced | Verify stock paths before delete |
| P0.3 | `applyVariableSideEffects` control branches | `includes('FLAP'/'SLAT'/'SPOILER'/'GEAR'/…)` on A: writes | Exact simvar keys + bridge aliases only | Highest false-positive risk after spoilers |

### P1 — contracts over substrings

| ID | Item | Current (4) | Target | Notes |
|----|------|-------------|--------|-------|
| P1.1 | `applyGenericControlEventName` | Substring GEAR/FLAP/SPOILER | Exact event / input-event catalog first | Keep tiny fallback only if catalog miss |
| P1.2 | `resolveHeuristicValue` catch-alls | SPOILER/FLAP/AILERON/… → cycle % | Prefer published values + bridge; never override ARMED/HANDLE exact keys | ARMED guard already landed |
| P1.3 | Publish exact control simvars each tick | Partial | Always publish handle/position/armed (and peers) from canonical state | Stops heuristics inventing values |
| P1.4 | Grow bridge exact maps | Partial | Prefer new exact aliases over new `includes` | Generic MSFS names only |

### P2 — package-driven interaction IR (flaps model)

| ID | Item | Current | Target | Notes |
|----|------|---------|--------|-------|
| P2.1 | Invert / wheel polarity | IR exists; gaps possible | All lever/knob templates feed `inverted` | Already mostly correct |
| P2.2 | Discrete gates (`STEPS_NUMBER`, drag speed) | Partial `discreteGate` | More gate levers use IR instead of free drag guess | |
| P2.3 | Value get/set authority | Partial | Prefer compiled GET/SET_STATE from params | Diagnostics already flag unproven paths |

### P3 — contain remaining heuristics

| ID | Item | Guidance |
|----|------|----------|
| P3.1 | Throttle / N1 / reverser / brightness substring reads | Keep as last-resort **reads only**; never write controls from them |
| P3.2 | One-shot diagnostic when level-4 mutates controls | Find next feedback loop without grepping by aircraft |
| P3.3 | Tests for “Update mirror does not flip armed/handle” | Generic host tests with synthetic O: writes, not package patches |

---

## Recommended order of work

1. **P0.1** Write-source / O: store-only policy (generic, unblocks many levers).  
2. **P0.3** Narrow `applyVariableSideEffects` to exact keys + bridge.  
3. **P0.2** Delete or gate residual spoiler O→deploy mapping after stock verification.  
4. **P1.3** Full publish of exact control simvars from canonical state.  
5. **P1.2** Contain `resolveHeuristicValue` (stored/canonical win; exact ARMED/HANDLE/etc.).  
6. **P1.1** Exact key/input event catalog before name match.  
7. **P1.4** Bridge growth as gaps appear (driven by real packages, not speculation).  
8. **P2.*** Interaction IR completeness where user input still wrong.  
9. **P3.*** Diagnostics + tests to keep level-4 from growing back.

Do **not** start by inventing an `ARMED_POSITION` runtime table. Expanded package code already owns that.

---

## What is already in good shape

- Template expansion into compiled RPN and interaction bindings  
- `inferInteractionInversion` / wheel polarity from package params  
- `discreteGate` from `STEPS_NUMBER` + `DRAG_SPEED` (partial)  
- Compatibility bridge exact A:/L: → canonical controls/surfaces (partial)  
- Spoiler armed no longer driven by discrete O: gates (landed 2026-07-21/22)  
- `A:SPOILERS ARMED` published/read from canonical state (landed)

---

## Verification principles

- Generic tests in `runtimeEngineIntegration` / bridge tests; no fixture XML patches.  
- Live checks via `window.__DevApi.watch` on O: + A: + L: for oscillation.  
- Stock and complex packages both: if MSFS relies on Update RPN, we must not side-effect against it.  
- Aircraft-specific investigation OK; **landed fixes must stay generic**.

### DevApi smoke (speedbrake class)

```js
await __DevApi.ready()
// Retract idle: O: and ARMED must not flip
await __DevApi.watch(
  ['O:LEVER_SPEEDBRAKE:POSITION', 'A:SPOILERS ARMED', 'A:SPOILERS HANDLE POSITION'],
  { durationMs: 1000, intervalMs: 40 }
)
// Arm / deploy still work via contracts
__DevApi.keyEvent('SPOILERS_ARM_SET', [1])
__DevApi.setParam('spoilers', 50)
```

---

## Out of scope

- Aircraft-specific constants in runtime  
- Patching package fixtures under `aircrafts/` to hide engine bugs  
- Replacing physics / systems logic with template param tables  
- “Support only A339X” shortcuts

---

## Related notes

- `NOTES.md` — Spoiler / Speedbrake Lever (2026-07-21 bounce root cause)  
- Interaction IR: `src/msfs/behavior.ts` (`buildCompiledInteractionMetadata`, `inferInteractionInversion`)  
- Bridge: `src/msfs/compatibilityBridge.ts`  
- Loader checklist: `docs/investigations/loader-todo.md` (stock spoiler O:Position note — treat as historical; policy above supersedes re-encoding O: as armed)

---

## One-line summary

**MSFS parity = execute package-expanded behavior and exact contracts; stop name heuristics from rewriting control state.**
