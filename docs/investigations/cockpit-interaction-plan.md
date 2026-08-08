# Authoritative Cockpit Interaction, DevApi, and Future Device Input Plan

## Summary

Replace the current partial cockpit mouse dispatcher with a metadata-driven interaction system that reproduces the original MSFS 2020 PC Legacy workflow by default and fully supports MSFS Lock mode.

Milestone one delivers:

- Correct Primary, Secondary, and Tertiary interaction
- Complete mounted-stock MouseRect behavior
- Fully remappable mouse controls
- Legacy and Lock modes
- MSFS-style highlights, localized tooltips, and current values
- A redesigned `window.__DevApi.interactions` namespace
- Structured interaction metadata and diagnostics
- Persistent compact action history
- Opt-in detailed tracing
- Versioned input profiles
- Full focused tests and real A330 fixture verification

Keyboard, gamepad, touch, replay, flight-sim hardware, and VR are explicitly planned as future milestones.

No aircraft-specific rules, mesh-name heuristics, raw user-authored RPN, or fixture-data patches are permitted.

## Plan Artifact

When execution is allowed, save this plan verbatim to:

`docs/investigations/cockpit-interaction-plan.md`

Plan Mode currently prohibits writing the file, so no repository mutation is performed while finalizing this specification.

## Goals and Success Criteria

The implementation is complete only when:

- Left, right, and middle mouse actions reach distinct package-authored Primary, Secondary, and Tertiary handlers.
- Legacy mode behaves like original MSFS 2020 PC interaction.
- Lock mode reproduces MSFS’s hybrid simple/complex-control behavior.
- Wheel, dragging, release, repeat, lock, hover, and compound-control metadata are honored.
- Mouse input never falls through a real interaction target to the camera.
- VCockpit displays, covers, blockers, depth, and package-authored priority are respected.
- DevApi exposes capability-checked named operations.
- Absolute and relative value operations are exact and verified.
- Unsupported metadata fails closed with source-level diagnostics.
- No runtime behavior is inferred from aircraft identity, mesh names, or RPN source-string searches.
- The full mounted stock interaction matrix and the real local A330 fixture pass without modifying fixture package data.

## Milestone-One Scope

### Included

- Mouse input
- Fixed Escape cancel/unlock key
- Settings UI
- Named DevApi interaction operations
- Canonical action dispatcher
- MSFS interaction adapter
- Structured MouseRect and InputEvent metadata
- Legacy and Lock modes
- Profiles and persistence
- Compact history and detailed tracing
- Package localization
- Current MSFS 2020-era stock templates used by local fixtures
- Complete documented interaction flags supported by that pipeline

### Excluded

- General keyboard bindings
- Gamepad
- Touch/mobile gestures
- VR controllers
- WebHID and specialized flight-sim hardware
- Hardware LEDs, displays, and motorized outputs
- Persistent detailed recording and replay
- Per-control sensitivity overrides
- Import/export file-picker UI
- Complete MSFS 2024 interaction implementation

The architecture must reserve clean extension points for every excluded capability.

## Existing Authoritative Assets

Continue loading the existing stock definitions:

- `vendor/msfs-stock/ModelBehaviorDefs/Asobo/`
- `public/vendor/msfs-stock/ModelBehaviorDefs/Asobo/`
- `vendor/msfs-template-explorer-html/`

Do not add handwritten replacement XML for stock behavior.

Template resolution order:

1. Active aircraft package
2. Declared dependency and additional package roots
3. Matching mounted stock-template set
4. Explicit unsupported-template diagnostic

Each compiled interaction records template source path and stock-template provenance. Unsupported MSFS 2024-only syntax or behavior is diagnosed, not approximated through 2020 behavior.

## Architectural Boundaries

### Simulator-agnostic input layer

Add `src/input/cockpitInteraction.ts`.

This module owns:

- Canonical input actions
- Interaction state machine
- Device/pointer capture
- Busy-target ownership
- Camera-versus-control arbitration
- Cancellation
- Gesture aggregation
- Profile-resolved physical bindings
- Scheduler-driven lifecycle
- Device-independent values

It must not contain:

- `LeftSingle`, `WheelUp`, or other MSFS event names
- SimVars, LVars, BVars, or RPN
- Aircraft node-name assumptions
- Aircraft-specific mappings

### MSFS adapter

Add `src/msfs/interactionAdapter.ts`.

This module owns:

