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
    name: "auth",
    usage: "/auth",
    description: "Show current auth source and cookie health.",
  },
  {
    name: "new",
    usage: "/new",
    description: "Start a fresh conversation in the current session.",
  },
  {
    name: "session",
    usage: "/session [name]",
    description: "Switch session. With no args, opens session picker menu.",
  },
  {
    name: "sessions",
    usage: "/sessions",
    description: "List known local sessions.",
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
