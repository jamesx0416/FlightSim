# FlightSim

Browser-based Microsoft Flight Simulator 2020 built-package viewer and compatibility runtime prototype.

It loads built MSFS aircraft packages in a Vite/Three.js app, imports exterior and cockpit glTF models, resolves package/config/model/behavior data, drives supported animations/interactions through a generic runtime host, and exposes viewer automation through `window.__DevApi`.

This repo is a generic MSFS loader/runtime project. Do not add aircraft-specific compatibility patches.

## Scope

Currently supported:

- Built package discovery from `aircrafts/`, URL parameters, and Vite env defaults.
- `layout.json`, `manifest.json`, `aircraft.cfg`, `model.cfg`, behavior XML, `panel.cfg`, sound metadata, and common aircraft CFG imports.
- MSFS glTF/DDS/material/skinning normalization for browser rendering.
- Exterior viewing, progressive cockpit/interior loading, VCockpit surface binding, HTML gauge hosting, and bridge-first WASM gauge diagnostics.
- Runtime state for SimVars, local vars, key events, HTML events, bridge events, interactions, sound/effect records, and cold-and-dark/default demo values.
- WebGPU with WebGL fallbacks, diagnostics, settings profiles, cockpit performance tools, and DevApi automation.

Not currently supported:

- Native MSFS WASM ABI execution.
- Wwise `.PCK` playback.
- A full simulator systems model.
- Full MSFS 2024 compatibility.

Unsupported MSFS contracts should be diagnosed or documented as blocked, not hidden behind aircraft-specific logic.

## Setup

```bash
bun install
bun dev
```

Dev URL:

```text
https://vanilla-3dtiles.localhost:3000
```

Checks:

```bash
bun run typecheck
bun run lint
```

`lint` currently runs the same TypeScript no-emit check as `typecheck`.

## Package Selection

Default discovery order:

1. `?package=...`
2. a package found from `?aircraft=...`
3. `/aircrafts/headwindsim-aircraft-a330-900/`
4. the first valid package under `aircrafts/`
5. `VITE_MSFS_PACKAGE_ROOT`
6. `/tmp/headwindsim-aircraft-a330-900/`

Example:

```text
https://vanilla-3dtiles.localhost:3000/?package=/aircrafts/flybywire-aircraft-a320-neo/&aircraft=SimObjects/AirPlanes/FlyByWire_A320_NEO%23fltsim.0
```

Additional roots for stock/shared behavior and texture lookup can be supplied with `?deps=...`, `?packages=...`, or `VITE_MSFS_ADDITIONAL_PACKAGE_ROOTS`.

The bundled stock behavior root is `/vendor/msfs-stock/`. Disable it with `?stockBehaviors=off` or `VITE_MSFS_STOCK_BEHAVIOR_ROOT=off`.

Full URL/env reference: [docs/query-parameters.md](docs/query-parameters.md).

## DevApi

Use `window.__DevApi` for browser automation and verification:

```js
await window.__DevApi.ready()
window.__DevApi.status()
window.__DevApi.diagnostics({ includeGauges: true })
window.__DevApi.find('baro')
await window.__DevApi.camera.enterCockpit()
await window.__DevApi.click('PUSH_AP_MASTER')
window.__DevApi.list({ kind: 'gauges' })
window.__DevApi.report()
```

Full reference: [docs/devapi-reference.md](docs/devapi-reference.md).

When adding a user-facing viewer capability, add or update the matching DevApi method in the same change.

## Useful Files

- [src/main.ts](src/main.ts): viewer bootstrap, package selection, loading, UI, settings, and benchmarks.
- [src/devApi.ts](src/devApi.ts): browser automation API.
- [src/msfs/importer.ts](src/msfs/importer.ts): built-package import and config/model discovery.
- [src/msfs/behavior.ts](src/msfs/behavior.ts): behavior XML/template/RPN compilation.
- [src/msfs/runtime.ts](src/msfs/runtime.ts): runtime host and binding application.
- [src/msfs/gltf/](src/msfs/gltf): MSFS glTF, DDS, material, primitive, and skinning normalization.
- [docs/investigations/loader-todo.md](docs/investigations/loader-todo.md): active loader/runtime/stock-support tracking.

## Development Rules

- Use `bun`.
- Keep fixes generic and authoritative.
- Prefer official MSFS SDK/exporter behavior, then built package evidence, then reverse-engineered importers only as corroboration.
- Keep query parameter docs and DevApi docs in sync with code changes.
