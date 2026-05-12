# FlightSim

Browser-based MSFS 2020 built-package viewer and compatibility runtime prototype.

The current app imports a built package served from the repo `tmp` folder, parses generic SimObjects aircraft config/model references, compiles a supported subset of MSFS model behavior XML, loads the exterior GLTF, and drives generic animation plus node visibility in the browser.

This slice is intentionally generic:
- no aircraft-specific overrides or code paths
- no panel hosting
- no WASM runtime
- no sound runtime

## Current Scope

- Package import from a dev-served `tmp` package root
- `layout.json` and `manifest.json` discovery
- `aircraft.cfg` parsing, including `base_container` inheritance
- `model.cfg` and exterior model XML resolution
- Behavior include loading from package-local `ModelBehaviorDefs`
- Optional additional package-root mounting for stock/shared behavior and texture lookup
- Generic compilation of supported `ASOBO_GT_Anim*` and `ASOBO_GT_Visibility*` template outputs
- Deterministic demo host variables for behavior-driven animation and visibility
- Diagnostics overlay for missing includes, unsupported templates, and unsupported RPN tokens

## Deferred

- `panel.cfg` / `panel.xml`
- JS instrument hosting
- WASM
- sound
- MSFS 2024 content
- offline precompilation

## Setup

1. Install dependencies:

```bash
bun install
```

2. Start the dev server:

```bash
bun dev
```

3. Build for production:

```bash
bun run build
```

## Package Root

By default the viewer imports:

```text
/tmp/headwindsim-aircraft-a330-900/
```

Override that with:

```dotenv
VITE_MSFS_PACKAGE_ROOT=/tmp/your-built-package/
```

The package must be a built MSFS 2020 package inside the repo so Vite can serve it.

Optional additional built-package roots can also be mounted for stock/shared assets:

```dotenv
VITE_MSFS_ADDITIONAL_PACKAGE_ROOTS=/tmp/fs-base-aircraft-common/,/tmp/asobo-vcockpits-instruments-airliners/
```

Those extra roots are searched generically for:
- simulator-provided `ModelBehaviorDefs/...` includes such as `Asobo/Exterior.xml`
- shared texture fallback paths discovered through `texture.cfg`

The same additional roots can also be provided at runtime through the URL:

```text
?deps=/tmp/fs-base-aircraft-common/&deps=/tmp/asobo-vcockpits-instruments-airliners/
```

or as a single delimited query value:

```text
?packages=/tmp/fs-base-aircraft-common/;/tmp/asobo-vcockpits-instruments-airliners/
```

The main package root can also be selected from the URL:

```text
?package=/tmp/flybywire-aircraft-a320-neo/&aircraft=SimObjects/AirPlanes/FlyByWire_A320_NEO%23fltsim.0
```

See `docs/query-parameters.md` for the full list of supported query parameters, including cockpit diagnostics and opt-in runtime experiments. Any new URL query parameter added to the viewer must be documented there in the same change.

## Viewer Dev API

The viewer exposes an agent-friendly browser API at `window.__DevApi`. All possible things in the viewer should be able to be done by the API. When adding a new user-facing viewer capability, add or update the matching `__DevApi` method in the same change so agents can do anything a user can do.

Examples:

```js
await __DevApi.ready()
__DevApi.find('baro')
await __DevApi.click('PUSH_AP_MASTER', { count: 2 })
await __DevApi.click('PUSH_STARTER', { holdMs: 1500 })
await __DevApi.click('LEVER_FLAPS', { mouseEvent: 'WheelUp' })
await __DevApi.turn('KNOB_HEADING', { direction: 'up', steps: 3 })
await __DevApi.drag('LEVER_THROTTLE', { axis: 'y', start: 0, end: 1, endPercent: 1 })
await __DevApi.waitFor({ kind: 'gaugesReady', captured: true }, 45000)
__DevApi.list({ kind: 'inputEvents', filter: 'ped_ecp' })
__DevApi.list({ kind: 'animationTriggers', filter: 'flap' })
__DevApi.events({ kind: 'effect', limit: 10 })
__DevApi.checkGauge(undefined, { screenshot: true })
__DevApi.diagnostics({ severity: 'warning', includeGauges: true })
__DevApi.checkParam(['vspeed', 'altitude', 'pressure', 'location'])
__DevApi.checkParam(['gear', 'flaps', 'spoilers', 'parkingBrake'])
__DevApi.setParam('spoilers', 50)
__DevApi.reset({ coldAndDark: true })
__DevApi.report()
```

`status().counts` separates loaded gauge runtimes from visual gauge capture readiness: `capturableGauges` and `capturedCapturableGauges` ignore backend-only `NO_TEXTURE` gauge hosts, while `backendOnlyGauges` counts loaded systems/bridge hosts that do not render to a cockpit texture.

`__DevApi.status()`, `__DevApi.diagnostics()`, and `__DevApi.report()` are available from the initial HTML bootstrap. Before the full viewer runtime is ready they return structured boot progress with `loadStage` and `elapsedMs`; action methods return structured "still loading" responses instead of being missing or producing `undefined`.

`reset()` clears transient DevApi diagnostics by default. Pass `{ runtime: true }` to reset the runtime host to the package preview state, or `{ coldAndDark: true }` to clear runtime variables/events and seed the generic cold-and-dark state for startup tests.

`click()` can also supply stock mouse interaction variables for generic MSFS `MouseRect` / callback code: `mouseEvent` maps to `(M:Event)`, and `inputType`, `relativeX`, `relativeY`, `relativeZ`, and `dragPercent` map to their matching numeric `M:` variables.

`drag()` emits the generic stock drag sequence (`Lock`, `LeftSingle`, repeated `LeftDrag`, `LeftRelease`, `Unlock`) and supplies the same mouse variables for templates that read relative position or drag percent.

## Project Layout

- [`docs/investigations/plan.md`](docs/investigations/plan.md): implementation plan and phase boundaries
- [`src/msfs/importer.ts`](/Users/4980/.t3/worktrees/FlightSim/msfs-combined-375b8e3b-fresh/src/msfs/importer.ts): generic built-package importer and config/model resolution
- [`src/msfs/behavior.ts`](/Users/4980/.t3/worktrees/FlightSim/msfs-combined-375b8e3b-fresh/src/msfs/behavior.ts): behavior include loading, template expansion, and output compilation
- [`src/msfs/rpn.ts`](/Users/4980/.t3/worktrees/FlightSim/msfs-combined-375b8e3b-fresh/src/msfs/rpn.ts): supported calculator/RPN compiler and evaluator
- [`src/msfs/runtime.ts`](/Users/4980/.t3/worktrees/FlightSim/msfs-combined-375b8e3b-fresh/src/msfs/runtime.ts): runtime host and animation/visibility application
- [`src/main.ts`](/Users/4980/.t3/worktrees/FlightSim/msfs-combined-375b8e3b-fresh/src/main.ts): viewer bootstrap, GLTF loading fallback, and diagnostics UI