- Canonical-action-to-MSFS-event translation
- MouseRect event tokens
- InputEvent invocation
- `M:Event`, `M:InputType`, relative axes, and drag percentage
- Legacy versus Lock interaction routes
- Package-authored timing, axes, inversion, limits, and capabilities
- Tooltip, highlight, animation, sound, and feedback metadata
- MSFS-specific target provenance

### Engine boundary

Canonical engine commands remain the preferred route for simulator-domain actions such as:

- Flaps
- Landing gear
- Brakes
- Radio tuning
- Barometer
- Future flight-control hardware

Primary/Secondary/Tertiary and MouseRect events remain outside `src/sim/engine/`.

## Canonical Interaction Model

Add canonical types:

```ts
type CockpitInteractionChannel =
  | 'primary'
  | 'secondary'
  | 'tertiary'

type CockpitInteractionPhase =
  | 'press'
  | 'double'
  | 'hold'
  | 'drag'
  | 'repeat'
  | 'release'
  | 'cancel'

type CockpitInteractionMode =
  | 'legacy'
  | 'lock'

type CockpitRelativeDirection =
  | 'increase'
  | 'decrease'
  | 'left'
  | 'right'
  | 'up'
  | 'down'

type CockpitInteractionSource =
  | 'mouse'
  | 'keyboard'
  | 'gamepad'
  | 'touch'
  | 'vr'
  | 'hid'
  | 'devapi'

interface CockpitInteractionInput {
  readonly source: CockpitInteractionSource
  readonly channel?: CockpitInteractionChannel
  readonly phase: CockpitInteractionPhase
  readonly pointerId?: number
  readonly axis?: 'x' | 'y' | 'z'
  readonly axisValue?: number
  readonly delta?: number
  readonly dragPercent?: number
  readonly timestampMs: number
}
```

Model hover, leave, lock, unlock, increase, and decrease as typed canonical events rather than fake button phases.

## Structured Compiled Interaction Metadata

Extend `CompiledInteractionBinding` in `src/msfs/types.ts`.

Replace the current narrow `kind: 'leftSingle' | 'callback'` model with a structured source and capability model.

```ts
type CompiledInteractionSourceKind =
  | 'callbackCode'
  | 'callbackDragging'
  | 'callbackJumpDragging'
  | 'eventId'
  | 'inputEvent'

interface CompiledInteractionRoute {
  readonly channel: CockpitInteractionChannel | null
  readonly phase: CockpitInteractionPhase | null
  readonly operation:
    | 'press'
    | 'hold'
    | 'release'
    | 'turn'
    | 'increase'
    | 'decrease'
    | 'adjust'
    | 'set'
    | 'on'
    | 'off'
    | 'toggle'
    | 'hover'
    | 'leave'
    | 'lock'
    | 'unlock'
  readonly msfsEvent: string | null
  readonly axis: 'x' | 'y' | 'z' | null
  readonly inputTypes: readonly number[]
}

interface CompiledInteractionMetadata {
  readonly authoredId: string | null
  readonly qualifiedId: string
  readonly nodeId: string | null
  readonly componentId: string | null
  readonly inputEventIds: readonly string[]
  readonly routes: readonly CompiledInteractionRoute[]
  readonly sourceKind: CompiledInteractionSourceKind
  readonly sourcePath: string
  readonly sourceTemplate: string | null
  readonly templateRevision: string | null
  readonly lockable: boolean
  readonly dynamicEventHandling: boolean
  readonly disabled: boolean
  readonly disabledInVr: boolean
  readonly prioritizeVCockpits: boolean
  readonly ignoreZTest: boolean
  readonly highlightNodeId: string | null
  readonly axis: 'x' | 'y' | 'z' | null
  readonly inverted: boolean
  readonly cursor: string | null
  readonly tooltipTitle: string | null
  readonly tooltipDescription: string | null
  readonly tooltipValueExpression: CompiledExpression | null
}
```

Retain compiled expressions for execution. Runtime capability checks use structured routes, never `expression.source.includes(...)`.

### Metadata extraction

Compile structured routes from:

