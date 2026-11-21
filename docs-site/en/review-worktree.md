# Worktrees, diff, and cross-vendor review

Use `--worktree` when two writers could touch the same files or when you want an isolated diff. Use `broco diff` to inspect exact changes, `broco review` for cross-vendor blind review, and `broco clean` after merging.

## Start an isolated change

From any Git repository with at least one commit, pass `--worktree` on the first `say` (or `map`):

```sh
broco say auth-fix - --worker codex --worktree --bg --json <<'EOF'
Fix token expiry and add regression tests for refresh token clock skew.
EOF
broco wait auth-fix --json
broco diff auth-fix --stat
```

The new branch (`broco/<name>-...`) and worktree start from committed `HEAD`. Reusing the session name stays in that same worktree. `broco diff auth-fix` shows both tracked and untracked changes relative to the ticket’s base commit (`--stat` prints a summary).

## Cross-vendor blind review

```sh
broco review auth-fix --bg --json
```

When `--by` is omitted, `broco review` automatically chooses an allowed worker from a **different vendor** with available quota headroom — for example reviewing a `codex` patch with `claude`, or a `claude` patch with `codex`. You can also pass `--by claude`, `--by codex`, `--by cursor-agent`, or `--by pi:<provider>` explicitly (for `agy`, see the [API key / Enterprise warning](../workers/#agy)).

The reviewer runs in a separate session with the writer’s prompt, final reply, and changed-file summary, inspecting the writer’s checkout directly. Keep that checkout stable until the review completes.

The receipt returns the **review ticket’s own name and turn**. Wait for it with `broco wait <review-name> --json`, send any requested fixes back to `auth-fix`, and record `broco done` for writer and reviewer separately.

## Clean up finished worktrees

`broco` never merges or deletes branches automatically. Once you have reviewed and merged or discarded the branch:

```sh
broco clean auth-fix --dry-run
broco clean auth-fix --delete-branch
```

Omit the name (`broco clean`) to remove all retained worktrees and orphaned attachment snapshots from finished (`done`) tickets. Add `--force` only when intentionally discarding dirty or unmerged worktrees.
