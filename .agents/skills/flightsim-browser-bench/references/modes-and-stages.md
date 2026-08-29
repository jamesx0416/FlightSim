# Modes and stages

Use `bun run bench` and `bun run browser` without arguments for the authoritative option list.

## Benchmarks

- `bun run bench compiled`: compiled update-binding scheduler and RPN execution only.
- `bun run bench no-render bun`: real host, runtime, scene hierarchy, materials, and animation clips in Bun, without rendering.
- `bun run bench no-render browser`: the same no-render aircraft runtime path inside Chrome/V8.
- `bun run bench browser load --stage <stage>`: cold load elapsed time to an explicit boundary.
- `bun run bench browser full`: rendered steady-state cockpit measurement.
- `bun run bench browser profile`: rendered measurement plus a Chrome DevTools profile artifact.
- `bun run bench browser visual`: six 1024-pixel cubemap faces and a stitched 4096 by 2048 equirectangular panorama.

Browser commands close their session by default. Add `--keep-open` to retain a benchmark session or use `bun run browser open <stage>`. Add `--reuse` to a later browser benchmark to attach to that retained page. Reuse defaults to a two-second settling window and measures steady state, not loading, compilation, cold shaders, or texture upload.

## Readiness

- `initial`: `window.__DevApi.status` exists.
- `compiled`: the glTF and behavior compilation boundary has been reached.
- `aircraft`: the aircraft scene is ready.
- `cockpit`: cockpit mode is active and an interior LOD is installed.
- `gauges`: the final interior upgrade stage has completed and all discovered gauges are loaded.
- `stable`: gauges are ready, 120 new animation frames have completed, the rolling FPS window is entirely post-ready, and diagnostics contain no errors.

Non-load browser benchmarks default to `stable`. Load benchmarks require `--stage`. Exact DevApi stage strings and configured custom readiness conditions are also accepted.

Use `--timeout` only to change the 120-second safety bound. It does not add a fixed wait.