- `MouseFlags`
- `IMMouseFlagsInstances`
- Primary/Secondary/Tertiary press, drag, repeat, and release
- Left/Right/Middle single, double, drag, and release
- Wheel up/down
- Move, leave, enter, and exit
- Lock and unlock
- DownRepeat and MoveRepeat
- Callback code
- Callback dragging
- Callback jump dragging
- Event IDs
- InputEvent Inc/Dec/Set
- Typed InputEvent parameters
- Drag axis, scale, inversion, limits, and mode
- Lock flags
- Tooltip entries
- Cursors
- Highlight targets
- Covers and blockers
- `PrioritizeVCockpits`
- `IgnoreZTest`
- Merged interactions
- Finite/infinite controls
- Momentary, timed, held, toggle, and multistate controls

For custom RPN dynamically examining `M:Event`:

- Preserve all statically discoverable routes.
- Mark `dynamicEventHandling: true`.
- Allow known declared MouseFlags through the callback.
- Emit a diagnostic when the complete event set cannot be proven.

## Target Identity and Lookup

### Public target format

Use authored ID by default:

```ts
__DevApi.interactions.press('PUSH_OVHD_ELEC_BAT1')
```

Resolution rules:

1. Search only the active aircraft and active dependency graph.
2. Prefer exact case-sensitive authored ID.
3. If exactly one match exists, use it.
4. If no match exists, fail with `TARGET_NOT_FOUND`.
5. If multiple matches exist, fail with `TARGET_AMBIGUOUS`.
6. Return source-qualified candidates.
7. Require `sourcePath#authoredId` for an ambiguous target.
8. Never select a “best” duplicate automatically.

If a control has no usable authored ID:

- Keep it pointer-interactive through its compiled binding.
- Give it a deterministic source-qualified ID for inspection and automation.
- Do not invent an ID from aircraft identity or a guessed mesh role.

Internally, traces record:

- Package ID
- Package version
- Source path
- Authored ID
- Qualified ID
- Node/component IDs
- Declaration occurrence

glTF node names are descriptive metadata, not public identity.

## Mouse Defaults and Arbitration

### Default profile

- Left button: Primary
- Right button: Secondary
- Middle button: Tertiary
- Wheel up: Increase over an interaction
- Wheel down: Decrease over an interaction
- Any mouse-button drag on empty cockpit space: camera pan/freelook
- Wheel on empty cockpit space: camera zoom
- Escape: fixed cancel/unlock

### Target capture

- Hit testing occurs on pointer down.
- The selected binding remains captured for the gesture.
- Pointer movement does not retarget the active gesture.
- A real interaction target consumes the action even when unavailable or unsupported.
- Unsupported interaction never falls through to camera movement.
- Camera movement begins when pointer down is not claimed by an eligible interaction. Passive gauge surfaces can still occlude controls behind them without claiming camera gestures; future touchscreen support should consume only pointer gestures proven to belong to the gauge.
- Lost pointer capture, browser blur, cockpit exit, aircraft replacement, LOD replacement, profile replacement, and explicit cancellation release all capture state.

### Wheel arbitration

- If an eligible target is under the pointer and exposes Increase/Decrease or compatible wheel behavior, dispatch to the target.
- Otherwise zoom the camera.
- Wheel events within a 120 ms inactivity window form one summary gesture.
- Detailed tracing may preserve individual wheel samples.

### Double-click

Support documented single and double MouseRect flags.

Use native browser/Windows sequencing:

- First single
- Second single
- Matching double action

Do not delay normal single-click actions waiting for a possible double-click.

## Legacy Mode

Fresh installations default to Legacy intentionally, matching original MSFS 2020 PC mouse interaction rather than the post-SU5 modern default.

Legacy behavior:

- Hover directly selects the target.
- Primary/Secondary/Tertiary dispatch directly to that target.
- Authored split hit regions remain distinct.
- Wheel operates the hovered target when supported.
- Drag uses authored axes and scale.
- Release matches the initiating interaction channel.
- Legacy uses authored cursors and tooltips.
- Do not force Lock-style blue highlighting in Legacy.

## Lock Mode

Match MSFS’s hybrid Lock behavior:

- Simple buttons and two-position switches activate with a tap.
- Complex knobs and levers enter Lock while Primary is held.
- Primary movement manipulates the locked target.
- Secondary and Tertiary operate on the locked target.
- Wheel Increase/Decrease operates the locked target.
- Releasing Primary emits release/unlock.
- Escape, pointer cancellation, cockpit exit, or target loss unlocks.
- Package-authored lock flags remain authoritative.

Lock presentation:

- MSFS-style highlighted target
- Authored cursor
- Localized title
- Current value
- Available actions
- Separate highlight and tooltip visibility settings

