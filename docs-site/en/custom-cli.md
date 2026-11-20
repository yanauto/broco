# Custom CLI templates

A CLI needs a non-interactive new-session command, resume by explicit session ID, and a machine-readable final reply and ID. Register it as `custom:name` in [Settings](settings.md). Gemini CLI and OpenCode presets are editable starting points, not prevalidated built-ins — install and sign in through the CLI first, then adapt the preset to your installed version.

A template uses an executable and JSON arrays of arguments. `broco` spawns the executable directly without a shell, so spaces, quotes, and shell characters stay safe. Placeholders are `{prompt}`, `{session}`, `{model}`, `{effort}`, and `{cwd}`.

```json
{
  "command": "my-agent",
  "newArgs": ["--json", "--prompt", "{prompt}"],
  "resumeArgs": ["--json", "--resume", "{session}", "--prompt", "{prompt}"],
  "modelArgs": ["--model", "{model}"],
  "effortArgs": ["--effort", "{effort}"],
  "stdin": "",
  "format": "json",
  "reply": {"path": "reply"},
  "session": {"path": "session_id"}
}
```

`modelArgs` and `effortArgs` are optional and appended only when selected. For `stdin`-based input (recommended so prompts stay out of `ps`), set `"stdin": "{prompt}"`. Both new and resume commands must receive the prompt, and resume must include `{session}`.

For `jsonl`, extract the latest matching event using dotted paths and optional equality conditions (`when`). For `text`, use `{"regex":"Reply: (.+)"}` and `{"regex":"Session: (.+)"}`; the first capture group supplies each value. Nonzero exit, malformed output, or a changed session ID fails the turn.

## Mandatory two-turn trial

**Test new session + resume** runs two real calls in a temporary directory under `$BROCO_HOME`, asks the CLI not to invoke tools, and verifies that the second turn recalls a random code from the first with an unchanged session ID. A passing trial authorizes saving that exact template for 15 minutes; any edit requires a fresh trial.

Custom workers are labeled **Degraded**. They support named session continuation, queued follow-ups, `stop`, git worktrees, `diff`, and cross-vendor reviews, while omitting native step streams, mid-turn steering, and cache readouts. Secret redaction applies before persisting output.

Optional `versionArgs` and `actions` (`login`, `install`, `upgrade`) let `broco` report versions and open official commands explicitly. Never embed credentials in templates.
