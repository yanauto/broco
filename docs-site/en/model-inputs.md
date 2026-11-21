# Model capabilities and attachments

Choose a model by what it can actually receive through its CLI. Read `capabilities.input` in `broco roster --json` before attaching media. A value of `true` means the model and `broco`’s current CLI transport both support it; `false` means one side does not; `unknown` means support has not been established. A model’s API modality list alone is not enough.

## Send an attachment

```sh
broco roster --json
broco say visual-check "Describe the layout in this image." --worker codex --model MODEL_FROM_ROSTER --attach ./screen.png --bg --json
broco wait visual-check
broco done visual-check --result pass --why "Layout check complete."
```

Repeat `--attach` for multiple files. Paths are resolved from the sending terminal’s directory (`~/` paths expand automatically). Files are copied into `broco`’s project data before acceptance so queued turns never depend on the original file staying unchanged. Up to 8 attachments are accepted (20 MiB each, 32 MiB total). Follow-ups with attachments queue for the next turn. Unsupported or unknown input capabilities are rejected before dispatch.

## What each transport accepts

| CLI / current transport | Delivery and limits |
| --- | --- |
| `claude` print / stream-json | Passes prompts over `stdin` and supports `text`, `image`, and `pdf` attachments via `--add-dir` and the `Read` tool (rejects `audio` and `video`). |
| Codex app-server | Sends images as `localImage` input blocks and supports `localAudio` when the selected model reports audio support. `codex exec` fallback uses repeated `--image` and rejects audio instead of dropping it. |
| `agy` stdin / stream-json | Passes prompts via `stdin` and supports all five input modalities (`text`, `image`, `audio`, `video`, `pdf`) when supported by the selected model. Use only with a Gemini API key or Enterprise / Google Cloud project ([warning](../workers/#agy)). |
| `pi` RPC | Sends `images` content blocks (`type`, base64 `data`, `mimeType`). Its `input`, `contextWindow`, and `maxTokens` fields supply exact metadata without parsing rounded tables. |
| `cursor-agent` print | No direct media attachment flag is documented for the headless print adapter; media input remains `unknown` and explicit attachments are rejected. |
| `custom:<name>` templates | Templates pass text arguments or `stdin`; explicit media attachments remain `unknown` and are rejected. |

[Official OpenAI app-server input documentation](https://developers.openai.com/codex/app-server), [pi RPC documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md), [agy headless input](https://antigravity.google/docs/cli/headless), [Cursor CLI parameters](https://cursor.com/docs/cli/reference/parameters), [Gemini file tools](https://geminicli.com/docs/tools/file-system/), [OpenCode CLI](https://opencode.ai/docs/cli/).

## Limits and descriptions

Use `broco roster --worker WORKER --json --full` for token limits and their sources. Compact output keeps `capabilities.input`; when grouped variants disagree, it reports `unknown` until you inspect the exact variant.

CLI-reported limits take precedence over the catalog. Values sourced only from the catalog are marked `catalog-api-limit` (an API ceiling, not a subscription guarantee). Missing values remain `unknown`. See [the roster](roster.md) for local `~/.broco/models.json` overrides.