## Hit Testing and Gauge Priority

Interaction priority follows MSFS metadata:

1. Honor `PrioritizeVCockpits`.
2. Otherwise choose the nearest visible eligible target.
3. Respect depth testing.
4. Respect `IgnoreZTest`.
5. Respect covers and blockers.
6. Respect disabled and unavailable state.
7. Never click an interaction target through a VCockpit surface that geometrically occludes it.
8. Passive VCockpit surfaces do not own pointer input by default; unhandled gestures may continue to camera controls.
9. Never apply a global “gauges always win” rule. Future touchscreen/input ownership must be proven from gauge metadata/runtime support.

Compound controls remain separate when authored separately:

- Inner/outer knobs
- Rotary plus push
- Push/pull
- Split click regions
- Multi-axis controls
- Covers and guarded switches
- Captain/copilot controls
- Indexed radios and altimeters
- Repeated engines and systems

## Interaction State Machine

Implement:

```text
idle
  → hovered
  → pressed
  → captured
  → dragging / held / repeating
  → released
  → hovered or idle

hovered
  → locked
  → pressed / dragging / wheel / secondary / tertiary
  → unlocked

any active state
  → cancelled
  → idle
```

Rules:

- One active operation per resolved target.
- Different targets may be held concurrently through DevApi/future hardware.
- A conflicting operation on a busy target returns `TARGET_BUSY`.
- Mouse pointer ownership remains one gesture at a time.
- Holds are identified and released by target, not opaque public IDs.
- Release ends holds.
- Cancel stops convergence and captured interaction work.
- Long press, repeat, minimum-held duration, delayed release, and spring return use the simulator scheduler.
- Milestone one applies package-authored sensitivity and timing exactly.

## Redesigned DevApi

Remove the old interaction methods:

- `click`
- Old `turn`
- Old `drag`
- Old `release`
- Raw pointer-based interaction helpers
- Old wheel interaction helper

Do not provide aliases or a compatibility mode.

Add:

```ts
window.__DevApi.interactions
```

### Return envelope

Every read, action, success, and failure returns:

```ts
interface DevApiInteractionResult<T> {
  readonly ok: boolean
  readonly code: string
  readonly message: string
  readonly data: T
  readonly suggestions: readonly string[]
}
```

Use `ok`, matching the project’s existing DevApi convention.

Expected failure codes include:

- `TARGET_NOT_FOUND`
- `TARGET_AMBIGUOUS`
- `TARGET_BUSY`
- `OPERATION_UNSUPPORTED`
- `INTERACTION_UNAVAILABLE`
- `VALUE_NOT_REACHABLE`
- `VALUE_REACHABILITY_UNKNOWN`
- `UNIT_INCOMPATIBLE`
- `NO_PROGRESS`
- `VALUE_CYCLE`
- `CANCELLED`
- `TARGET_LOST`
- `INTERNAL_ERROR`

Unexpected exceptions are caught at the DevApi boundary and returned as `INTERNAL_ERROR`. Preserve the original stack in detailed diagnostics and console output.

### Sync/async contract

Immediate read methods return envelopes synchronously. They may still be used with `await`.

Actions start immediately and return Promises. Callers may:

- `await`
- use `.then(...)`
- ignore the Promise for fire-and-forget

Fire-and-forget status is visible through `active()` and history.

### Read methods

```ts
interactions.list(options?)
interactions.describe(target)
interactions.active()
interactions.history(options?)
interactions.trace.snapshot(options?)
interactions.profiles.list()
interactions.profiles.get(profileId)
interactions.profiles.effective(profileId?, aircraftId?)
interactions.settings.get()
```

`list()` is compact and contains:

- Authored/qualified ID
- Control kind
- Supported named operations
- Supported P/S/T channels
- Current availability
- Current formatted value
- Ambiguity state

`describe()` contains:

- Full provenance
- Package/version
- Source path/template
- Raw MSFS events
- InputEvent IDs and typed parameters
- Compiled expressions
- Axes, limits, inversion, timing
- Tooltip and localization data
- Highlight/cursor data
- Current state/value
- Covers/blockers
- Diagnostics

### Action methods

