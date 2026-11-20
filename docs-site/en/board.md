# Read the board

Open the local board anytime to see running work, `map` batch progress, queue positions, diffs, context warnings, and audit history across projects.

```sh
broco ui
broco ui --no-open
```

The first command opens your browser; the second prints the local URL without opening a tab. The board remembers its port and restores it automatically across runner restarts.

## Follow tickets and batches

- **Queued**: waiting for an open slot in the project’s FIFO concurrency pool, showing queue position.
- **Working**: active turn with live step readouts, worker/model/effort, branch, and changed files.
- **Review**: worker returned a result waiting for your inspection or cross-vendor `broco review`.
- **Done**: closed with `broco done NAME` (capped to the latest 50 cards with search and batch/outcome filters).

For sharded `broco map` batches, the board displays a live batch progress bar, `[index/count]` shard badges, and a sibling shard switcher inside the detail drawer.

## Inspect evidence and undo settings

Open a ticket to read its final reply, multi-task history, collapsed local-timezone timelines (controlled by `BROCO_TZ`, `TZ`, or your system timezone), outcome/problem banners, context-window warnings (at 60% of model `context_tokens`), and links between writer and cross-vendor reviewer.

In the terminal, use `broco status`, `broco ls --active`, `broco show NAME --compact`, `broco diff NAME`, `broco stats`, and `broco watch`.

Open **Settings** in the header to view detected CLIs, effective defaults, hidden models, [custom templates](custom-cli.md), and the settings audit log with one-click **Undo**.
