# FlightSim Browser and Benchmark CLI Specification

## Status

Implemented on 2026-08-29. This document records both the agreed public contract and the first implementation's boundaries.

The benchmark implementations are available through the unified CLI, while their direct callable adapters remain available for focused development:

- `bun run bench:aircraft-runtime` runs the Bun no-render aircraft benchmark.
- `window.__DevApi.bench.aircraftRuntime()` runs the browser no-render aircraft benchmark.
- `bun run bench compiled` runs the direct compiled-binding benchmark.

Browser lifecycle commands remain separate from benchmark commands.

## Goals

- Provide one consistent benchmark interface for compiled, Bun no-render, browser no-render, and fully rendered browser workloads.
- Provide a separate browser lifecycle interface for interactive and visual investigation.
- Guarantee that performance-affecting FlightSim browser and benchmark work is serialized.
- Use one named Agent Browser session with exactly one tab.
- Make readiness waits use DevApi state instead of sleeps.
- Support reproducible Git baseline and candidate comparisons.
- Retain successful and failed command history for later workflow analysis.
- Make visual comparison deterministic and artifact-driven.
- Keep the first implementation small enough to trust.

## Non-goals for the first implementation

- A Node/V8 no-render runner. It is specified as a future target only.
- Direct Chrome control without Agent Browser.
- Safari, Firefox, or other browser drivers.
- Named visual camera locations. James will add these later.
- A `bench all` command.
- Queue administration commands such as `status` or `cancel`.
- OS-level GPU utilization when it cannot be collected cheaply and without privileges.

## Public command structure

There are two user-facing CLIs backed by shared implementation modules.

### Browser lifecycle

```sh
bun run browser open <stage>
bun run browser close
```

### Benchmarks

```sh
bun run bench compiled
bun run bench no-render bun
bun run bench no-render browser
bun run bench browser load --stage <stage>
bun run bench browser full
bun run bench browser profile
bun run bench browser visual
```

### Comparisons

```sh
bun run bench compare compiled
bun run bench compare no-render bun
bun run bench compare no-render browser
bun run bench compare browser full
bun run bench compare browser full --visual
bun run bench compare browser visual
```

There are no top-level mode convenience aliases. Running either CLI without an operation prints help.

```sh
bun run browser
bun run bench
```

The stage is positional for `browser open`:

```sh
bun run browser open cockpit
```

Benchmark browser stages are overridden with `--stage`:

```sh
bun run bench no-render browser --stage aircraft
bun run bench browser full --stage gauges
```

## Shared implementation

The two CLIs must not duplicate browser, queue, comparison, or reporting logic.

Conceptually:

```text
scripts/flightsim-tools.ts
├── browser commands
└── benchmark commands

src/benchmarks/
├── queue and lease
├── browser driver
├── readiness stages
├── hooks
├── runners
├── Git comparison
├── visual artifacts
├── environment sampling
├── command logging
└── reporting
```

The package scripts can be thin aliases over the same executable:

```json
{
  "scripts": {
    "browser": "bun scripts/flightsim-tools.ts browser",
    "bench": "bun scripts/flightsim-tools.ts bench"
  }
}
```

## Browser lifecycle commands

### `browser open <stage>`

Example:

```sh
bun run browser open cockpit
```

The command:

1. Joins the global FIFO queue.
2. Acquires the exclusive browser lease.
3. Creates one derived, named Agent Browser session.
4. Opens exactly one tab.
5. Navigates to FlightSim.
6. Waits for the requested DevApi readiness stage.
7. Starts a small background lease keeper.
8. Returns the session name and readiness result to the caller.

The browser remains open and continues holding the exclusive lease. This command is intended for interactive DevApi checks, screenshots, visual inspection, and further profiling.

Agents must not create another Agent Browser session or tab after `browser open`. They use the returned session until they call `browser close`.

### `browser close`

```sh
bun run browser close
```

The command:

1. Resolves the retained lease for the current agent/worktree.
2. Closes its Agent Browser session.
3. Stops its lease keeper.
4. Releases the global queue lease.

It must never close a session owned by another agent.

## Benchmark modes

### `bench compiled`

This is the smallest CPU benchmark.

It includes:

- The real compiled A330 update-binding set.
- Shared-frequency scheduling.
- RPN expression evaluation.
- Variable writes and events.
- Deterministic final-state verification.