```ts
interactions.press(target, options?)
interactions.hold(target, options?)
interactions.release(target, options?)
interactions.turn(target, options)
interactions.increase(target, options?)
interactions.decrease(target, options?)
interactions.adjust(target, options)
interactions.set(target, options)
interactions.on(target, options?)
interactions.off(target, options?)
interactions.toggle(target, options?)
interactions.cancel(target)
interactions.cancelAll()
interactions.dispatch(target, canonicalAction)
```

No public `click` method.

### Common interaction selector

Applicable named methods accept:

```ts
interface InteractionSelector {
  readonly interaction?:
    | 'primary'
    | 'secondary'
    | 'tertiary'
  readonly variant?: string
}
```

Rules:

- Omitted selector uses a unique semantic default.
- Ambiguous defaults reject and list valid variants.
- Explicit P/S/T is capability-checked.
- Named variants may include authored Push/Pull behavior.
- Unsupported channels reject without fallback.

### Press/hold/release

- `press` performs an atomic authored press-release lifecycle.
- `hold` resolves once the target is held.
- `release(target)` releases the active hold on that target.
- Different targets may be held concurrently.
- A second incompatible hold on the same target returns `TARGET_BUSY`.

### Relative operations

```ts
turn(target, {
  direction:
    | 'increase'
    | 'decrease'
    | 'left'
    | 'right'
    | 'up'
    | 'down'
  steps?: number
  interaction?: CockpitInteractionChannel
})

increase(target, {
  steps?: number
  interaction?: CockpitInteractionChannel
})

decrease(target, {
  steps?: number
  interaction?: CockpitInteractionChannel
})
```

Rules:

- `steps` is a positive integer.
- Default is 1.
- One step means one authored detent/event, not numeric `+1`.
- Physical directions resolve through authored axis and inversion metadata.
- Unit conversion does not occur in step-based operations.
- Dynamic increments and acceleration remain authored behavior.

### Exact relative value adjustment

```ts
adjust(target, {
  delta: number
  unit?: string
  interaction?: CockpitInteractionChannel
})
```

Rules:

- Delta must be exactly representable through authoritative metadata.
- Reject before execution when exact reachability cannot be proven.
- Do not expose tolerance.
- Do not expose rounding.
- Verify the exact final delta.

### Exact absolute set

```ts
set(target, {
  value: number | boolean | string
  unit?: string
  interaction?: CockpitInteractionChannel
})
```

Execution order:

1. Use direct authored Set when available.
2. Otherwise use authored Increase/Decrease only when current state, units, transitions, bounds, and reachability are authoritative.
3. Preflight the complete route before mutating state.
4. Reject if exact reachability cannot be proven.
5. Execute through the scheduler.
6. Verify the exact final value.
7. Return requested, previous, actual, unit, and execution path.

No public tolerance or rounding exists.

For cyclic controls with known authoritative bounds:

- Use the shortest valid path.
- Break exact ties toward Increase.
- Report the chosen route.

### Convergence safety

There is no step-count or wall-time limit.

Convergence stops on:

- Exact success
- `cancel(target)`
- `cancelAll()`
- Aircraft/cockpit/LOD replacement
- Target loss
- No progress
- Detected value cycle

Each step yields through the simulator scheduler.

No-progress detection:

- Execute one authored step.
- Wait for the relevant watched value/state notification and authored animation/min-held timing.
- If no watched value changes after the binding’s authored settle window and two simulator ticks, return `NO_PROGRESS`.

Cycle detection tracks settled observed states and direction. Re-entering an already visited state without reaching the target returns `VALUE_CYCLE`.

### State helpers

- `toggle` requires an authored toggle route.
- `on` and `off` use explicit authored ON/OFF when available.
- If only Toggle exists, `on`/`off` may:
  - Read authoritative current state.
  - No-op if already correct.
  - Toggle once if incorrect.
  - Verify the resulting state.
- If state cannot be read or verified, reject.

## Settings and Profiles

### Global defaults

Store viewer-wide defaults for:

- Interaction mode
- Highlight visibility
- Tooltip visibility
- Selected global input profile

Defaults:

- Interaction mode: Legacy
- Highlights: enabled where applicable
- Tooltips: enabled
- Selected profile: MSFS Mouse

### Profile overrides

Profiles may sparsely override:

- Interaction mode
- Highlight visibility
- Tooltip visibility
- Physical bindings
- Future sensitivity multipliers
- Future hardware synchronization policies

Unset values inherit global defaults.

### Multiple profiles

Support multiple named profiles, for example:

- MSFS Mouse
- Testing
- Keyboard/Gamepad
- Airbus Hardware
- Boeing Hardware
- Touch
- VR

