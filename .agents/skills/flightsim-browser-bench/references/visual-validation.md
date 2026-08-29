# Visual validation

`bun run bench browser visual --json` is the default automated visual check. It waits for stable readiness, captures six UI-excluded canvas faces from one exact DevApi camera pose, stitches a 4096 by 2048 equirectangular panorama, restores the original pose and viewport, and returns every artifact path.

For interactive inspection:

```sh
bun run browser open stable --json
# Use only the returned Agent Browser session if another operation is needed.
bun run browser close --json
```

The DevApi pose contract includes position, quaternion, target, cockpit state, and vertical FOV. Always round-trip the complete object returned by `camera.getPose()` into `camera.setPose()`. Do not reproduce benchmark viewpoints with mouse drags.

Visual revision comparison is available directly, or with rendered full through `--visual`. Pixel equality is strong regression evidence but is not proof of behavioral equivalence. Inspect the original panoramas and diff when pixels change.

Default camera locations are intentionally not embedded yet. Add named positions only after they are authoritative and stable.
