# Steer a running ticket

Send another `say` to the same session name when you want to clarify or refine a task already in progress. Use a different name when the work should run in parallel.

```sh
broco say auth-fix "Fix the token expiry test." --bg --json
broco say auth-fix "Also cover an expired refresh token." --bg --json
```

## Read the second receipt

| Outcome | What to do |
| --- | --- |
| `injected` | The worker confirmed delivery in the current turn (`codex` app-server or `pi` RPC). Wait for the turn in this receipt. |
| `queued` | The instruction is scheduled for the next turn. Wait for the returned turn before reviewing or accepting. |
| `rejected` | Read the reason. If delivery was uncertain, inspect `broco show auth-fix --all` before retrying so the instruction is not sent twice. |

If the original turn already finished, the second `say` starts the next turn in the same session. If a previous turn failed before binding a native session (`sessionWarning`), use `broco retry auth-fix --bg --json` instead of bare `say` to resend the stored prompt and snapshotted attachments cleanly.

For `claude`, `agy`, `cursor-agent`, and custom templates, follow-ups sent mid-turn always queue for the next turn. Changing `--model` or `--effort` while a turn is running is rejected; wait until the turn finishes.

When reopening a chat, use `broco ls --active --json`, `broco show auth-fix --compact --json`, and `broco wait auth-fix --json` to reattach cleanly.