Allow:

- One globally selected profile
- Optional per-aircraft selected profile
- Sparse inheritance
- Duplicate/rename/delete
- Reset to MSFS-style defaults

### Persistence

Use a separate versioned store, not URL query parameters:

```ts
interface CockpitInputStoreV1 {
  readonly version: 1
  readonly selectedGlobalProfileId: string
  readonly aircraftProfileSelections: Readonly<Record<string, string>>
  readonly globalSettings: {
    readonly interactionMode: CockpitInteractionMode
    readonly showHighlights: boolean
    readonly showTooltips: boolean
  }
  readonly profiles: readonly CockpitInputProfile[]
}
```

`ViewerConfigProfile` stores only optional references/overrides needed by the existing viewer profile system.

Settings behavior:

- Edit a draft.
- Capture and validate inputs.
- Block same-context conflicts.
- Allow intentional context-exclusive sharing.
- Apply/Save atomically.
- Cancel discards the draft.
- Reset restores defaults.

### Conflict rules

Allow:

- Wheel controlling a target and camera zoom in mutually exclusive contexts.
- Any mouse-button camera drag on empty space and P/S/T on a target.

Block:

- Two cockpit actions claiming the same physical input in the same context.
- Two camera actions claiming the same gesture in the same context.
- Duplicate active profile IDs.
- Package target bindings with unresolved ambiguity.

### Portability

Milestone one includes:

- Versioned serializable schema
- DevApi profile import/export
- Migration validation

Defer file-picker UI to a later milestone.

Corrupt profile storage:

- Preserve the invalid payload under a timestamped recovery key.
- Load defaults.
- Emit a diagnostic.
- Do not silently delete user data.

## Interaction Feedback and Localization

Resolve package localization for the active viewer locale.

Display:

- Authored control title
- Authored current value
- Available actions
- Authored cursor
- Authored lock highlight
- Concise unavailable indication

Fallback behavior:

- Use English for generic viewer messages.
- Never expose full parser/RPN errors in normal cockpit tooltips.
- Full details remain in `describe()`, diagnostics, and detailed traces.

## History and Tracing

### Basic history

Persist the latest 300 logical actions in local storage as versioned JSON objects.

Include:

- Cockpit interactions
- Camera pan/move
- Camera zoom/scroll
- Settings/profile transitions
- Aircraft changes
- Cockpit entry/exit
- Application version transitions
- Cancellation
- Unsupported/unavailable attempts

One line per logical action in formatted output:

```text
#184 12:41:03.212 mouse primary BARO_KNOB -> LeftSingle executed
#185 12:41:04.018 mouse wheel BARO_KNOB increase steps=1 executed
#186 12:41:07.441 mouse drag camera.pan dx=142 dy=-38 ms=620 completed
#187 12:41:09.105 mouse wheel camera.zoom delta=-240 completed
```

Internally retain structured objects.

Aggregation:

- Click: one entry
- Cockpit drag: one entry on release/cancel
- Camera pan: one entry on release/cancel
- Wheel burst: one accumulated entry
- Convergence Set/Adjust: one summary entry
- Internal detents appear only in detailed trace

### Detailed tracing

Opt-in only.

Store in bounded memory:

- Up to 10,000 low-level records
- Maximum approximately 16 MB
- Drop oldest records when capped and emit a trace-overflow marker

Include:

- Every canonical event
- Every mapped MSFS event
- Intermediate movement samples
- InputEvent/RPN route
- Variable reads/writes
- Key and HTML events
- Sound/animation/feedback
- Hit-test and blocker details
- Cancellation and scheduler timing
- Exact source/template provenance

Provide explicit export through DevApi.

Do not continuously persist detailed traces in milestone one.

## Direct Cutover

Do not maintain old/new dispatcher selection.

Implementation sequence still protects correctness:

1. Build structured metadata and tests.
2. Build canonical dispatcher and adapter.
3. Build new DevApi and tests.
4. Build Settings and persistence.
5. Route mouse input to the new dispatcher.
6. Remove old dispatcher and old interaction DevApi in the same change.
7. Update all documentation and tests.
8. Verify the complete acceptance matrix before handoff.

There is no permanent legacy code path or query flag.

## File-Level Implementation Plan

### New files

