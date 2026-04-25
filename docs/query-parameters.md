# Query Parameters

The viewer reads these URL query parameters at startup. If a parameter is omitted, the runtime follows its normal default path unless noted.

## Package Selection

| Parameter | Example | Feature |
| --- | --- | --- |
| `package` | `?package=/tmp/flybywire-aircraft-a320-neo/` | Selects the main built MSFS package root to load. The value is normalized with a trailing slash. If omitted, `VITE_MSFS_PACKAGE_ROOT` is used, then the built-in development default. |
| `aircraft` | `?aircraft=SimObjects/AirPlanes/FlyByWire_A320_NEO%23fltsim.0` | Selects a specific aircraft variation from the imported package. The aircraft selector also writes this value into the URL when changed. If omitted or invalid, the viewer falls back to the first discovered aircraft. |
| `lod` | `?lod=0` | Requests the initial zero-based LOD index. `0` means LOD00, `1` means LOD01, and so on. Empty values are ignored. Negative or non-integer values throw a startup error. |
| `syncExteriorInterior` | `?syncExteriorInterior` | Loads any `withExterior_showInterior` interior LOD synchronously before the first exterior view. By default, that interior is loaded progressively after the exterior first view is available. |

## Additional Package Roots

| Parameter | Example | Feature |
| --- | --- | --- |
| `packages` | `?packages=/tmp/fs-base-aircraft-common/;/tmp/asobo-vcockpits-instruments-airliners/` | Adds one or more built-package roots for generic shared asset lookup, including behavior XML includes and texture fallback paths. Values can be repeated or delimited with commas, semicolons, or newlines. |
| `deps` | `?deps=/tmp/fs-base-aircraft-common/&deps=/tmp/asobo-vcockpits-instruments-airliners/` | Alias for `packages`. It is useful when listing dependency roots as repeated URL parameters. Values are normalized with trailing slashes and deduplicated after parsing. |
| `stockBehaviors` | `?stockBehaviors=off` | Disables the bundled stock behavior root only when the value is exactly `off`. Any other value, or no value, leaves stock behavior loading enabled unless `VITE_MSFS_STOCK_BEHAVIOR_ROOT=off` is set. |

## Cockpit Diagnostics And Experiments

| Parameter | Example | Feature |
| --- | --- | --- |
| `cockpitPerf` | `?cockpitPerf` | Enables cockpit performance diagnostics and exposes frame/render/load stats through `globalThis.__cockpitPerf`. Without this flag, the per-frame profiler is not installed. |
| `cockpitTextures` | `?cockpitTextures=range-low` | Opts cockpit LOD00 into low-resolution DDS texture loading. The loader fetches DDS headers first, then requests only the selected small mip byte range when the server supports HTTP `Range`; decoded normal/transparent DDS paths use placeholders in this mode to avoid full-buffer CPU decode. If range requests are not supported, it falls back to placeholders instead of downloading the full DDS. |
| `cockpitInstanceStatic` | `?cockpitPerf&cockpitInstanceStatic` | Opts into dynamic runtime instancing for eligible static cockpit meshes in interior LOD00. The default path is unchanged when this flag is absent. The experiment preserves behavior-bound nodes by keeping hidden proxy meshes and only batches meshes with matching geometry, material, draw range, and safe behavior ancestry. |
| `cockpitMergeStatic` | `?cockpitPerf&cockpitMergeStatic` | Opts into dynamic runtime merging for eligible opaque static cockpit meshes in interior LOD00. The default path is unchanged when this flag is absent. The experiment keeps named/metadata proxy meshes hidden, skips behavior-bound/skinned/morphed/transparent/decal meshes, and merges by material plus spatial cell to reduce draw calls while limiting culling loss. It may slightly change visuals because merged chunks can have different frustum-culling or render-order behavior. |

## Common URLs

```text
?package=/tmp/my-aircraft/&aircraft=SimObjects/AirPlanes/MyAircraft%23fltsim.0&lod=0
```

```text
?package=/tmp/my-aircraft/&deps=/tmp/fs-base-aircraft-common/&stockBehaviors=off
```

```text
?package=/tmp/my-aircraft/&cockpitPerf&cockpitInstanceStatic
```

```text
?package=/tmp/my-aircraft/&cockpitPerf&cockpitMergeStatic
```

```text
?package=/tmp/my-aircraft/&cockpitTextures=range-low
```

## Related Environment Variables

These are not query parameters, but they provide defaults that the query parameters can override or augment.

| Variable | Feature |
| --- | --- |
| `VITE_MSFS_PACKAGE_ROOT` | Default main package root when `package` is omitted. |
| `VITE_MSFS_ADDITIONAL_PACKAGE_ROOTS` | Additional package roots appended after `packages` and `deps`. Uses the same comma, semicolon, or newline delimiters. |
| `VITE_MSFS_STOCK_BEHAVIOR_ROOT` | Stock behavior package root. Set to `off` to disable it globally. |
