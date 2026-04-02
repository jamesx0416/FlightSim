# FlightSim

Browser-based flight sandbox built with Vite, TypeScript, WebGPU, `three`, and `3d-tiles-renderer`. The app renders Cesium ion terrain/3D tiles, runs a simplified generic aircraft flight model, and hosts the MSFS compatibility stack for imported aircraft packages.

The current scene spawns the aircraft on short final for YMML runway 34 near Melbourne. Aircraft visuals now come from MSFS compatibility descriptors and package assets when available.

## Stack

- `bun` for package management and scripts
- Vite + TypeScript
- `three` WebGPU renderer
- `3d-tiles-renderer` with Cesium ion auth
- `@takram/three-atmosphere` and `@takram/three-geospatial`

## Requirements

- Bun
- A browser with WebGPU enabled
- A valid Cesium ion token

## Setup

1. Install dependencies:

```bash
bun install
```

2. Create a `.env` file in the project root:

```dotenv
VITE_CESIUM_ION_TOKEN=your_cesium_ion_token
```

3. Start the dev server:

```bash
bun dev
```

4. Build for production:

```bash
bun run build
```

5. Preview the production build:

```bash
bun run preview
```

## Controls

- `C`: toggle follow camera
- `Backspace`: reset to the initial approach spawn
- `0-9`: set throttle (`0` idle, `1-9` = 10%-90%)
- `ArrowLeft` / `ArrowRight`: roll
- `ArrowUp` / `ArrowDown`: pitch
- `Q` / `E`: yaw
- `[` / `]`: flaps down/up through detents
- `G`: toggle landing gear
- `-` / `=`: spoilers down/up

## Asset Pipeline

The Vite plugin in [`vite.config.ts`](/Users/4980/.t3/worktrees/FlightSim/t3code-ccbef850/vite.config.ts) serves MSFS compatibility descriptors under `/msfs/compatibility/...` and package/source assets under `/msfs/packages/<cacheKey>/...` for the runtime, panel host, and WASM host flows.

## MSFS Compatibility

Phase 0 and Phase 1 compatibility groundwork lives in [`src/msfs/contracts.ts`](/Users/4980/.t3/worktrees/FlightSim/t3code-ccbef850/src/msfs/contracts.ts), [`docs/msfs-compatibility-contracts.md`](/Users/4980/.t3/worktrees/FlightSim/t3code-ccbef850/docs/msfs-compatibility-contracts.md), and [`scripts/import-msfs-aircraft.ts`](/Users/4980/.t3/worktrees/FlightSim/t3code-ccbef850/scripts/import-msfs-aircraft.ts).

Run the MSFS 2020 importer with:

```bash
bun run import:msfs2020 -- third_party/flybywire-aircraft/fbw-a380x/src/base/flybywire-aircraft-a380-842
```

Run the modular MSFS 2024 importer with:

```bash
bun run import:msfs2024 -- fixtures/msfs2024/modular-aircraft
```

The importer discovers aircraft under `SimObjects/AirPlanes` for 2020 packages, resolves `base_container` inheritance, reads `aircraft.cfg` / `model.cfg` / `panel.cfg` / `panel.xml` / `sound.xml`, and writes a normalized cache to `.msfs-cache/` by default. The 2024 path merges `common`, `attachments`, and `presets` content into the same internal IR.

Phase 2 behavior compilation uses the importer output plus the XML/template compiler in [`src/msfs/behavior/compiler.ts`](/Users/4980/.t3/worktrees/FlightSim/t3code-ccbef850/src/msfs/behavior/compiler.ts), the calculator bytecode compiler in [`src/msfs/behavior/calculator.ts`](/Users/4980/.t3/worktrees/FlightSim/t3code-ccbef850/src/msfs/behavior/calculator.ts), and the runtime VM in [`src/msfs/behavior/vm.ts`](/Users/4980/.t3/worktrees/FlightSim/t3code-ccbef850/src/msfs/behavior/vm.ts).

Compile behavior graphs with:

```bash
bun run compile:msfs2020-behavior -- third_party/flybywire-aircraft/fbw-a380x/src/base/flybywire-aircraft-a380-842
```

The compiler resolves local XML includes, expands local templates, compiles calculator code to bytecode, and emits normalized animation / visibility / interaction / update bindings into `.msfs-cache/behavior/` by default. The same compiler script now handles the modular 2024 fixture path too.

Phase 3 through Phase 8 add:

- browser runtime hosting in [`src/msfs/runtime`](/Users/4980/.t3/worktrees/FlightSim/t3code-ccbef850/src/msfs/runtime)
- panel and WASM compatibility host pages in [`panel-host.html`](/Users/4980/.t3/worktrees/FlightSim/t3code-ccbef850/panel-host.html) and [`wasm-host.html`](/Users/4980/.t3/worktrees/FlightSim/t3code-ccbef850/wasm-host.html)
- a compatibility dock overlay in [`src/ui/MsfsCompatibilityDock.ts`](/Users/4980/.t3/worktrees/FlightSim/t3code-ccbef850/src/ui/MsfsCompatibilityDock.ts)
- a compatibility report CLI:

```bash
bun run report:msfs-compat -- .msfs-cache --json-out .msfs-cache/reports/compatibility-report.json
```

- regression tests:

```bash
bun run test:msfs
```

## Project Layout

- [`src/main.ts`](/Users/4980/.t3/worktrees/FlightSim/t3code-ccbef850/src/main.ts): app bootstrap, renderer, tiles, camera, and sim loop
- [`src/msfs/contracts.ts`](/Users/4980/.t3/worktrees/FlightSim/t3code-ccbef850/src/msfs/contracts.ts): compatibility-layer schemas for package import, behavior output, runtime services, and the Phase 0 matrix
- [`src/msfs/behavior`](/Users/4980/.t3/worktrees/FlightSim/t3code-ccbef850/src/msfs/behavior): XML/template compiler, calculator bytecode, and runtime VM for Phase 2
- [`src/sim`](/Users/4980/.t3/worktrees/FlightSim/t3code-ccbef850/src/sim): flight model, atmosphere, frames, and fixed-step loop
- [`src/entities`](/Users/4980/.t3/worktrees/FlightSim/t3code-ccbef850/src/entities): aircraft entity integration
- [`src/helpers`](/Users/4980/.t3/worktrees/FlightSim/t3code-ccbef850/src/helpers): MSFS glTF loading, normalization, and controls helpers
- [`src/plugins`](/Users/4980/.t3/worktrees/FlightSim/t3code-ccbef850/src/plugins): tile material and fade plugins
- [`src/ui`](/Users/4980/.t3/worktrees/FlightSim/t3code-ccbef850/src/ui): HUD overlay

## Notes

- The renderer uses `three/webgpu`, so browser support matters more than in a typical WebGL app.
- Cesium ion access is required at runtime because the tileset is loaded from `https://assets.cesium.com/2275207/tileset.json`.
- The current production build succeeds, but Vite reports a large JS chunk, so future optimization may want code splitting.