- `src/input/cockpitInteraction.ts`
- `src/input/cockpitInputProfiles.ts`
- `src/input/cockpitInteractionHistory.ts`
- `src/msfs/interactionAdapter.ts`
- `src/msfs/interactionAdapter.test.ts`
- `src/input/cockpitInteraction.test.ts`
- `src/input/cockpitInputProfiles.test.ts`
- `docs/investigations/cockpit-interaction-plan.md`

### Modified files

- `src/msfs/types.ts`
  - Structured interaction metadata and route types
- `src/msfs/behavior.ts`
  - Compile all MouseRect/InputEvent capabilities and provenance
- `src/msfs/behavior.test.ts`
  - Full mounted-stock interaction matrix
- `src/msfs/runtime.ts`
  - Capability-driven execution, exact convergence, cancellation, busy state
- `src/msfs/runtime.test.ts`
  - Lifecycle, exact Set/Adjust, cycle/no-progress tests
- `src/main.ts`
  - New mouse dispatcher, hit testing, camera arbitration, Settings UI
- `src/devApi.ts`
  - Remove old methods and add `interactions` namespace
- `docs/devapi-reference.md`
  - Complete new API and examples
- `docs/investigations/loader-todo.md`
  - Track milestone execution and acceptance
- Existing Settings/profile tests
- Existing browser integration tests

## Test Matrix

### Compiler tests

Cover:

- Primary/Secondary/Tertiary press, drag, repeat, and release
- Left/Right/Middle single, double, drag, and release
- Wheel up/down
- Move/leave
- Enter/exit
- Lock/unlock
- DownRepeat/MoveRepeat
- CallbackCode
- CallbackDragging
- CallbackJumpDragging
- EventID
- InputEvent Inc/Dec/Set
- Multiple typed parameters
- Dynamic `M:Event`
- Legacy and Lock metadata variants
- Tooltip/cursor/highlight metadata
- `PrioritizeVCockpits`
- `IgnoreZTest`
- Disabled/DisabledInVr
- Finite/infinite controls
- Merged controls
- Covers/blockers
- Momentary/timed/held/toggle/multistate
- Package/dependency/stock precedence
- Unsupported 2024-only diagnostics

### State-machine tests

Cover:

- Hover, leave, press, capture, drag, release
- All three channels
- Simple Lock tap
- Complex Lock hold/unlock
- Wheel while hovered/locked
- Empty-space camera movement
- Any-button empty-space drag
- No camera fallthrough through unavailable controls
- Lost pointer capture
- Browser blur
- Escape
- Cockpit exit
- Aircraft/LOD replacement
- Target disappearance
- Busy-target rejection
- Concurrent holds on different targets
- Scheduler repeat and long press
- Spring return
- Native double-click sequencing

### Named API tests

Cover:

- Authored-ID lookup
- Qualified duplicate resolution
- Compact list/full describe
- Atomic press
- Hold/release by target
- Explicit P/S/T
- Semantic variant ambiguity
- Turn/increase/decrease steps
- Physical-direction mapping
- Exact Adjust
- Exact Set
- Units
- Direct Set
- Convergence Set
- Unreachable value rejection
- Unknown reachability rejection
- No-progress detection
- Cycle detection
- Cancellation
- State helper derivation
- Structured result envelopes
- Sync reads and async actions
- Fire-and-forget active status

### Settings tests

Cover:

- Default mappings
- Fully remappable actions
- Context-aware conflict blocking
- Global defaults
- Sparse profile overrides
- Global and per-aircraft profile selection
- Apply/Save
- Cancel draft
- Reset
- Corrupt-store recovery
- Version migration
- DevApi import/export

### History and tracing tests

Cover:

- 300-entry ring behavior
- Local-storage persistence
- Transition markers
- One-line formatting
- Gesture coalescing
- Camera actions
- Detailed trace enable/disable
- Bounded-memory overflow
- Explicit export
- No per-detent summary spam

### Real fixture verification

Use the local `headwindsim-aircraft-a330-900` package.

Verify through `window.__DevApi` and direct mouse input:

- Button
- Momentary button
- Toggle
- Multistate switch
- Finite knob
- Infinite knob
- Pushable/pullable knob
- Inner/outer knob
- Covered switch
- Radio whole/fractional tuning and swap
- Altimeter setting
- STD mode
- Flap handle versus physical flap position
- Captain/copilot or indexed controls where available
- Gauge interaction priority
- Localized tooltip/value
- Lock and Legacy behavior
- Zero aircraft-specific source rules
- Zero fixture edits

