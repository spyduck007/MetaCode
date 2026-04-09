const THINKING_PHRASES = [
  "understanding the meaning of life",
  "untangling your request",
  "mapping the codebase mentally",
  "lining up the cleanest approach",
  "making a tiny plan before coding",
  "double-checking edge cases",
  "gathering clues from project files",
  "brewing a surprisingly good solution",
];

export const SPINNER_FRAMES = ["|", "/", "-", "\\"];

export function pickThinkingPhrase(previous = "") {
  if (THINKING_PHRASES.length === 1) return THINKING_PHRASES[0];
  let choice = THINKING_PHRASES[Math.floor(Math.random() * THINKING_PHRASES.length)];
  if (choice === previous) {
    choice = THINKING_PHRASES[(THINKING_PHRASES.indexOf(choice) + 1) % THINKING_PHRASES.length];
  }
  return choice;
}

function getArgPreview(args, key) {
  const value = args?.[key];
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.length > 42 ? `${trimmed.slice(0, 39)}...` : trimmed;
}

export function describeToolCallFriendly(call) {
  const name = call?.name ?? "";
  const args = call?.arguments ?? {};
  const path = getArgPreview(args, "path");
  const from = getArgPreview(args, "from");
  const to = getArgPreview(args, "to");
  const query = getArgPreview(args, "query");
  const command = getArgPreview(args, "command");

  switch (name) {
    case "list_dir":
      return path ? `checking folders in ${path}` : "checking project folders";
    case "read_file":
      return path ? `reading ${path}` : "reading a file";
    case "write_file":
      return path ? `creating/updating ${path}` : "writing file content";
    case "append_file":
      return path ? `adding content to ${path}` : "adding content to a file";
    case "edit_file":
      return path ? `editing ${path}` : "editing a file";
    case "delete_path":
      return path ? `removing ${path}` : "removing a file";
    case "mkdir":
      return path ? `creating folder ${path}` : "creating a folder";
    case "move_path":
      if (from && to) return `moving ${from} -> ${to}`;
      return "moving files";
    case "search_files":
      if (query) return `searching for "${query}"`;
      return "searching across files";
    case "stat_path":
      return path ? `checking details for ${path}` : "checking file details";
    case "run_command":
      return command ? `running "${command}"` : "running a terminal command";
    default:
      return "using a file tool";
  }
}

export function describeAgentStatusFriendly(statusText) {
  const text = String(statusText || "").trim();
  if (!text) return "working";
  if (text.startsWith("step ")) return "working through steps";
  if (text === "format correction") return "reformatting response";
  if (text === "unsticking loop") return "trying a different approach";
  if (text === "autonomous execution") return "starting from scratch automatically";
  if (text === "awaiting user follow-up") return "waiting for your input";
  if (text === "continuing without follow-up") return "continuing with assumptions";
  if (text === "finalizing") return "finalizing answer";
  return text;
}
