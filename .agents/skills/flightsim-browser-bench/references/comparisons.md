# Revision comparisons

The comparison forms support compiled, Bun no-render, browser no-render, rendered full, and visual modes. The default baseline is `HEAD`; the default candidate is the current `worktree`. Override either side with `--baseline <ref>` and `--candidate <ref|worktree>`.

Examples:

```sh
bun run bench compare compiled --baseline HEAD~1 --candidate HEAD --json
bun run bench compare no-render bun --baseline main --candidate worktree --json
bun run bench compare browser full --baseline HEAD~1 --candidate worktree --visual --json
```

The runner uses detached worktrees and revision-local Vite servers without modifying the active checkout. Baseline and candidate execute serially under one FIFO lease. Each browser is closed before the next side starts.

Treat performance as comparable only when the reported semantic checks are available and equal. Compiled and no-render modes compare output checksums and binding counts. Visual comparisons preserve both panoramas, an exact pixel-difference image, and a JSON report.

An older revision may not support a newer DevApi benchmark endpoint or may fail to reach a requested readiness boundary. Report that side as unsupported or failed. Do not weaken the requested boundary to manufacture a number.
