# Deferred cowling seam investigation

Saved 2026-10-05 after James moved the Kan board item to deferred. This is an investigation archive, not an accepted renderer change. Full shadows remain off by default. The contact occlusion controller currently rejects both `?contactOcclusion=1` and `__DevApi.rendering.setContactOcclusionEnabled(true)` with a diagnostic.

## Where the implementation is saved

- Git branch: `codex/cowling-seam-deferred-20261005`.
- [`implementation-snapshot.tar.gz`](implementation-snapshot.tar.gz) is an exact snapshot from the `codex/air-physics` worktree at source HEAD `58e904f065e33a37499da1fc417b695dc5e2ab63`. It contains the untracked prototype files and the renderer, browser API, tests, notes, and docs that reference them. The tracked files also contain unrelated work. Do not extract the archive over a current checkout or apply those files wholesale. Inspect the relevant symbols and port only the intended changes.
- The working source was left in `/Users/4980/Projects/FlightSim/.worktrees/air-physics`. Key files: `src/rendering/contactOcclusion.ts`, `src/rendering/createAircraftShadows.ts`, `src/rendering/createMsfsRenderPasses.ts`, `src/main.ts`, and `src/devApi.ts`. The source snapshot preserves these even if that worktree is later removed.
- [`SHA256SUMS`](SHA256SUMS) records hashes for the snapshot and copied images. [`scripts/`](scripts/) and [`results/`](results/) preserve selected browser probes and compact diagnostic output.

## Verified cause

The bright central cowling line is direct key-light specular on an opaque black cap, `node65004_1` / `A339_ENGINE_BLACK`. At the recorded 1280×577 pose with AA disabled and full shadows off, pixel `(703,300)` is RGB `(200,194,180)`. Blocking only the key light or starting with native full shadows on makes it approximately `(2,4,7)`. Repeated restoration returns the original image. GPU material and hide probes established pixel ownership; CPU rays found a valid caster about 12–14 mm toward the key light. This is separate from the broader white-border issue.

The receiver is a skinned `REVERSE_RIGHT` mesh. The nearby blocker is a skinned engine mesh with 22 joints and moves with wing flex and other animation. A static occlusion bake would go stale. The viewing camera cannot see the nearby blocker behind the painted engine shell, so a camera-depth contact effect misses it.

Recorded camera pose:

```json
{
  "position": [-20.28498574810446, 23.69840952508541, 11.568727641111206],
  "quaternion": [0.13671903433611007, -0.49047646723309873, 0.07823766838095476, 0.8570995321355931],
  "target": [-9.223340300884592, 27.898409525085405, 5.068727641111212]
}
```

## Tried and rejected

| Approach | Result | Decision |
| --- | --- | --- |
| Hook the key-light direct-light term and sample a 2048² light-space depth map | The shader cache key now distinguishes hooked materials, invalidates on installation/removal, handles original and converted node materials, and restores only controller-owned overrides. A temporary key-light-zero probe proved dispatch and was removed. Unsupported surfaces retain diagnostics. | Keep the integration snapshot for future work. |
| Apply a 4 cm contact limit to that depth sample | The sampled frontmost caster is about 16 m from the seam receiver despite the actual local blocker being about 12 mm away. The limit leaves the seam unchanged. | Rejected. One frontmost depth layer cannot establish local contact here. |
| Remove the contact limit | Matched OFF → ON → OFF removed the pixel and restored the original image. At James's larger viewport, the result looked like broad shadows with wing stripes and roughly 12.9 FPS / 77.5 ms. | Rejected. Do not enable the pass or raise resolution/contact distance on this evidence. |
| Try 1024² hardware-filtered comparison | Typechecked, but the 75-frame browser comparison timed out at 120 seconds and left no valid image or cost result. The code was restored. | Inconclusive and not retained. |
| Disable or rotate the key light | Disabling it darkened the aircraft. Rotating its *fitted direction* by +28° made the recorded seam pixel `(2,4,7)` without a new pass, with exact baseline restoration. It shifted highlights elsewhere, including a brighter oblique pylon spot. | Lighting workaround only. Original direction retained. |
| Camera-depth contact effect | The local blocker is hidden from the viewing camera. | Cannot resolve this seam with one camera-depth layer. |

The +28° lighting test at 1280×577 had near/distant/oblique latest GPU samples of `6.029/5.374/6.488 ms` versus `6.095/5.505/6.423 ms` at the original direction. Those short readings do not establish full-size cost. An attempted 1.75 pixel-ratio comparison did not apply the setting because its asynchronous API call was not awaited. The earlier shadow pass gave variable small-viewport GPU increments around 1.5–2 ms, while James's large-viewport capture showed unacceptable total frame time. Do not combine these measurements into a claimed speedup.

## Visual references

- [James's full-size screenshot](assets/user-full-size-depth-pass.png): depth pass lag and wing stripes.
- Light-space pass [OFF](assets/depth-pass-off.png), [ON](assets/depth-pass-on.png), [restored OFF](assets/depth-pass-restored.png).
- Cheaper light-direction test [original](assets/key-original.png), [rotated 28°](assets/key-rotated-28deg.png).
- Oblique comparison [original](assets/key-oblique-original.png), [rotated 28°](assets/key-oblique-rotated-28deg.png). The pylon highlight is stronger in the rotated view.
- Cockpit panel comparison [original](assets/key-cockpit-original.png), [rotated 28°](assets/key-cockpit-rotated-28deg.png).

## If work resumes

Use fresh queue-managed browser sessions and `window.__DevApi`. Check `bun run browser status --json` before opening a session. Compare the exact camera pose and loaded geometry in OFF → ON → OFF with full shadows reported off throughout. Inspect both blocker depth and receiver coordinates before adjusting sampling. Check nearby, distant, oblique, and a meaningful cockpit pose, then collect warmed matched GPU times at James's viewport size. Review alpha/depth coverage, late-loaded meshes, and skinned pose changes. Run `bun typecheck`, `bun lint`, and the whole `bun test` suite. Do not enable by default unless the seam is removed without unwanted darkening or stripes at acceptable cost. Keep the aircraft package fixtures unchanged.

A possible exact approach is a pose-aware spatial acceleration structure that traces key-light rays for receiver UV tiles, with late-load, animation, and light invalidation. This is a design lead, not an implemented or cost-validated fix. The separate white-border issue should be checked after the seam work.
