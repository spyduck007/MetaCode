export const SLASH_COMMAND_DEFINITIONS = [
  {
    name: "help",
    usage: "/help",
    description: "Show command menu with descriptions.",
  },
  {
    name: "mode",
    usage: "/mode [fast|hard|think_fast|think_hard]",
    description: "Set model mode. Run /mode with no args to open mode picker menu.",
  },
  {
    name: "max-steps",
    usage: "/max-steps [count|status]",
    description: "Set max agent steps for this TUI session.",
  },
  {
    name: "login",
    usage: "/login",
    description: "Open browser login flow and save cookies automatically.",
  },
  {
    name: "logout",
    usage: "/logout",
    description: "Remove config cookie from this CLI (server session may remain active).",
  },
  {
    name: "set-cookie",
    usage: "/set-cookie <cookie>",
    description: "Save a raw cookie string directly from inside the TUI.",
  },
  {
    name: "yolo",
    usage: "/yolo [on|off|status]",
    description: "Auto-approve command execution tool requests.",
  },
  {
    name: "tools",
    usage: "/tools",
    description: "Show available built-in file tools for agent mode.",
  },
  {
    name: "memory",
    usage: "/memory",
    description: "Show workspace instruction files used to steer the agent.",
  },
  {
    name: "auth",
    usage: "/auth",
    description: "Show current auth source and cookie health.",
  },
  {
    name: "doctor",
    usage: "/doctor",
    description: "Run quick diagnostics for auth/config/workspace health.",
  },
  {
    name: "new",
    usage: "/new",
    description: "Start a fresh conversation in the current session.",
  },
  {
    name: "retry",
    usage: "/retry",
    description: "Retry the last non-slash prompt in the current session.",
  },
  {
    name: "sessions",
    usage: "/sessions [name|delete <name>]",
    description: "Open session manager. Enter switches; D deletes highlighted session.",
  },
  {
    name: "status",
    usage: "/status",
    description: "Show active session, mode, and auth info.",
  },
  {
    name: "clear",
    usage: "/clear",
    description: "Clear messages from the current terminal view.",
  },
  {
    name: "history",
    usage: "/history",
    description: "Show full scrollable conversation history in a modal.",
  },
  {
    name: "export",
    usage: "/export [filename]",
    description: "Export conversation to a markdown file (defaults to metacode-export-<timestamp>.md).",
  },
  {
    name: "compact",
    usage: "/compact",
    description: "Summarize and compact the current conversation context to save space.",
  },
  {
    name: "agent",
    usage: "/agent [on|off|status]",
    description: "Toggle agent mode (file tools). Off = plain chat. Default: on.",
  },
  {
    name: "diff",
    usage: "/diff",
    description: "Show files touched by the last agent run.",
  },
  {
    name: "usage",
    usage: "/usage",
    description: "Show quick stats for the current session (messages, steps, touched files).",
  },
  {
    name: "pin",
    usage: "/pin [text]",
    description:
      "Pin persistent context that is prepended to every agent task this session. Run without args to view or clear pinned text.",
  },
  {
    name: "undo",
    usage: "/undo",
    description: "Undo the last file write/edit/delete performed by the agent this session.",
  },
  {
    name: "exit",
    usage: "/exit",
    description: "Exit the full-screen interface.",
  },
];

export function parseSlashCommand(input) {
  const value = input?.trim();
  if (!value || !value.startsWith("/")) {
    return null;
  }

  const tokens = value.slice(1).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return null;
  }

  return {
    name: tokens[0].toLowerCase(),
    args: tokens.slice(1),
    raw: value,
  };
}

export function formatSlashHelpLines() {
  return SLASH_COMMAND_DEFINITIONS.map((entry) => `${entry.usage} — ${entry.description}`);
}

export function getSlashSuggestions(input, limit = 5) {
  const value = input?.trim();
  if (!value || !value.startsWith("/")) {
    return [];
  }

  const body = value.slice(1);
  if (!body) {
    return SLASH_COMMAND_DEFINITIONS.slice(0, limit).map((entry) => ({
      ...entry,
      completion: `/${entry.name} `,
    }));
  }

  const [typedCommand, ...rest] = body.split(/\s+/);
  if (rest.length > 0) {
    return [];
  }

  const normalized = typedCommand.toLowerCase();
  return SLASH_COMMAND_DEFINITIONS.filter((entry) => entry.name.startsWith(normalized))
    .slice(0, limit)
    .map((entry) => ({
      ...entry,
      completion: `/${entry.name} `,
    }));
}

export function completeSlashCommand(input, suggestions) {
  const value = input ?? "";
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.includes(" ")) {
    return null;
  }
  if (!suggestions?.length) {
    return null;
  }
  return suggestions[0].completion;
}
