# FlightSim

Browser-based terrain viewer built with Vite, TypeScript, WebGPU, `three`, and `3d-tiles-renderer`.

The current app renders Cesium ion terrain/3D tiles with atmosphere and postprocessing. The previous aircraft loader and vendored aircraft assets have been removed so the aircraft pipeline can be rebuilt from scratch.

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

## Project Layout

- [`src/main.ts`](/Users/4980/.t3/worktrees/FlightSim/msfs-combined-375b8e3b-fresh/src/main.ts): app bootstrap, camera, tiles, atmosphere, and render loop
- [`src/plugins`](/Users/4980/.t3/worktrees/FlightSim/msfs-combined-375b8e3b-fresh/src/plugins): tile material and fade plugins
- [`src/worker`](/Users/4980/.t3/worktrees/FlightSim/msfs-combined-375b8e3b-fresh/src/worker): worker-backed geometry utilities used by tile plugins

## Notes

- The renderer uses `three/webgpu`, so browser support matters more than in a typical WebGL app.
- Cesium ion access is required at runtime because the tileset is loaded from `https://assets.cesium.com/2275207/tileset.json`.
- This repo is now clear of the old aircraft asset pipeline and ready for a new loader implementation.
