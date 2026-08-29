---
name: flightsim-browser-bench
description: Run, compare, profile, or visually verify FlightSim benchmarks through the repository's serialized Bun CLI. Use for FlightSim performance measurements and browser-based viewer checks.
---

# FlightSim Browser Bench

Use the repository CLI as the only entry point for opening FlightSim or starting a benchmark:

- `bun run browser open <stage>` for retained interactive or visual work.
- `bun run bench ...` for measurements, profiles, comparisons, and automated visuals.
- `bun run browser close` when retained work is complete.

Do not navigate to FlightSim with a new Agent Browser session, create another tab, or implement queue waits with sleeps. The CLI owns the machine-wide FIFO lease, named session, one-tab check, readiness hooks, command log, and cleanup.

Use `--json` when consuming results programmatically. Read the returned readiness data and artifact paths. A failed result is evidence; do not silently replace the requested stage with an earlier boundary.

For an operation the CLI does not expose, first retain a page with `bun run browser open <stage>` or benchmark `--keep-open`. Direct Agent Browser commands may then target only the returned session, without opening or navigating another tab. Close it through `bun run browser close`.

Use `--before`, `--before-file`, or `--before-stdin` for a change that must happen after readiness and before settling/warmup. Use the matching `--after` forms for post-measurement inspection. DevApi calls must return or check their structured response; malformed camera poses fail with `INVALID_ARGUMENTS` and log a console warning.

- Read [references/modes-and-stages.md](references/modes-and-stages.md) when selecting a benchmark or readiness boundary.
- Read [references/comparisons.md](references/comparisons.md) for A/B revision work.
- Read [references/visual-validation.md](references/visual-validation.md) for screenshots, panoramas, and pixel comparison.