It excludes:

- `SharedMsfsRuntimeHost`.
- `AircraftRuntime`.
- Scene nodes and animation clips.
- Browser and renderer work.

This replaces the term "static" in the public CLI because "static" is ambiguous in a 3D engine.

### `bench no-render bun`

This is the no-render aircraft benchmark already implemented in Bun.

It includes:

- Bun and JavaScriptCore.
- Imported aircraft package metadata.
- Exterior and interior transform/material hierarchy.
- Real animation tracks.
- Compiled behaviors.
- `SharedMsfsRuntimeHost`.
- `AircraftRuntime`.
- Fixed-step runtime updates.
- Phase profiles, binding counts, and deterministic output checksum.

It excludes a browser and renderer.

Current benchmark defaults remain:

```text
5,000 measured frames
300 warmup frames
fixed 1/60 timestep
```

The current implementation has matched the browser workload at:

```text
681 update bindings
708 animation bindings
110 visibility bindings
797 material bindings
826 animation clips
checksum fnv1a32:b0c216c7
```

### `bench no-render browser`

This runs the browser DevApi no-render benchmark.

It includes:

- A real loaded FlightSim page.
- Chrome and V8.
- The loaded aircraft and cockpit scene.
- Real Three.js animation clips.
- A fresh isolated `SharedMsfsRuntimeHost` and `AircraftRuntime`.
- Fixed-step runtime updates.

Rendering is not performed during the measured synchronous runtime updates.

Agent Browser is the first browser automation driver. It is an implementation detail and is recorded in result metadata:

```json
{
  "target": "browser",
  "driver": "agent-browser",
  "browser": "chrome",
  "browserVersion": "...",
  "javascriptEngine": "v8"
}
```

### `bench browser load`

```sh
bun run bench browser load --stage cockpit
```

This measures navigation through the requested readiness stage. The stage is required because it defines the measurement.

It can isolate loading through:

- DevApi initialization.
- Behavior compilation.
- Initial aircraft readiness.
- Cockpit upgrade readiness.
- Gauge readiness.
- Stable benchmark readiness.

It does not report steady-state FPS as its primary result.

### `bench browser full`

This measures the normally rendered simulator after reaching stable readiness.

It includes:

- Aircraft runtime CPU work.
- Geometry, materials, and textures.
- Gauges.
- Renderer and GPU submission.
- Normal presentation and frame pacing.

It reports FPS, frame-time distributions, relevant runtime phases, environment noise, renderer data, and available GPU timing.

### `bench browser profile`

This runs a rendered measurement while recording a Chrome DevTools performance trace.

The trace is diagnostic. Trace collection adds overhead, so its FPS is not the primary regression number. The output includes the trace artifact path for Chrome DevTools or Perfetto.

### `bench browser visual`

This performs visual verification against the current workspace without a Git comparison.

The default visual representation is a stitched panorama:

1. Capture six square, UI-free canvas images from one exact position.
2. Use front, back, left, right, up, and down directions.
3. Use a 90-degree field of view for each face.
4. Stitch the six faces deterministically into one panorama.
5. Retain both the panorama and source faces.

Named camera locations are deferred until James adds the authoritative positions. The visual result schema must support multiple named locations when they become available.

A wide single-frame view can be added later as an explicit view. It is not part of the first default.

Deterministic capture depends on the existing DevApi follow-up already recorded in `NOTES.md` and `docs/investigations/loader-todo.md`: a pose returned by `camera.getPose()` must be accepted by `camera.setPose()` and restore position, quaternion, target, and cockpit state exactly. The CLI must use that authoritative pose API, not mouse-drag reconstruction.

Malformed DevApi calls must fail with the planned structured `INVALID_ARGUMENTS` response and matching JavaScript console warning. The benchmark CLI treats such a response as a failed command and records it in the command log rather than continuing with a partially applied pose or hook.

## Readiness stages

Built-in aliases:

```text
initial
compiled
aircraft
cockpit
gauges
stable
```

Meanings:

- `initial`: the page and boot DevApi are installed.
- `compiled`: the selected aircraft behavior compilation is ready.
- `aircraft`: the initial aircraft model and runtime are usable.
- `cockpit`: the upgraded cockpit/interior is ready.
- `gauges`: the final interior upgrade is ready and every discovered cockpit gauge is loaded. Capture counts are reported but do not block aircraft with intentionally non-capturable or inactive surfaces.
- `stable`: gauges are ready, 120 new animation frames have completed, the viewer's rolling FPS window is therefore entirely post-ready, and diagnostics report no errors.

`compiled` remains distinct from `aircraft` even if they currently finish close together. They represent different subsystems and compiler-only profiling needs an authoritative boundary.

### Default stages

Both no-render browser and rendered browser benchmarks default to `stable` readiness:

```text
no-render browser: stable
browser full: stable
browser profile: stable
browser visual: stable
```

`browser load` requires `--stage`.

The resolved stage and exact observed DevApi state are included in every result.

### Exact and custom states

`--stage` accepts a built-in alias or exact DevApi load-stage value:

```sh
--stage cockpit
--stage gltf:interior-upgrade:ready
```

Custom named readiness states live in a benchmark configuration module rather than becoming new flags:

```ts
export default {
  stages: {
    'gauges-captured': {
      condition: `
        window.__DevApi.status().data.counts.capturedCapturableGauges ===
        window.__DevApi.status().data.counts.capturableGauges
      `
    },
    'perf-ready': {
      condition: `globalThis.__cockpitPerf?.getSummary().sampleCount >= 300`
    }
  }
}
```

Usage:

```sh
bun run browser open perf-ready
bun run bench browser full --stage perf-ready
```

Readiness is event/condition driven through DevApi and Agent Browser `wait --fn`. Fixed sleeps are not readiness mechanisms.

## Timeout

The first implementation uses one 120-second default timeout for queue-acquired browser loading and readiness operations. `--timeout` overrides it.

The resolved timeout is included in output metadata.

## Before and after JavaScript

Available on benchmark and comparison commands:

```text
--before <javascript>
--before-file <path>
--before-stdin

--after <javascript>
--after-file <path>
--after-stdin
```

Execution order:

```text
stage ready
→ before hook
→ settle
→ warmup
→ measurement
→ after hook
→ visual capture when requested
→ report
→ close or retain
```

The JavaScript runs in the FlightSim page. `--before` runs after readiness and before settling/warmup. `--after` runs immediately after measurement.

Comparison commands execute the same hooks against baseline and candidate.

Only one stdin hook is allowed per invocation because standard input cannot independently provide two scripts.

## Reusing a loaded page

Fresh loading is the default.

```sh
bun run bench browser full --reuse
bun run bench browser full --reuse --settle 3s
```

`--reuse` attaches to the currently retained browser lease instead of navigating a new page.

It is allowed for:

- `no-render browser`.
- `browser full`.
- `browser profile`.
- `browser visual`.

It is rejected for:

- `browser load`.
- Every Git comparison.

The default reused-page settling window is two seconds. `--settle` overrides it. Warmup occurs after settling.

Reuse is intended for dynamic steady-state changes such as quality toggles, feature toggles, cameras, and settings that do not require code reload. Results are labelled `steady-state-reuse` and do not claim to measure compilation, loading, texture upload, startup memory, or cold shader cost.

## Git comparisons

The comparison command supports every required benchmark class:

```sh
bun run bench compare compiled
bun run bench compare no-render bun
bun run bench compare no-render browser
bun run bench compare browser full
```

Visual comparison can augment a full comparison:

```sh
bun run bench compare browser full --visual
```

Or run alone:

```sh
bun run bench compare browser visual
```

### Baseline and candidate

Both sides can be selected:

```sh
bun run bench compare browser full \
  --baseline HEAD~5 \
  --candidate HEAD~2
```

Defaults:

```text
baseline: HEAD
candidate: current working tree
```

`--candidate worktree` explicitly selects the current working tree.

There is no `--compare` flag. `compare` defines the operation, while `--baseline` and `--candidate` select its inputs.

When both inputs are Git revisions, the comparator creates isolated temporary worktrees and servers for both. It must not revert or mutate the active checkout.

### Measurement order

The first implementation runs one baseline then one candidate. If repeated comparison is added later, it must use an alternating or A-B-B-A order so thermal and background drift do not consistently favor one side. There is no first-pass repeat flag.

Every comparison verifies applicable semantic invariants before accepting a performance result:

- Output checksum equality.
- Binding-count equality.
- Expected workload identity.
- Visual artifact availability when visual comparison is requested.

The first implementation reports raw measurements and an explicit unassessed noise classification. A future configured repeat policy can return `inconclusive` when noise is too high to establish a minimum change.

`--reuse` is invalid for comparisons.

## Visual comparison

The default comparison artifact is the stitched panorama, not six independent pass/fail decisions.

The default output is an equirectangular PNG at 4096 by 2048 pixels, stitched from six 1024 by 1024 pixel faces.

For each location and revision:

```text
six cubemap faces
→ deterministic stitched panorama
→ pixel comparison
→ difference image and metrics
```

The six source faces are retained for diagnosis, especially around panorama seams, but the stitched panorama is the default comparison input.

Viewer UI is excluded by capturing the render canvas rather than the entire browser viewport.

### Artifact paths

Artifact paths are always exposed.

Human-readable output prints at least:

```text
Baseline panorama:  <path>
Candidate panorama: <path>
Difference image:   <path>
Visual report:      <path>
```

JSON output includes those paths plus every cubemap face:

```json
{
  "visual": {
    "location": "default",
    "view": "panorama",
    "baseline": {
      "panorama": "...",
      "faces": {
        "front": "...",
        "back": "...",
        "left": "...",
        "right": "...",
        "up": "...",
        "down": "..."
      }
    },
    "candidate": {
      "panorama": "...",
      "faces": {}
    },
    "difference": "...",
    "report": "..."
  }
}
```

Exact camera position, quaternion, FOV, viewport, DPR, stage, and visual settings are recorded alongside every capture.

Pixel comparison is evidence, not an automatic proof of semantic correctness. The report preserves originals for agent and human review.

## CPU, GPU, and environment noise

Browser benchmark output includes low-overhead environment sampling before, during, and after measurement.

### Before

- System CPU load.
- Chrome process CPU activity.
- Memory pressure.
- Thermal state when available.
- Other active browser processes.

### During

- Chrome renderer CPU.
- Chrome GPU-process CPU.
- Main-thread and frame-time distributions.
- Render timing.
- Available GPU frame timing.
- FPS and dropped frames for rendered modes.

### After

- System CPU load.
- Thermal-state change when available.
- Peak browser memory.

Sampling must be low frequency and outside the measured JavaScript hot loop.

Actual OS GPU utilization is reported only when it can be collected cheaply, without privileges, and without materially perturbing the benchmark. Otherwise the field is explicitly unavailable. Chrome GPU-process CPU and available GPU frame timing remain useful fallbacks.

No noise threshold is invented by default. The first implementation reports the observations, peaks, and `unassessed` classification. Once a repository threshold is configured, activity above it must be marked noisy or inconclusive rather than silently accepted.

## Queue and lease

All performance-affecting FlightSim browser and benchmark work uses one machine-wide FIFO queue. Agents never implement queue waits with sleeps.

This includes:

- Browser lifecycle commands.
- Browser benchmarks.
- Bun and compiled performance benchmarks, because their CPU use could distort an active browser benchmark.
- Visual tests, because an idle loaded simulator can distort performance measurements.

### Minimal queue records

A waiting ticket contains only:

```text
sequence
PID
```

The active lease contains only:

```text
PID
session name, when a browser is active
```

Benchmark metadata belongs in results and logs, not queue tickets.

### Foreground benchmark behavior

`bench` commands remain active while queued and while running:

```text
join queue
→ wait internally
→ acquire lease
→ run
→ print result
→ release
→ exit
```

They occasionally print compact progress such as:

```text
Waiting for benchmark slot, 2 requests ahead
```

Agents do not poll or queue sleeps. Long-running shell integrations can yield a process/session handle while the CLI continues running.

### Retained browser behavior

`browser open` and benchmark `--keep-open` return after readiness/completion while a small background keeper retains the lease and named session. `browser close` performs cleanup and releases the lease.

A fully detached benchmark mode is deferred until real usage demonstrates a need.

### Stale recovery

The queue validates the owning PID and, for retained browser leases, the named Agent Browser session. It can recover a lease only when ownership is demonstrably stale.

## Agent Browser invariants