## Verification Commands

Use:

- Focused Bun tests for changed modules
- Typecheck
- Lint
- Browser verification through `window.__DevApi`
- Existing dev server
- No routine full production build unless a specific bundling risk requires it

## Future Milestone 2: Keyboard and Gamepad

Add:

- Keyboard adapter
- Gamepad adapter
- Binding capture
- Chords/modifiers
- Held/repeat controls
- Gamepad cursor
- P/S/T and increase/decrease bindings
- Per-control/per-axis sensitivity multipliers in profiles
- Controller-specific Lock interaction
- Profile conflict checks across devices

Use the same canonical dispatcher and named operation API.

## Future Milestone 3: Touch and Mobile

Add:

- Tap Primary
- Drag authored axes
- Pinch camera zoom
- Multi-touch camera pan
- Explicit Secondary/Tertiary action palette
- Adjustable hit-target assistance without changing underlying interaction identity
- Android/mobile viewport testing
- Touch cancellation and gesture arbitration
- Accessibility sizing and high-contrast feedback

Do not synthesize browser long-press as Secondary unless explicitly configured.

## Future Milestone 4: Full Recording and Replay

Add persistent versioned recordings containing:

- Normalized pointer coordinates
- Relative movement paths
- Timing
- Camera pose
- Canonical actions
- Authored IDs
- Source qualification where needed
- Package ID/version
- Capabilities used
- Result checkpoints

Replay policy:

- Same-version replay proceeds after preflight.
- Different package versions warn.
- Authored-ID remapping is allowed.
- Complete preflight validates every target and capability.
- Missing, ambiguous, or changed capabilities reject the entire replay before execution.
- Explicit migration maps may resolve incompatibilities.
- No partial or skip-invalid replay by default.

## Future Milestone 5: Flight-Sim Hardware and VR

### Hardware input

Implement layered bindings:

1. Canonical engine command
2. Focused P/S/T
3. Authored target plus named operation

Never store raw RPN in user profiles.

Support:

- Buttons
- Encoders
- Maintained switches
- Detents
- Axes
- Device identity
- Hot-plug
- Permission loss
- Calibration
- Dead zones
- Debounce
- Repeat rates
- Device reconnect
- Package-specific target diagnostics

### Maintained switches

Binding modes:

- Momentary
- Toggle
- Absolute
- Relative
- Axis
- Pickup

Defaults:

- Absolute maintained switch: hardware wins on connect/aircraft load
- Toggle/momentary: no startup synchronization
- Per binding/profile override: pickup or simulator wins
- Startup synchronization requires authoritative readable and writable absolute state
- Never synchronize through Toggle

### Hardware output

Provide bidirectional subscriptions for:

- LEDs
- Annunciators
- Displays
- Motorized axes
- Switch-state indicators

Simulator state remains authoritative for outputs.

### VR

Support:

- Controller rays
- Grab/capture
- P/S/T
- Increase/decrease
- Push/pull
- Axis movement
- Haptics
- VR-disabled MouseRects
- Gauge/touchscreen interaction
- Cancellation and controller loss

## Final Assumptions and Defaults

- Fresh interaction mode: Legacy
- Lock fully supported
- Mouse map: Left Primary, Right Secondary, Middle Tertiary
- Any-button empty-space drag moves the camera
- Wheel is contextual
- Escape always cancels/unlocks
- Real targets never fall through to camera
- Package metadata is authoritative
- Unsupported behavior fails closed
- Current fixture generation is guaranteed first
- No generic stock XML replacements
- No aircraft-specific behavior
- Authored ID is the default public target
- Duplicate authored IDs require qualification
- Named API lives under `__DevApi.interactions`
- Old interaction APIs are removed
- `press` is atomic
- P/S/T selection is available on applicable named operations
- Relative operations use authored integer steps
- `adjust` and `set` require exact representability
- No tolerance
- No rounding
- No overall convergence step/time limit
- Busy targets reject conflicting work
- Holds release by target
- All API responses use the `ok` envelope
- Reads are immediate; actions return immediately-started Promises
- Multiple named profiles use sparse inheritance
- Global settings allow per-profile overrides
- Basic history persists 300 logical actions as versioned JSON
- Detailed traces remain in memory with explicit export
- Full replay is future work
- Hardware/VR are future work
- Aircraft fixture data remains unchanged
