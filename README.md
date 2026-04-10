# Meta Code

Meta Code is an unofficial Meta AI terminal coding client with:

- Full-screen interactive UI
- ASCII-art styled terminal interface
- Streaming assistant output
- Slash-command-first workflow (`/help`, `/mode`, `/login`, `/logout`, etc.)
- Live slash command suggestions + Tab autocomplete
- Friendly progress updates with animated status indicators
- Guarded follow-up questions when the agent is truly blocked
- Session persistence
- `think_fast` and `think_hard` modes
- Tool-enabled agent behavior by default for all prompts
- Workspace memory files for persistent project instructions

> [!WARNING]
> Meta Code is in **very early production**. Expect bugs and rough edges.
> If you find an issue, please report it in the GitHub Issues tab:
> https://github.com/spyduck007/MetaCode/issues

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
If the agent gets genuinely blocked, it may ask a single follow-up clarification (multiple choice + custom input or free text), then continue automatically.

## Slash commands (in full-screen mode)

- `/help` — open command help menu with explanations
- `/mode` — open mode picker menu (`think_fast` / `think_hard`)
- `/mode <value>` — set mode directly
- `/login` — browser login flow, auto-saves cookies to config
- `/logout` — clears config cookie for this CLI
- `/auth` — show current auth source and cookie health
- `/new` — start a fresh conversation
- `/sessions` — open session manager (↑/↓ to select, `Enter` to switch, `D` to delete hovered non-active session locally + on Meta; requires auth)
- `/sessions <name>` — switch session directly
- `/sessions delete <name>` — delete a stored session locally + on Meta
- `/status` — show session/mode/auth status
- `/set-cookie <cookie>` — save cookie directly from UI
- `/yolo [on|off|status]` — auto-approve terminal command tool requests
- `/tools` — show available file tools for agent mode
- `/memory` — show loaded workspace instruction files (`META.md`, `.meta-code/instructions.md`, etc.)
- `/clear` — clear on-screen chat history
- `/exit` — quit full-screen mode

Autocomplete tip: start typing `/` commands to open the suggestion list, use Up/Down to choose, and press `Tab` to complete.
Prompt tip: press `Enter` to send, and use `Shift+Enter` for a newline in multiline prompts.

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

## Workspace memory (persistent instructions)

Meta Code auto-loads project instruction files and includes them in every agent run:

- `META.md`
- `METACODE.md`
- `.meta-code.md`
- `.meta-code/instructions.md`
- `.meta-code/memory.md`

Inspect currently loaded memory from CLI:

```bash
meta-code memory show
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
