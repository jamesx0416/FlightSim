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

## Project Layout

- [`plan.md`](/Users/4980/.t3/worktrees/FlightSim/msfs-combined-375b8e3b-fresh/plan.md): implementation plan and phase boundaries
- [`src/msfs/importer.ts`](/Users/4980/.t3/worktrees/FlightSim/msfs-combined-375b8e3b-fresh/src/msfs/importer.ts): generic built-package importer and config/model resolution
- [`src/msfs/behavior.ts`](/Users/4980/.t3/worktrees/FlightSim/msfs-combined-375b8e3b-fresh/src/msfs/behavior.ts): behavior include loading, template expansion, and output compilation
- [`src/msfs/rpn.ts`](/Users/4980/.t3/worktrees/FlightSim/msfs-combined-375b8e3b-fresh/src/msfs/rpn.ts): supported calculator/RPN compiler and evaluator
- [`src/msfs/runtime.ts`](/Users/4980/.t3/worktrees/FlightSim/msfs-combined-375b8e3b-fresh/src/msfs/runtime.ts): runtime host and animation/visibility application
- [`src/main.ts`](/Users/4980/.t3/worktrees/FlightSim/msfs-combined-375b8e3b-fresh/src/main.ts): viewer bootstrap, GLTF loading fallback, and diagnostics UI
