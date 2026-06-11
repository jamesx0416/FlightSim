# Simulation Engine Architecture

This is the authoritative architecture and roadmap for the simulator-agnostic
engine direction.

## Summary

FlightSim is becoming a browser-based flight simulation engine with aircraft
compatibility adapters. MSFS built packages remain the first supported aircraft
source, but MSFS concepts are not the engine core.

The engine is TypeScript-first. WASM is not a default architecture choice; it is
only a future adapter boundary if native MSFS WASM gauges or performance-heavy
physics require it.

## Vocabulary

- **Engine**: simulator-owned state, commands, subsystems, scheduler, canonical
  aircraft definitions, diagnostics, and future physics.
- **Adapter**: loader/translator for a specific simulator or aircraft package
  format.
- **Compatibility layer**: simulator-specific API surface such as MSFS SimVars,
  LVars, RPN, key events, gauges, and legacy behavior contracts.
- **Canonical aircraft definition**: normalized aircraft data emitted by every
  adapter and consumed by the engine.

Use "canonical aircraft definition" for normalized aircraft data in user-facing
docs.

## Boundaries

The engine must expose domain APIs, not MSFS APIs:

- typed state
- unit conversion
- command dispatch
- subsystem ports
- scheduler phases
- canonical aircraft definitions
- diagnostics
- future physics state and integration

MSFS-specific APIs belong in `src/msfs/` and translate into canonical state and
commands. Future non-MSFS adapters must feed the same engine model.

## Current Repo Shape

- `src/sim/engine/`: central engine APIs and first subsystem proof slice.
- `src/msfs/`: MSFS importer, behavior compiler, compatibility runtime, and
  adapter bridges.
- `src/sim/`: existing simulation and physics primitives to integrate behind
  the engine scheduler.
- `src/entities/` and `src/input/`: current runtime consumers that should move
  toward engine state and commands.

## Canonical State

Canonical state is typed, unit-aware, and provenance-aware.

Source precedence is:

1. runtime writes and commands
2. loaded aircraft state
3. subsystem-computed state
4. declared defaults

Missing state remains missing unless a subsystem or aircraft definition declares
a default. Lighting helpers may interpret missing brightness as dark for output,
but the state store must not silently force missing values bright.

## Command Model

Engine commands are domain commands, for example:

- `lighting.setPotentiometer`
- `lighting.setPower`
- `electrical.setBusPowered`
- future controls, engines, avionics, and physics commands

Compatibility events such as MSFS key events map to domain commands in the
adapter layer.

## First Proof Slice: Lighting/Electrical

Lighting/electrical is the first subsystem because it has already exposed the
most important boundary problem: adapter fallback behavior must not become a
hidden engine default.

The proof slice models:

- light potentiometers
- panel/instrument brightness keys
- generic light channel enabled state
- light power channels
- electrical bus powered state
- MSFS lighting aliases mapped through the compatibility bridge

Current implementation entry points:

- `src/sim/engine/lightingElectrical.ts`
- `src/msfs/compatibilityBridge.ts`
- `src/msfs/runtime.ts` instantiates `SimulatorEngine` inside
  `SharedMsfsRuntimeHost` and routes mapped lighting SimVars through canonical
  engine state.
- Generic MSFS light switch channels such as beacon, nav, strobe, landing,
  taxi, logo, wing, cabin, glareshield, and recognition map to
  `lighting.channel.*.enabled`.
- `A:LIGHT PANEL` remains an existing panel-power fallback in the runtime host
  until panel power and panel lighting are split authoritatively; `A:LIGHT PANEL
  POWER SETTING` is still mapped as a light power setting.

## Migration Phases

### Phase 0: Documentation Alignment

Update `AGENTS.md`, `README.md`, this architecture doc, and historical planning
docs so future work follows the engine-first direction.

### Phase 1: Engine Foundation

Add canonical state, units, commands, subsystem interfaces, scheduler lifecycle,
canonical aircraft definitions, and tests.

### Phase 2: MSFS Adapter Bridge

Map MSFS-shaped reads/writes/events into canonical state and commands while
leaving current viewer behavior intact where practical.

### Phase 3: Lighting/Electrical Migration

Move lighting and electrical behavior behind engine state and domain commands.
MSFS SimVars, LVars, and key events should become compatibility aliases.

### Phase 4: Runtime Host Migration

Move generic runtime host state toward canonical engine state. Keep MSFS names in
compatibility code.

## Controls, Surfaces, And Animation

Animated control surfaces belong to the canonical engine model, not to the MSFS
loader. The engine owns domain state and commands for controls and moving
surfaces such as gear, flaps, spoilers, ailerons, elevators, rudders, and future
animation-driven surfaces.

MSFS SimVars, key events, animation variable names, and package-specific model
bindings are adapter/compatibility aliases over that canonical state. Future
non-MSFS aircraft adapters should emit the same control and surface definitions
and use the same engine commands.

### Phase 5: Physics Integration

Integrate existing TypeScript flight-model primitives behind the engine
scheduler and canonical controls/state.

### Phase 6: Additional Adapters

Add future simulator or aircraft-package adapters only after the canonical model
supports MSFS without leaking MSFS concepts into engine core.

## Testing Rules

- Typecheck must pass for each migration step.
- Unit tests should cover state precedence, unit conversion, command dispatch,
  subsystem behavior, and adapter aliasing.
- Lighting/electrical tests must verify missing values stay dark unless an
  aircraft definition or subsystem declares otherwise.
- Fixture aircraft under `aircrafts/` may be used for verification, but fixture
  data must not be patched to fix engine behavior unless explicitly requested.
- Known temporary viewer/runtime breakage during refactors must be documented in
  `NOTES.md` or the active investigation doc.

## Current Acceptance Baseline

The first landed baseline is complete when:

- `src/sim/engine/` exposes the initial engine API surface.
- `src/msfs/compatibilityBridge.ts` maps lighting SimVar aliases to canonical
  state.
- `SharedMsfsRuntimeHost` owns a `SimulatorEngine`, ticks it from the runtime
  loop, and mirrors mapped lighting reads/writes/seeds through the MSFS
  compatibility bridge.
- Generic light channels and indexed light power settings are mirrored through
  canonical engine state while existing loader/runtime side effects remain in
  place for compatibility.
- Bun tests cover state precedence, units, command dispatch, missing-lighting
  semantics, and adapter aliasing.
- `bun run typecheck` and `bun test` pass.
