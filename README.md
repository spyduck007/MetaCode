# Meta Code

Meta Code is an unofficial Meta AI terminal coding client with:

- Full-screen interactive UI
- ASCII-art styled terminal interface
- Streaming assistant output
- Slash-command-first workflow (`/help`, `/mode`, `/login`, `/logout`, etc.)
- Live slash command suggestions + Tab autocomplete
- **Input history** — navigate previous prompts with ↑/↓ arrows in the input box
- Friendly progress updates with animated status indicators
- Guarded follow-up questions when the agent is truly blocked
- Session persistence
- `think_fast` and `think_hard` modes
- Tool-enabled agent behavior by default for all prompts
- **Agent/plain-chat toggle** — switch between agent mode (file tools) and plain chat
- Workspace memory files for persistent project instructions
- **Network auto-retry** — transparently retries on transient network/server errors (5xx, ECONNRESET, etc.)

> [!WARNING]
> Meta Code is in **early production**. Expect bugs and rough edges.
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

## First-time setup

Run the interactive setup wizard to configure your defaults:

```bash
meta-code config init
```

Then authenticate:

```bash
meta-code auth login
```

## Quick start

Full-screen mode:

```bash
meta-code
```

Each full-screen launch starts a fresh chat session by default. To reuse one, pass `--session <name>`.

One-shot mode:

```bash
meta-code -m think_fast "Write a Python quicksort"
meta-code --max-steps 40 "Implement and test an LRU cache"
meta-code --json -m think_hard "Design a migration strategy"
meta-code --yolo "Create a starter React app in this folder"
```

All prompts automatically run through the file-tool agent runtime.
If the agent gets genuinely blocked, it may ask a single follow-up clarification (multiple choice + custom input or free text), then continue automatically.

## Slash commands (in full-screen mode)

### Conversation

- `/help` — open command help menu with explanations
- `/history` — show full scrollable conversation history in a modal
- `/export [filename]` — export conversation to a markdown file (default: `metacode-export-<timestamp>.md`)
- `/compact` — summarize and trim conversation context to free up space
- `/clear` — clear on-screen chat history
- `/retry` — retry the last non-slash prompt
- `/new` — start a fresh conversation
- `/exit` — quit full-screen mode

### Agent & mode

- `/agent [on|off|status]` — toggle between agent mode (file tools) and plain chat
- `/mode` — open mode picker menu (`think_fast` / `think_hard`)
- `/mode <value>` — set mode directly
- `/max-steps [count|status]` — tune autonomous step budget for this TUI session
- `/yolo [on|off|status]` — auto-approve terminal command tool requests
- `/diff` — show files touched by the last agent run
- `/tools` — show available file tools for agent mode

### Sessions

- `/sessions` — open session manager (↑/↓ to select, `Enter` to switch, `D` to delete; requires auth)
- `/sessions <name>` — switch session directly
- `/sessions delete <name>` — delete a stored session locally + on Meta

### Auth & config

- `/login` — browser login flow, auto-saves cookies to config
- `/logout` — clears config cookie for this CLI
- `/auth` — show current auth source and cookie health
- `/status` — show session/mode/auth/agent status
- `/set-cookie <cookie>` — save cookie directly from UI
- `/doctor` — run quick diagnostics (auth/config/workspace/memory health)
- `/memory` — show loaded workspace instruction files (`META.md`, `.meta-code/instructions.md`, etc.)

**Autocomplete tip:** start typing `/` to open the suggestion list, use Up/Down to choose, and press `Tab` to complete.

**Prompt tip:** press `Enter` to send. Use `Shift+Enter` for newlines in multiline prompts.

**Input history:** press `↑` when the suggestion list is not open to navigate through previous prompts, press `↓` to go forward.

## CLI auth commands

```bash
meta-code auth status
meta-code auth login
meta-code auth set-cookie "datr=...; rd_challenge=...; ecto_1_sess=..."
meta-code auth clear
meta-code doctor
```

If browser login cannot launch initially:

```bash
npx playwright install chromium
```

## Config commands

```bash
meta-code config init            # first-time setup wizard
meta-code config show
meta-code config set-mode think_hard
meta-code config set-max-steps 40
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

Run `/doctor` in the TUI to check if your workspace memory file is detected.

## Session commands

```bash
meta-code sessions list
meta-code sessions reset
meta-code sessions delete default
```

## Agent file tools

The built-in agent can call these workspace-scoped tools:

| Tool | Description |
|------|-------------|
| `list_dir` | List files/directories recursively |
| `read_file` | Read a UTF-8 text file with optional line range |
| `write_file` | Write full file content |
| `append_file` | Append text to a file |
| `edit_file` | Replace occurrences of oldText in a file |
| `delete_path` | Delete a file or directory |
| `mkdir` | Create a directory |
| `move_path` | Rename/move a file or directory |
| `search_files` | Search text across files (regex supported) |
| `glob_files` | Find files by glob pattern (`**/*.ts`, `src/*.{js,ts}`, `?.txt`) |
| `patch_file` | Apply a unified-diff patch string to a file |
| `stat_path` | Get file/directory metadata |
| `run_command` | Run a shell command (requires approval unless yolo) |

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