- The first implementation uses Agent Browser to control Chrome.
- Each lease derives one unique session name from the worktree/agent identity and queue sequence.
- Each session has exactly one tab.
- Benchmark code must not create additional tabs.
- Browser readiness uses DevApi and `wait --fn` conditions.
- Routine browser work must not use synthetic mouse gestures when DevApi provides an equivalent operation.
- Browser commands close by default after bounded benchmarks.

## Command logging

Every attempted browser and benchmark command is appended to an ignored rotating JSONL log, including failures.

Each record contains only useful operational data:

```text
timestamp
owner
operation and sanitized arguments
session name when applicable
exit status
duration
error code and concise message
artifact directory
```

Before/after inline JavaScript is hashed in the command log rather than duplicated. File hooks record their path and content hash. Known secrets are redacted.

The command log exists to study agent behavior, queue failures, invalid flag combinations, timeouts, and commonly repeated manual workflows.

## Output and artifacts

Every benchmark result includes enough metadata to reproduce and interpret it:

- Benchmark kind and version.
- Baseline and candidate revisions when applicable.
- Dirty working-tree state when applicable.
- Resolved stage and timeout.
- Aircraft/package identity.
- Browser, driver, and JavaScript engine.
- Browser version.
- Viewport and DPR.
- Camera/visual pose when applicable.
- Warmup and measurement configuration.
- Cache/reuse classification.
- CPU/GPU/environment observations.
- Noise classification.
- Semantic checksums and binding counts.
- Artifact paths.

Human-readable output is concise. `--json` emits the full structured result.

## Skill specification

Create or replace the current WIP benchmark skill with a correctly named `flightsim-browser-bench` skill.

Its core invariant is:

> Never launch a FlightSim browser directly. Start every FlightSim browser, including visual-only work, through `bun run browser` or `bun run bench` so the global queue, named session, one-tab limit, readiness waits, logging, and cleanup are enforced.

The skill permits direct Agent Browser interaction only with the exact retained session returned by `browser open` or benchmark `--keep-open`. It forbids opening another session or tab and requires `bun run browser close` when the retained investigation ends.

The skill should remain concise:

```text
flightsim-browser-bench/
├── SKILL.md
└── references/
    ├── modes-and-stages.md
    ├── comparisons.md
    └── visual-validation.md
```

`SKILL.md` contains mode-selection guidance and invariants. Detailed CLI options and examples live in the references.

## Future Node/V8 target

Node is included in the command model but not implemented in the first pass:

```sh
bun run bench no-render node
bun run bench compare no-render node
```

Node would run the no-render workload under V8, potentially improving directional agreement with Chrome for JavaScript-engine-sensitive changes. It would not replace browser verification because Node and Chrome still differ in V8 configuration, embedder, scheduler, memory environment, renderer processes, and scene pressure.

The Bun CLI remains the orchestrator even when a future Node worker executes the workload.

## Future browser drivers

The implementation should use an internal browser-driver boundary, initially backed only by Agent Browser.

Potential future drivers include direct Chrome CDP, Safari WebDriver, and Firefox. Do not expose a public driver flag until a second driver exists.

Potential future browser selection can use:

```sh
bun run bench no-render browser --browser chrome
bun run bench no-render browser --browser safari
```

Chrome remains the first authoritative browser performance target.

## Implementation order

- [x] Extract the existing measurement runners behind stable callable interfaces.
- [x] Implement the minimal FIFO queue and retained lease.
- [x] Implement the shared Agent Browser driver with one-session/one-tab enforcement.
- [x] Implement readiness aliases, exact stages, and custom configured stages.
- [x] Implement `browser open` and `browser close`.
- [x] Move the existing compiled and Bun no-render benchmarks behind `bun run bench`.
- [x] Implement browser no-render and full rendered benchmark modes.
- [x] Implement before/after hooks, reuse, settling, and structured reporting.
- [x] Implement Git baseline/candidate worktree comparison.
- [x] Complete the generic exact-pose DevApi contract and malformed-command validation needed for deterministic capture.
- [x] Implement stitched panorama capture, pixel comparison, and artifact reporting.
- [x] Add Chrome profiling and environment/noise reporting.
- [x] Add rotating success/failure command logging.
- [x] Create and validate the `flightsim-browser-bench` skill.

Each implementation phase must preserve deterministic workload checks and use the existing Bun benchmark plus browser verification in proportion to the change.
