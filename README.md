# Meta Code

Meta Code is an unofficial Meta AI terminal coding client with:

- Full-screen interactive UI
- ASCII-art styled terminal interface
- Streaming assistant output
- Slash-command-first workflow (`/help`, `/mode`, `/login`, `/logout`, etc.)
- Live slash command suggestions + Tab autocomplete
- Friendly progress updates with animated status indicators
- Session persistence
- `think_fast` and `think_hard` modes
- Tool-enabled agent behavior by default for all prompts

## Install

```bash
npm install
npm link
```

After `npm link`, run the CLI as:

```bash
meta-code
```

(`meta` and `metacode` aliases also work.)

## Quick start

Full-screen mode:

```bash
meta-code
```

Each full-screen launch starts a fresh chat session by default. To reuse one, pass `--session <name>`.

One-shot mode:

```bash
meta-code -m think_fast "Write a Python quicksort"
meta-code --json -m think_hard "Design a migration strategy"
meta-code --yolo "Create a starter React app in this folder"
```

All prompts automatically run through the file-tool agent runtime.

## Slash commands (in full-screen mode)

- `/help` — open command help menu with explanations
- `/mode` — open mode picker menu (`think_fast` / `think_hard`)
- `/mode <value>` — set mode directly
- `/login` — browser login flow, auto-saves cookies to config
- `/logout` — clears config cookie for this CLI
- `/auth` — show current auth source and cookie health
- `/new` — start a fresh conversation
- `/sessions` — open session manager (↑/↓ to select, `Enter` to switch, `D` to delete hovered session)
- `/sessions <name>` — switch session directly
- `/sessions delete <name>` — delete a stored local session
- `/status` — show session/mode/auth status
- `/set-cookie <cookie>` — save cookie directly from UI
- `/yolo [on|off|status]` — auto-approve terminal command tool requests
- `/tools` — show available file tools for agent mode
- `/clear` — clear on-screen chat history
- `/exit` — quit full-screen mode

Autocomplete tip: start typing `/` commands to open the suggestion list, use Up/Down to choose, and press `Tab` to complete.

## CLI auth commands

```bash
meta-code auth status
meta-code auth login
meta-code auth set-cookie "datr=...; rd_challenge=...; ecto_1_sess=..."
meta-code auth clear
```

If browser login cannot launch initially:

```bash
npx playwright install chromium
```

## Config commands

```bash
meta-code config show
meta-code config set-mode think_hard
```

## Session commands

```bash
meta-code sessions list
meta-code sessions reset
meta-code sessions delete default
```

## Agent file tools

The built-in agent can call these workspace-scoped tools:

- `list_dir`
- `read_file`
- `write_file`
- `append_file`
- `edit_file`
- `delete_path`
- `mkdir`
- `move_path`
- `search_files`
- `stat_path`
- `run_command` (prompts for approval unless yolo is enabled)

CLI command:

```bash
meta-code tools list
```

## Auth resolution order

1. `META_AI_COOKIE` environment variable
2. Saved config cookie (`meta-code auth set-cookie ...` or `/login`)

## GitHub publishing notes

- Includes MIT `LICENSE`
- Includes CI workflow at `.github/workflows/ci.yml` (runs `npm test`)
- Includes `.gitignore` for Node and macOS files
- Publishing check: `npm pack --dry-run`

## Tests

```bash
npm test
```
