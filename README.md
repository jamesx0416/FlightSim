# FlightSim

Browser-based flight simulation engine and aircraft compatibility environment.

The project is moving toward a simulator-agnostic engine written in TypeScript.
MSFS built packages remain the first supported aircraft source, but MSFS is now
an adapter and compatibility layer rather than the core architecture.

## Direction

The long-term architecture is:

- `src/sim/engine/`: canonical simulator state, commands, subsystems,
  scheduler, aircraft definitions, control-surface animation state, and future
  physics.
- `src/msfs/`: MSFS package loading, behavior/runtime compatibility, SimVars,
  LVars, RPN, key events, gauges, and other MSFS-shaped adapter APIs.
- `src/sim/`: existing simulation and physics primitives that will move behind
  the engine lifecycle over time.
- `src/entities/` and `src/input/`: viewer/runtime consumers that should
  eventually read and write through engine state and commands.

Use **canonical aircraft definition** for normalized aircraft data emitted by
loaders.

## Current Scope

Supported today:

- Built MSFS package discovery from `aircrafts/`, URL parameters, and Vite env
  defaults.
- `layout.json`, `manifest.json`, `aircraft.cfg`, `model.cfg`, behavior XML,
  `panel.cfg`, sound metadata, aircraft CFG imports, and `.flt` state imports.
- MSFS glTF, DDS, material, skinning, primitive, and geometry normalization.
- Exterior viewing, progressive cockpit loading, VCockpit surface binding, HTML
  gauge hosting, bridge-first WASM gauge diagnostics.
- Runtime compatibility for supported SimVars, local vars, key events, HTML
  events, bridge events, interactions, sound/effect records, and cold-and-dark
  or demo defaults.
- Initial canonical engine APIs for typed state, units, commands, subsystems,
  canonical aircraft definitions, and lighting/electrical compatibility aliases.
- WebGPU with WebGL fallbacks, diagnostics, settings profiles, cockpit
  performance tools, and `window.__DevApi` automation.

Not supported yet:

- Full simulator systems model.
- Engine-owned physics integration.
- Native MSFS WASM ABI execution.
- Wwise `.PCK` playback.
- Full MSFS 2024 compatibility.

Unsupported MSFS contracts should be diagnosed or documented as blocked, not
hidden behind aircraft-specific logic.

## Architecture Docs

- [docs/architecture/simulation-engine.md](docs/architecture/simulation-engine.md):
  authoritative simulator-engine architecture and migration roadmap.
- [docs/investigations/loader-todo.md](docs/investigations/loader-todo.md):
  active MSFS loader/runtime compatibility checklist serving the engine and
  adapter roadmap.
- [docs/investigations/plan.md](docs/investigations/plan.md): historical
  MSFS-loader-first plan retained for context.

## Development

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
bun test
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

Additional roots for stock/shared behavior and texture lookup can be supplied
with `?deps=...`, `?packages=...`, or `VITE_MSFS_ADDITIONAL_PACKAGE_ROOTS`.
The bundled stock behavior root is `/vendor/msfs-stock/`. Disable it with
`?stockBehaviors=off` or `VITE_MSFS_STOCK_BEHAVIOR_ROOT=off`.

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

Reference: [docs/devapi-reference.md](docs/devapi-reference.md).

When adding a user-facing viewer capability, add or update the matching DevApi
method in the same change.

Run the serialized benchmark CLI:

```sh
bun run bench compiled
bun run bench no-render bun
bun run bench no-render browser
bun run bench browser full
bun run bench browser profile
bun run bench browser visual
```

Use `bun run browser open <stage>` and `bun run browser close` for a retained,
queue-managed viewer session. `bun run bench compare ...` runs isolated Git A/B
comparisons. Both CLIs print their complete option help without arguments. See
[the browser benchmark specification](docs/browser-benchmark-spec.md).

`bun run bench:aircraft-runtime` remains available as the direct Bun no-render
adapter for focused development.

## Useful Files

- [src/sim/engine/](src/sim/engine): simulator-agnostic engine APIs, including
  canonical state/commands for lighting, propulsion, controls, and animated
  surfaces.
- [src/main.ts](src/main.ts): viewer bootstrap, package selection, loading, UI,
  settings, and benchmarks.
- [src/devApi.ts](src/devApi.ts): browser automation API.
- [src/msfs/importer.ts](src/msfs/importer.ts): built-package import and
  config/model discovery.
- [src/msfs/behavior.ts](src/msfs/behavior.ts): behavior XML/template/RPN
  compilation.
- [src/msfs/runtime.ts](src/msfs/runtime.ts): current MSFS compatibility runtime
  host and binding application.
- [src/msfs/compatibilityBridge.ts](src/msfs/compatibilityBridge.ts): first
  MSFS-to-canonical-state compatibility bridge.
- [src/msfs/gltf/](src/msfs/gltf): MSFS glTF, DDS, material, primitive, and
  skinning normalization.
- [NOTES.md](NOTES.md): durable investigation observations and rejected
  experiments. Do not treat notes as active fixes without fresh verification.

## Development Rules

Use `bun`. Keep engine, adapter, and compatibility changes generic and
authoritative. Do not add aircraft-specific patches.

For MSFS adapter behavior, prefer official MSFS SDK/exporter behavior, then
built package evidence, then reverse-engineered importers only as corroboration.

Keep query parameter docs and DevApi docs in sync with code changes.
