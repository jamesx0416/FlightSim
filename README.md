# FlightSim

Browser-based flight sandbox built with Vite, TypeScript, WebGPU, `three`, and `3d-tiles-renderer`. The app renders Cesium ion terrain/3D tiles and flies a simplified FlyByWire A320 flight model with a chase camera and on-screen HUD.

The current scene spawns the aircraft on short final for YMML runway 34 near Melbourne, with FlyByWire A320 exterior assets loaded from the vendored `third_party/flybywire-aircraft` tree.

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

The app expects FlyByWire A320 assets in `third_party/flybywire-aircraft/fbw-a32nx/...`.

- During development, the custom Vite plugin in [`vite.config.ts`](/Users/4980/.t3/worktrees/FlightSim/t3code-ccbef850/vite.config.ts) serves the A320 model, DDS textures, and a generated texture manifest under `/vendor/fbw-a32nx/...`.
- During production builds, that same plugin copies the required model and textures into `dist/vendor/fbw-a32nx`.
- Fallback PNG textures for normalized MSFS assets live under [`public/aircraft/a32nx/exterior/LOD00-msfs`](/Users/4980/.t3/worktrees/FlightSim/t3code-ccbef850/public/aircraft/a32nx/exterior/LOD00-msfs).

Utility scripts:

- [`scripts/convert-a32nx-exterior.ts`](/Users/4980/.t3/worktrees/FlightSim/t3code-ccbef850/scripts/convert-a32nx-exterior.ts): cleans and repacks the FlyByWire exterior glTF
- [`scripts/build-a32nx-ktx2.ts`](/Users/4980/.t3/worktrees/FlightSim/t3code-ccbef850/scripts/build-a32nx-ktx2.ts): converts DDS texture references to KTX2 assets

These scripts are not wired into `package.json`; run them directly with `bun` if needed.

## Project Layout

- [`src/main.ts`](/Users/4980/.t3/worktrees/FlightSim/t3code-ccbef850/src/main.ts): app bootstrap, renderer, tiles, camera, and sim loop
- [`src/sim`](/Users/4980/.t3/worktrees/FlightSim/t3code-ccbef850/src/sim): flight model, atmosphere, frames, and fixed-step loop
- [`src/entities`](/Users/4980/.t3/worktrees/FlightSim/t3code-ccbef850/src/entities): aircraft entity integration
- [`src/helpers`](/Users/4980/.t3/worktrees/FlightSim/t3code-ccbef850/src/helpers): MSFS glTF loading, normalization, and controls helpers
- [`src/plugins`](/Users/4980/.t3/worktrees/FlightSim/t3code-ccbef850/src/plugins): tile material and fade plugins
- [`src/ui`](/Users/4980/.t3/worktrees/FlightSim/t3code-ccbef850/src/ui): HUD overlay
- [`src/visual`](/Users/4980/.t3/worktrees/FlightSim/t3code-ccbef850/src/visual): aircraft animation fallback logic

## Notes

- The renderer uses `three/webgpu`, so browser support matters more than in a typical WebGL app.
- Cesium ion access is required at runtime because the tileset is loaded from `https://assets.cesium.com/2275207/tileset.json`.
- The current production build succeeds, but Vite reports a large JS chunk, so future optimization may want code splitting.
