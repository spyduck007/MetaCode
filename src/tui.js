import blessed from "blessed";
import { normalizeMode } from "./meta-client.js";
import {
  completeSlashCommand,
  formatSlashHelpLines,
  getSlashSuggestions,
  parseSlashCommand,
} from "./slash-commands.js";
import { formatToolDefinitionsForPrompt } from "./file-tools.js";
import {
  SPINNER_FRAMES,
  describeAgentStatusFriendly,
  describeToolCallFriendly,
  pickThinkingPhrase,
} from "./progress-ui.js";
import { loadWorkspaceMemory, WORKSPACE_MEMORY_FILES } from "./workspace-memory.js";
import {
  DEFAULT_AGENT_STEPS,
  normalizeAgentSteps,
} from "./max-steps.js";
import { runDoctor } from "./doctor.js";
import { exportConversationToFile } from "./export-conversation.js";

const MAX_MESSAGES = 250;
const STATUS_HEIGHT = 1;
const INPUT_HEIGHT = 5;
const AUTOCOMPLETE_LIST_MAX = 6;

const TITLE_ART_LINES = [
  " __  __      _          ____          _      ",
  "|  \\/  | ___| |_ __ _  / ___|___   __| | ___ ",
  "| |\\/| |/ _ \\ __/ _` | | |   / _ \\ / _` |/ _ \\",
  "| |  | |  __/ || (_| | | |__| (_) | (_| |  __/",
  "|_|  |_|\\___|\\__\\__,_|  \\____\\___/ \\__,_|\\___|",
];

function escapeTags(text) {
  return String(text).replaceAll("{", "\\{").replaceAll("}", "\\}");
}

export function shouldSubmitPromptOnEnter(ch, key = {}, { rapidInputBurst = false } = {}) {
  if (key.name !== "enter" || key.shift || key.ctrl || key.meta) return false;
  if (rapidInputBurst) return false;

  // Regular Enter keypress emits carriage return. Pasted multiline content
  // typically carries line-feed newlines, which should stay in the textarea.
  if (typeof key.sequence === "string" && key.sequence !== "\r") return false;
  if (ch === "\n") return false;
  return true;
}

function trimMessageHistory(messages) {
  if (messages.length > MAX_MESSAGES) {
    messages.splice(0, messages.length - MAX_MESSAGES);
  }
}

function formatAuthSummary(authSummary) {
  return `source=${authSummary.source}, session_cookie=${authSummary.hasSession}, cookie=${authSummary.redacted}`;
}

function formatWorkspaceMemoryLines(memory) {
  if (!memory?.sources?.length) {
    return [
      "No workspace instruction files found.",
      "",
      `Checked: ${WORKSPACE_MEMORY_FILES.join(", ")}`,
      "",
      "Create one of these files to add persistent project instructions.",
    ];
  }

  return [
    `Loaded from: ${memory.sources.join(", ")}`,
    ...(memory.truncated ? ["(memory content truncated for safety)", ""] : [""]),
    ...memory.text.split("\n"),
  ];
}

function formatDoctorLines(report) {
  return report.checks.map((check) => {
    const prefix = check.status === "ok" ? "OK" : check.status === "warn" ? "WARN" : "ERROR";
    return `${prefix} ${check.name}: ${check.detail}`;
  });
}

function formatMessages(messages) {
  if (messages.length === 0) {
    return "{gray-fg}No messages yet. Type a prompt or /help.{/}";
  }

  return messages
    .map((message) => {
      if (message.role === "banner") {
        return `{magenta-fg}${escapeTags(message.text)}{/}`;
      }
      const roleTag =
        message.role === "assistant"
          ? "{green-fg}{bold}assistant{/bold}{/}"
          : message.role === "user"
            ? "{cyan-fg}{bold}you{/bold}{/}"
            : message.role === "error"
              ? "{red-fg}{bold}error{/bold}{/}"
              : "{yellow-fg}{bold}system{/bold}{/}";
      return `${roleTag}: ${escapeTags(message.text)}`;
    })
    .join("\n\n");
}

function showInfoModal(screen, title, lines) {
  return new Promise((resolve) => {
    const box = blessed.box({
      parent: screen,
      top: "center",
      left: "center",
      width: "86%",
      height: "74%",
      border: "line",
      label: ` ${title} `,
      keys: true,
      mouse: true,
      tags: true,
      padding: { left: 1, right: 1, top: 1, bottom: 1 },
      style: {
        border: { fg: "magenta" },
        bg: "black",
      },
      content: `${lines.map((line) => escapeTags(line)).join("\n")}\n\nPress Esc/Enter to close.`,
      scrollable: true,
      alwaysScroll: true,
      scrollbar: {
        ch: " ",
        inverse: true,
      },
    });

    const close = () => {
      box.detach();
      screen.render();
      resolve();
    };

    box.key(["escape", "enter", "q"], close);
    box.focus();
    screen.render();
  });
}

function showSelectionMenu(screen, title, items) {
  return new Promise((resolve) => {
    const menuHeight = Math.max(9, Math.min(18, items.length + 6));

    const wrapper = blessed.box({
      parent: screen,
      top: "center",
      left: "center",
      width: "62%",
      height: menuHeight,
      border: "line",
      label: ` ${title} `,
      tags: true,
      style: {
        border: { fg: "cyan" },
        bg: "black",
      },
    });

    const helpLine = blessed.box({
      parent: wrapper,
      top: 0,
      left: 0,
      width: "100%-3",
      height: 1,
      tags: true,
      content: "{gray-fg}↑/↓ move • Enter select • Esc cancel{/}",
    });

    const list = blessed.list({
      parent: wrapper,
      top: 1,
      left: 0,
      width: "100%-3",
      height: "100%-3",
      keys: true,
      mouse: true,
      vi: true,
      tags: true,
      style: {
        item: {
          fg: "white",
          bg: "black",
        },
        fg: "white",
        bg: "black",
        selected: {
          bg: "magenta",
          fg: "white",
          bold: true,
        },
      },
      items: items.map((item) => item.label),
    });

    const close = (value) => {
      wrapper.detach();
      screen.render();
      resolve(value);
    };

    list.on("select", (_, index) => close(items[index].value));
    list.key(["escape", "q"], () => close(null));
    list.key(["enter"], () => {
      const index = typeof list.selected === "number" ? list.selected : 0;
      close(items[index]?.value ?? null);
    });
    wrapper.setFront();
    list.focus();
    list.select(0);
    screen.render();
  });
}

function showSessionsListMenu(screen, sessionsInfo) {
  return new Promise((resolve) => {
    const entries = Object.entries(sessionsInfo.sessions).sort(([, a], [, b]) =>
      String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""))
    );
    const listItems = [
      ...entries.map(([name, details]) => ({
        type: "session",
        name,
        label: `${name}${sessionsInfo.activeSession === name ? " [active]" : ""}  mode=${details.mode}`,
      })),
      { type: "create", label: "+ Create new session" },
      { type: "cancel", label: "Cancel" },
    ];

    const menuHeight = Math.max(10, Math.min(20, listItems.length + 5));
    const wrapper = blessed.box({
      parent: screen,
      top: "center",
      left: "center",
      width: "72%",
      height: menuHeight,
      border: "line",
      label: " Sessions ",
      tags: true,
      style: {
        border: { fg: "cyan" },
        bg: "black",
      },
    });

    blessed.box({
      parent: wrapper,
      top: 0,
      left: 0,
      width: "100%-3",
      height: 1,
      tags: true,
      content: "{gray-fg}↑/↓ navigate • Enter switch/create • D delete • Esc close{/}",
    });

    const list = blessed.list({
      parent: wrapper,
      top: 1,
      left: 0,
      width: "100%-3",
      height: "100%-3",
      keys: true,
      mouse: true,
      vi: true,
      tags: true,
      style: {
        item: { fg: "white", bg: "black" },
        fg: "white",
        bg: "black",
        selected: {
          bg: "magenta",
          fg: "white",
          bold: true,
        },
      },
      items: listItems.map((entry) => entry.label),
    });

    const close = (value) => {
      wrapper.detach();
      screen.render();
      resolve(value);
    };

    list.key(["escape", "q"], () => close({ action: "cancel" }));
    list.key(["d", "D"], () => {
      const index = typeof list.selected === "number" ? list.selected : 0;
      const item = listItems[index];
      if (item?.type !== "session") return;
      close({ action: "delete", name: item.name });
    });
    list.on("select", (_, index) => {
      const item = listItems[index];
      if (!item) return close({ action: "cancel" });
      if (item.type === "session") {
        close({ action: "switch", name: item.name });
        return;
      }
      if (item.type === "create") {
        close({ action: "create" });
        return;
      }
      close({ action: "cancel" });
    });

    wrapper.setFront();
    list.focus();
    list.select(0);
    screen.render();
  });
}

function showCommandApprovalMenu(screen, { command, cwd }) {
  return new Promise((resolve) => {
    const wrapper = blessed.box({
      parent: screen,
      top: "center",
      left: "center",
      width: "82%",
      height: "60%",
      border: "line",
      label: " Approve command execution? ",
      tags: true,
      style: {
        border: { fg: "yellow" },
        bg: "black",
      },
    });

    const info = blessed.box({
      parent: wrapper,
      top: 0,
      left: 0,
      width: "100%-3",
      height: 7,
      tags: true,
      content: [
        "{bold}The agent wants to run this command:{/bold}",
        "",
        escapeTags(command),
        "",
        `{gray-fg}cwd: ${escapeTags(cwd)}{/}`,
      ].join("\n"),
    });

    const list = blessed.list({
      parent: wrapper,
      top: 8,
      left: 0,
      width: "100%-3",
      height: "100%-10",
      keys: true,
      mouse: true,
      vi: true,
      style: {
        item: {
          fg: "white",
          bg: "black",
        },
        fg: "white",
        bg: "black",
        selected: {
          bg: "yellow",
          fg: "black",
          bold: true,
        },
      },
      items: [
        "Approve once (Recommended)",
        "Deny this command",
        "Always allow commands (/yolo on)",
      ],
    });

    const close = (value) => {
      wrapper.detach();
      screen.render();
      resolve(value);
    };

    list.on("select", (_, index) => {
      if (index === 0) close("once");
      else if (index === 1) close("deny");
      else close("always");
    });
    list.key(["escape", "q"], () => close("deny"));
    list.focus();
    list.select(0);
    screen.render();
  });
}

function showTextInputMenu(screen, { title, question }) {
  return new Promise((resolve) => {
    const wrapper = blessed.box({
      parent: screen,
      top: "center",
      left: "center",
      width: "78%",
      height: 12,
      border: "line",
      label: ` ${title} `,
      tags: true,
      style: {
        border: { fg: "cyan" },
        bg: "black",
      },
    });

    blessed.box({
      parent: wrapper,
      top: 0,
      left: 0,
      width: "100%-3",
      height: 3,
      tags: true,
      content: escapeTags(question),
    });

    const input = blessed.textbox({
      parent: wrapper,
      top: 3,
      left: 0,
      width: "100%-3",
      height: 3,
      border: "line",
      inputOnFocus: true,
      keys: true,
      mouse: true,
      vi: true,
      padding: { left: 1, right: 1 },
      style: {
        border: { fg: "yellow" },
        focus: {
          border: { fg: "magenta" },
        },
      },
    });

    blessed.box({
      parent: wrapper,
      top: 7,
      left: 0,
      width: "100%-3",
      height: 1,
      tags: true,
      content: "{gray-fg}Enter submit • Esc cancel{/}",
    });

    const close = (value) => {
      wrapper.detach();
      screen.render();
      resolve(value);
    };

    input.on("submit", (value) => {
      const normalized = String(value || "").trim();
      close(normalized || null);
    });
    input.key(["escape"], () => close(null));
    wrapper.key(["escape"], () => close(null));
    wrapper.setFront();
    input.focus();
    screen.render();
  });
}

async function showFollowUpQuestionMenu(screen, { question, choices, allowFreeform = true }) {
  const normalizedQuestion = String(question || "").trim();
  const normalizedChoices = Array.isArray(choices)
    ? choices
        .map((choice) => String(choice ?? "").trim())
        .filter(Boolean)
        .slice(0, 8)
    : [];

  if (normalizedChoices.length === 0) {
    return showTextInputMenu(screen, {
      title: "Agent needs clarification",
      question: normalizedQuestion || "Please provide guidance:",
    });
  }

  return new Promise((resolve) => {
    const choiceRows = normalizedChoices.length + (allowFreeform ? 1 : 0) + 1;
    const menuHeight = Math.max(12, Math.min(24, choiceRows + 8));
    const entries = [
      ...normalizedChoices.map((choice) => ({ label: choice, value: choice })),
      ...(allowFreeform ? [{ label: "Provide custom answer...", value: "__custom__" }] : []),
      { label: "Cancel", value: "__cancel__" },
    ];

    const wrapper = blessed.box({
      parent: screen,
      top: "center",
      left: "center",
      width: "82%",
      height: menuHeight,
      border: "line",
      label: " Agent follow-up ",
      tags: true,
      style: {
        border: { fg: "cyan" },
        bg: "black",
      },
    });

    blessed.box({
      parent: wrapper,
      top: 0,
      left: 0,
      width: "100%-3",
      height: 3,
      tags: true,
      content: escapeTags(normalizedQuestion),
    });

    const list = blessed.list({
      parent: wrapper,
      top: 3,
      left: 0,
      width: "100%-3",
      height: "100%-5",
      keys: true,
      mouse: true,
      vi: true,
      style: {
        item: { fg: "white", bg: "black" },
        fg: "white",
        bg: "black",
        selected: {
          bg: "magenta",
          fg: "white",
          bold: true,
        },
      },
      items: entries.map((entry) => entry.label),
    });

    const close = (value) => {
      wrapper.detach();
      screen.render();
      resolve(value);
    };

    list.key(["escape", "q"], () => close(null));
    list.on("select", async (_item, index) => {
      const selected = entries[index];
      if (!selected || selected.value === "__cancel__") {
        close(null);
        return;
      }
      if (selected.value === "__custom__") {
        wrapper.detach();
        screen.render();
        const custom = await showTextInputMenu(screen, {
          title: "Custom clarification",
          question: normalizedQuestion,
        });
        resolve(custom);
        return;
      }
      close(selected.value);
    });

    wrapper.setFront();
    list.focus();
    list.select(0);
    screen.render();
  });
}

function buildBannerMessage() {
  return [
    ...TITLE_ART_LINES,
    "Meta Code • full-screen coding agent",
    "Type /help for commands. Tab autocompletes slash commands.",
  ].join("\n");
}

export async function startTui({
  client,
  sessionName,
  session,
  saveSession,
  loadSession,
  listSessions,
  deleteSessionState,
  createSessionName,
  resetSessionState,
  getAuthSummary,
  login,
  logout,
  setCookie,
  initialSystemMessage = null,
  defaultMaxSteps = DEFAULT_AGENT_STEPS,
  runAgentTask,
}) {
  let currentClient = client;
  let currentSessionName = sessionName;
  let currentSession = { ...session };
  let currentAuth = await getAuthSummary();
  const messages = [
    {
      role: "banner",
      text: buildBannerMessage(),
    },
    {
      role: "system",
      text: "Welcome to Meta Code. Every prompt runs as a tool-enabled coding agent. Use /help for commands.",
    },
    ...(initialSystemMessage ? [{ role: "system", text: initialSystemMessage }] : []),
  ];
  let currentSuggestions = [];
  let suggestionSelectedIndex = 0;

  const program = blessed.program({
    input: process.stdin,
    output: process.stdout,
    terminal: process.env.TERM,
    forceUnicode: true,
    tput: true,
    extended: false,
  });

  const screen = blessed.screen({
    program,
    smartCSR: true,
    fullUnicode: true,
    title: "Meta Code",
    dockBorders: true,
  });

  const chatBox = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: "100%",
    height: `100%-${STATUS_HEIGHT + INPUT_HEIGHT}`,
    border: "line",
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    vi: true,
    mouse: true,
    label: " Conversation ",
    style: {
      border: { fg: "cyan" },
    },
    padding: { left: 1, right: 1, top: 0, bottom: 0 },
  });

  const statusBar = blessed.box({
    parent: screen,
    bottom: INPUT_HEIGHT,
    left: 0,
    width: "100%",
    height: STATUS_HEIGHT,
    tags: true,
    style: {
      fg: "white",
      bg: "default",
      bold: false,
    },
  });

  const suggestionList = blessed.list({
    parent: screen,
    bottom: INPUT_HEIGHT + STATUS_HEIGHT,
    left: 0,
    width: "100%",
    height: AUTOCOMPLETE_LIST_MAX + 2,
    border: "line",
    label: " Suggestions ",
    hidden: true,
    keys: true,
    mouse: true,
    vi: true,
    tags: true,
    style: {
      fg: "white",
      bg: "black",
      border: { fg: "blue" },
      selected: {
        bg: "blue",
        fg: "white",
        bold: true,
      },
    },
  });

  const inputBox = blessed.textarea({
    parent: screen,
    bottom: 0,
    left: 0,
    width: "100%",
    height: INPUT_HEIGHT,
    border: "line",
    inputOnFocus: true,
    keys: true,
    mouse: true,
    vi: true,
    scrollable: true,
    alwaysScroll: true,
    label: " Prompt (Enter send • Shift+Enter newline) ",
    style: {
      border: { fg: "yellow" },
      focus: {
        border: { fg: "magenta" },
      },
    },
    padding: { left: 1, right: 1 },
  });

  const defaultInputListener = inputBox._listener.bind(inputBox);
  let lastInputKeyTs = 0;
  inputBox._listener = function patchedInputListener(ch, key = {}) {
    const now = Date.now();
    const rapidInputBurst = lastInputKeyTs > 0 && now - lastInputKeyTs <= 12;
    lastInputKeyTs = now;

    if (shouldSubmitPromptOnEnter(ch, key, { rapidInputBurst })) {
      this._done?.(null, this.value);
      return;
    }
    return defaultInputListener(ch, key);
  };

  let busy = false;
  let resolving = false;
  let followOutput = true;
  let statusLabel = "ready";
  let spinnerIndex = 0;
  let spinnerTimer = null;
  let lastProgressText = "";
  let lastProgressTs = 0;
  let yoloMode = false;
  let agentMode = true;
  let currentMaxSteps = normalizeAgentSteps(defaultMaxSteps);
  let lastUserPrompt = "";
  let liveProgressMessage = null;
  let liveProgressBaseText = "";
  const chattedSessions = new Set();
  // Input history: store submitted prompts, navigate with ↑/↓ when no suggestions visible
  const inputHistory = [];
  let inputHistoryIndex = -1;
  let inputHistorySavedDraft = "";
  // Track files touched by the last agent run for /diff
  let lastRunTouchedFiles = [];

  function renderStatusBar() {
    const spinner = busy ? SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length] : ">";
    const activity = busy ? `working · ${statusLabel}` : statusLabel;
    statusBar.setContent(
      ` ${spinner} session=${escapeTags(currentSessionName)} | mode=${escapeTags(
        currentSession.mode
      )} | steps=${currentMaxSteps} | agent=${agentMode ? "on" : "off"} | yolo=${yoloMode ? "on" : "off"} | auth=${escapeTags(
        currentAuth.source
      )} | ${escapeTags(activity)} `
    );
  }

  function setStatus(text) {
    statusLabel = text || "ready";
    renderStatusBar();
    screen.render();
  }

  function startBusyAnimation() {
    if (spinnerTimer) return;
    spinnerTimer = setInterval(() => {
      spinnerIndex = (spinnerIndex + 1) % SPINNER_FRAMES.length;
      refreshLiveProgressLine();
      renderStatusBar();
      screen.render();
    }, 120);
  }

  function stopBusyAnimation() {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
    finalizeLiveProgressLine();
    spinnerIndex = 0;
  }

  function renderMessages({ forceBottom = false } = {}) {
    const previousScroll = chatBox.getScroll();
    const previousPercent = chatBox.getScrollPerc();
    chatBox.setContent(formatMessages(messages));

    if (forceBottom || followOutput || previousPercent >= 95) {
      chatBox.setScrollPerc(100);
      followOutput = true;
    } else {
      chatBox.setScroll(previousScroll);
    }
    screen.render();
  }

  function pushMessage(role, text, options = {}) {
    messages.push({ role, text });
    trimMessageHistory(messages);
    renderMessages(options);
  }

  function pushProgress(text, { force = false } = {}) {
    const normalized = String(text || "").trim();
    if (!normalized) return;
    const now = Date.now();
    if (!force && normalized === lastProgressText) return;
    if (!force && now - lastProgressTs < 350) return;

    lastProgressText = normalized;
    lastProgressTs = now;
    if (!liveProgressMessage) {
      liveProgressMessage = { role: "system", text: "" };
      messages.push(liveProgressMessage);
      trimMessageHistory(messages);
    }
    liveProgressBaseText = normalized;
    refreshLiveProgressLine({ forceBottom: true });
  }

  function refreshLiveProgressLine({ forceBottom = false } = {}) {
    if (!liveProgressMessage || !liveProgressBaseText) return;
    const frame = SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length];
    liveProgressMessage.text = `${frame} ${liveProgressBaseText}`;
    renderMessages({ forceBottom });
  }

  function finalizeLiveProgressLine() {
    if (!liveProgressMessage) return;
    const doneText = liveProgressBaseText || "done";
    liveProgressMessage.text = `✓ ${doneText}`;
    liveProgressMessage = null;
    liveProgressBaseText = "";
    renderMessages();
  }

  function updateAutocompleteList() {
    const value = inputBox.getValue();
    currentSuggestions = getSlashSuggestions(value, AUTOCOMPLETE_LIST_MAX);
    if (!value.trim().startsWith("/")) {
      suggestionList.hide();
      screen.render();
      return;
    }
    if (currentSuggestions.length === 0) {
      suggestionList.hide();
      screen.render();
      return;
    }
    suggestionSelectedIndex = Math.max(
      0,
      Math.min(suggestionSelectedIndex, currentSuggestions.length - 1)
    );
    suggestionList.setItems(
      currentSuggestions.map((entry) =>
        `${entry.usage}${entry.description ? ` — ${entry.description}` : ""}`
      )
    );
    suggestionList.show();
    suggestionList.select(suggestionSelectedIndex);
    screen.render();
  }

  async function switchToSession(name) {
    currentSessionName = name;
    currentSession = await loadSession(name);
    pushMessage("system", `Switched to session "${name}".`);
  }

  async function maybeDeleteSession(name) {
    if (!deleteSessionState) {
      pushMessage("error", "Session deletion is unavailable in this build.");
      return;
    }

    const confirm = await showSelectionMenu(screen, `Delete "${name}"?`, [
      { label: "Delete session (cannot be undone)", value: "delete" },
      { label: "Cancel", value: "cancel" },
    ]);
    if (confirm !== "delete") return;

    const result = await deleteSessionState(name, { client: currentClient });
    if (!result.deleted) {
      if (result.reason === "active_session") {
        pushMessage("error", `Cannot delete active session "${name}". Switch to another session first.`);
        return;
      }
      if (result.reason === "auth_required") {
        pushMessage("error", 'Deleting remote chats requires auth. Run /login first.');
        return;
      }
      pushMessage("error", `Session "${name}" was not found.`);
      return;
    }

    if (name === currentSessionName) {
      if (result.activeSession) {
        currentSessionName = result.activeSession;
        currentSession = await loadSession(result.activeSession);
        pushMessage("system", `Deleted "${name}". Switched to "${result.activeSession}".`);
        return;
      }
      const generatedName = createSessionName ? createSessionName() : `session-${Date.now()}`;
      await switchToSession(generatedName);
      pushMessage("system", `Deleted "${name}". Created and switched to "${generatedName}".`);
      return;
    }

    if (result.remote?.reason === "not_found") {
      pushMessage("system", `Deleted "${name}" locally. Remote chat was already missing.`);
      return;
    }
    pushMessage("system", `Deleted session "${name}" locally and on Meta.`);
  }

  async function chooseModeFromMenu() {
    const selectedMode = await showSelectionMenu(screen, "Select Mode", [
      { label: "Think Fast (think_fast)", value: "think_fast" },
      { label: "Think Hard (think_hard)", value: "think_hard" },
    ]);
    if (!selectedMode) return;
    currentSession.mode = normalizeMode(selectedMode);
    await saveSession(currentSessionName, currentSession);
    pushMessage("system", `Mode set to ${currentSession.mode}.`);
  }

  async function chooseSessionFromMenu() {
    while (true) {
      const sessionsInfo = await listSessions();
      const choice = await showSessionsListMenu(screen, sessionsInfo);
      if (!choice || choice.action === "cancel") return;

      if (choice.action === "create") {
        const generatedName = createSessionName ? createSessionName() : `session-${Date.now()}`;
        await switchToSession(generatedName);
        return;
      }

      if (choice.action === "switch" && choice.name) {
        await switchToSession(choice.name);
        return;
      }

      if (choice.action === "delete" && choice.name) {
        await maybeDeleteSession(choice.name);
      }
    }
  }

  async function runSlashCommand(input) {
    const command = parseSlashCommand(input);
    if (!command) return false;

    if (command.name === "exit" || command.name === "quit") {
      return true;
    }

    if (command.name === "help") {
      await showInfoModal(screen, "Slash Commands", [
        ...formatSlashHelpLines(),
        "",
        "Autocomplete: start typing /<command> and press Tab to complete.",
        "All normal prompts run with the file-tool agent automatically.",
      ]);
      return false;
    }

    if (command.name === "auth") {
      currentAuth = await getAuthSummary();
      pushMessage("system", formatAuthSummary(currentAuth));
      return false;
    }

    if (command.name === "doctor") {
      currentAuth = await getAuthSummary();
      const report = await runDoctor({
        cwd: process.cwd(),
        authSummary: currentAuth,
        config: { defaultMode: currentSession.mode, defaultMaxSteps: currentMaxSteps },
      });
      await showInfoModal(screen, "Doctor", formatDoctorLines(report));
      return false;
    }

    if (command.name === "status") {
      currentAuth = await getAuthSummary();
      pushMessage(
        "system",
        `session=${currentSessionName}, mode=${currentSession.mode}, max_steps=${currentMaxSteps}, yolo=${yoloMode ? "on" : "off"}, conversation=${currentSession.conversationId}, ${formatAuthSummary(
          currentAuth
        )}`
      );
      return false;
    }

    if (command.name === "max-steps") {
      const raw = command.args[0];
      if (!raw || raw.toLowerCase() === "status") {
        pushMessage("system", `max steps is ${currentMaxSteps}.`);
        return false;
      }
      try {
        currentMaxSteps = normalizeAgentSteps(raw, currentMaxSteps);
        pushMessage("system", `max steps set to ${currentMaxSteps} for this session.`);
      } catch (error) {
        pushMessage(
          "error",
          `${error.message} (usage: /max-steps <count> or /max-steps status)`
        );
      }
      return false;
    }

    if (command.name === "retry") {
      if (!lastUserPrompt) {
        pushMessage("error", "No previous prompt to retry.");
        return false;
      }
      pushMessage("system", "Retrying the last prompt.");
      await sendPrompt(lastUserPrompt, { trackAsLastPrompt: false });
      return false;
    }

    if (command.name === "yolo") {
      const value = (command.args[0] || "toggle").toLowerCase();
      if (value === "status") {
        pushMessage("system", `yolo mode is ${yoloMode ? "ON" : "OFF"}.`);
        return false;
      }
      if (value === "on") {
        yoloMode = true;
        pushMessage("system", "yolo mode enabled: terminal commands will auto-run.");
        return false;
      }
      if (value === "off") {
        yoloMode = false;
        pushMessage("system", "yolo mode disabled: terminal commands require approval.");
        return false;
      }
      if (value === "toggle") {
        yoloMode = !yoloMode;
        pushMessage("system", `yolo mode is now ${yoloMode ? "ON" : "OFF"}.`);
        return false;
      }
      pushMessage("error", "Usage: /yolo [on|off|status]");
      return false;
    }

    if (command.name === "clear") {
      messages.length = 0;
      pushMessage("system", "Screen messages cleared.");
      return false;
    }

    if (command.name === "mode") {
      if (command.args.length === 0) {
        await chooseModeFromMenu();
        return false;
      }
      currentSession.mode = normalizeMode(command.args[0]);
      await saveSession(currentSessionName, currentSession);
      pushMessage("system", `Mode set to ${currentSession.mode}.`);
      return false;
    }

    if (command.name === "new") {
      currentSession = await resetSessionState(currentSessionName);
      pushMessage("system", `Started new conversation ${currentSession.conversationId}.`);
      return false;
    }

    if (command.name === "tools") {
      await showInfoModal(screen, "Agent File Tools", formatToolDefinitionsForPrompt().split("\n"));
      return false;
    }

    if (command.name === "memory") {
      const memory = await loadWorkspaceMemory(process.cwd());
      await showInfoModal(screen, "Workspace Memory", formatWorkspaceMemoryLines(memory));
      return false;
    }

    if (command.name === "sessions") {
      if (command.args.length === 0) {
        await chooseSessionFromMenu();
        return false;
      }
      if (command.args[0].toLowerCase() === "delete") {
        const target = command.args[1];
        if (!target) {
          pushMessage("error", "Usage: /sessions delete <name>");
          return false;
        }
        await maybeDeleteSession(target);
        return false;
      }
      await switchToSession(command.args[0]);
      return false;
    }

    if (command.name === "set-cookie") {
      const cookieValue = input.slice("/set-cookie".length).trim();
      if (!cookieValue) {
        pushMessage("error", "Usage: /set-cookie <cookie>");
        return false;
      }
      const cookieResult = await setCookie(cookieValue);
      currentClient = cookieResult.client;
      currentAuth = cookieResult.authSummary;
      pushMessage("system", `Cookie saved. ${formatAuthSummary(currentAuth)}`);
      return false;
    }

    if (command.name === "login") {
      pushMessage("system", "Starting browser login flow...");
      const loginResult = await login((statusMessage) => pushMessage("system", statusMessage));
      currentClient = loginResult.client;
      currentAuth = loginResult.authSummary;
      pushMessage("system", `Login complete. ${formatAuthSummary(currentAuth)}`);
      return false;
    }

    if (command.name === "logout") {
      const logoutResult = await logout();
      currentClient = logoutResult.client;
      currentAuth = logoutResult.authSummary;
      pushMessage("system", `Config cookie cleared. ${formatAuthSummary(currentAuth)}`);
      return false;
    }

    if (command.name === "history") {
      const historyMessages = messages.filter(
        (m) => m.role === "user" || m.role === "assistant" || m.role === "error"
      );
      if (historyMessages.length === 0) {
        pushMessage("system", "No conversation history yet.");
        return false;
      }
      const historyLines = historyMessages.flatMap((m) => {
        const prefix = m.role === "user" ? "YOU:" : m.role === "assistant" ? "ASSISTANT:" : "ERROR:";
        const body = m.text.split("\n");
        return [`${prefix}`, ...body, ""];
      });
      await showInfoModal(screen, "Conversation History", historyLines);
      return false;
    }

    if (command.name === "export") {
      const filename = command.args[0] || "";
      try {
        const exportResult = await exportConversationToFile(messages, {
          filename,
          outputDir: process.cwd(),
          sessionName: currentSessionName,
          mode: currentSession.mode,
        });
        pushMessage(
          "system",
          `Conversation exported to: ${exportResult.filePath} (${exportResult.messageCount} messages, ${exportResult.bytes} bytes)`
        );
      } catch (error) {
        pushMessage("error", `Export failed: ${error.message}`);
      }
      return false;
    }

    if (command.name === "compact") {
      const conversationMessages = messages.filter(
        (m) => m.role === "user" || m.role === "assistant"
      );
      if (conversationMessages.length < 2) {
        pushMessage("system", "Not enough conversation to compact.");
        return false;
      }
      // Build a compact summary by keeping the first user message and last few exchanges
      const keepLast = 4;
      const kept = conversationMessages.slice(-keepLast);
      const droppedCount = conversationMessages.length - kept.length;
      // Remove all conversation messages from display, inject a summary marker
      const nonConversation = messages.filter(
        (m) => m.role !== "user" && m.role !== "assistant"
      );
      messages.length = 0;
      messages.push(...nonConversation);
      messages.push({
        role: "system",
        text: `[Compacted: ${droppedCount} earlier message(s) removed from view. Last ${kept.length} message(s) retained.]`,
      });
      messages.push(...kept);
      trimMessageHistory(messages);
      renderMessages({ forceBottom: true });
      pushMessage("system", `Conversation compacted. ${droppedCount} older message(s) cleared from view.`);
      return false;
    }

    if (command.name === "agent") {
      const value = (command.args[0] || "toggle").toLowerCase();
      if (value === "status") {
        pushMessage("system", `agent mode is ${agentMode ? "ON (file tools enabled)" : "OFF (plain chat)"}.`);
        return false;
      }
      if (value === "on") {
        agentMode = true;
        pushMessage("system", "agent mode enabled: prompts use file tools.");
        renderStatusBar();
        return false;
      }
      if (value === "off") {
        agentMode = false;
        pushMessage("system", "agent mode disabled: prompts are plain chat (no file tools).");
        renderStatusBar();
        return false;
      }
      if (value === "toggle") {
        agentMode = !agentMode;
        pushMessage("system", `agent mode is now ${agentMode ? "ON" : "OFF"}.`);
        renderStatusBar();
        return false;
      }
      pushMessage("error", "Usage: /agent [on|off|status]");
      return false;
    }

    if (command.name === "diff") {
      if (lastRunTouchedFiles.length === 0) {
        pushMessage("system", "No files were touched in the last agent run (or no agent run yet).");
        return false;
      }
      const lines = [
        `Files touched in last agent run (${lastRunTouchedFiles.length}):`,
        "",
        ...lastRunTouchedFiles.map((f) => `  • ${f}`),
      ];
      await showInfoModal(screen, "Last Run — Touched Files", lines);
      return false;
    }

    pushMessage("error", `Unknown command "${command.raw}". Run /help for available commands.`);
    return false;
  }

  async function sendPrompt(content, { trackAsLastPrompt = true } = {}) {
    if (!runAgentTask) {
      pushMessage("error", "Agent runtime is unavailable.");
      return;
    }
    if (trackAsLastPrompt) {
      lastUserPrompt = content;
    }

    pushMessage("user", content, { forceBottom: true });

    // Plain chat mode: skip the agent pipeline and send directly as a single message
    if (!agentMode) {
      pushProgress(pickThinkingPhrase(lastProgressText), { force: true });
      setStatus("thinking");
      const result = await runAgentTask({
        client: currentClient,
        task: content,
        session: currentSession,
        maxSteps: 1,
        onStatus: (message) => setStatus(describeAgentStatusFriendly(message)),
        onThinking: (message) => {
          pushProgress(message?.trim() || pickThinkingPhrase(lastProgressText));
        },
        onToolCall: null,
        onToolResult: null,
        onCommandApproval: null,
        onFollowUpQuestion: null,
      });
      setStatus("done");
      pushMessage("assistant", result.content, { forceBottom: true });
      currentSession = {
        ...currentSession,
        conversationId: result.conversationId,
        currentBranchPath: result.currentBranchPath,
        mode: normalizeMode(result.mode),
      };
      await saveSession(currentSessionName, currentSession);
      chattedSessions.add(currentSessionName);
      renderMessages({ forceBottom: true });
      return;
    }

    // Agent mode: full tool-enabled pipeline
    lastRunTouchedFiles = [];
    pushProgress(pickThinkingPhrase(lastProgressText), { force: true });
    setStatus("getting started");
    const result = await runAgentTask({
      client: currentClient,
      task: content,
      session: currentSession,
      maxSteps: currentMaxSteps,
      onStatus: (message) => {
        const friendly = describeAgentStatusFriendly(message);
        setStatus(friendly === "finalizing answer" ? "wrapping up" : "working");
        if (message.startsWith("step ")) {
          const match = message.match(/^step\s+(\d+)\//);
          const step = match ? Number.parseInt(match[1], 10) : 0;
          if (step === 1 || step % 4 === 0) {
            pushProgress("working through the implementation");
          }
        } else if (friendly === "finalizing answer") {
          pushProgress("wrapping up the result");
        } else if (
          friendly === "trying a different approach" ||
          friendly === "starting from scratch automatically" ||
          friendly === "reformatting response" ||
          friendly === "continuing execution" ||
          friendly === "starting a fresh conversation" ||
          friendly === "recovering from model refusal" ||
          friendly === "stopping refusal loop" ||
          friendly === "stopping retry loop" ||
          friendly === "waiting for your input" ||
          friendly === "continuing with assumptions"
        ) {
          pushProgress(friendly);
        }
      },
      onThinking: (message) => {
        pushProgress(message?.trim() || pickThinkingPhrase(lastProgressText));
      },
      onToolCall: (call) => {
        const friendly = describeToolCallFriendly(call);
        setStatus("working");
        pushProgress(friendly);
      },
      onToolResult: (toolResult) => {
        if (!toolResult.ok) {
          pushMessage(
            "error",
            `I hit an issue while using ${toolResult.name}: ${toolResult.error}`,
            { forceBottom: true }
          );
          pushProgress("recovering from an issue and trying again");
        } else if (toolResult.result) {
          // Track files touched by the agent for /diff
          // Different tools use different fields: path, to (move_path), from (move_path)
          for (const field of ["path", "to"]) {
            const p = toolResult.result[field];
            if (typeof p === "string" && p !== "." && !lastRunTouchedFiles.includes(p)) {
              lastRunTouchedFiles.push(p);
            }
          }
        }
      },
      onCommandApproval: async ({ command, cwd }) => {
        if (yoloMode) {
          pushProgress(`running command automatically: ${command}`);
          return { approved: true };
        }

        pushMessage(
          "system",
          `command requested: ${command} (cwd: ${cwd})`,
          { forceBottom: true }
        );
        const choice = await showCommandApprovalMenu(screen, { command, cwd });
        if (choice === "always") {
          yoloMode = true;
          pushMessage("system", "yolo mode enabled. Running command.");
          return { approved: true };
        }
        if (choice === "once") {
          return { approved: true };
        }
        pushMessage("system", "command denied.");
        return { approved: false, reason: "User denied command execution." };
      },
      onFollowUpQuestion: async ({ question, choices, allowFreeform }) => {
        setStatus("waiting for your input");
        pushProgress("waiting for your input", { force: true });
        const answer = await showFollowUpQuestionMenu(screen, {
          question,
          choices,
          allowFreeform,
        });
        if (answer) {
          pushMessage("user", answer, { forceBottom: true });
          pushProgress("continuing with your clarification", { force: true });
        } else {
          pushMessage("system", "No clarification provided. Continuing with best assumptions.", {
            forceBottom: true,
          });
          pushProgress("continuing with assumptions", { force: true });
        }
        setStatus("working");
        return answer;
      },
    });
    setStatus("done");
    pushMessage("assistant", result.content, { forceBottom: true });

    currentSession = {
      ...currentSession,
      conversationId: result.conversationId,
      currentBranchPath: result.currentBranchPath,
      mode: normalizeMode(result.mode),
    };
    await saveSession(currentSessionName, currentSession);
    chattedSessions.add(currentSessionName);
    renderMessages({ forceBottom: true });
  }

  async function handleSubmit(rawInput) {
    const input = rawInput.trim();
    if (!input) return false;

    if (busy) {
      pushMessage("error", "Still processing previous action. Please wait.");
      return false;
    }

    // Add to input history (avoid consecutive duplicates)
    if (input && (inputHistory.length === 0 || inputHistory[inputHistory.length - 1] !== input)) {
      inputHistory.push(input);
      if (inputHistory.length > 200) inputHistory.shift();
    }
    inputHistoryIndex = -1;
    inputHistorySavedDraft = "";

    busy = true;
    startBusyAnimation();
    setStatus("starting");
    try {
      if (input.startsWith("/")) {
        return await runSlashCommand(input);
      }
      await sendPrompt(input);
      return false;
    } finally {
      busy = false;
      stopBusyAnimation();
      setStatus("ready");
      updateAutocompleteList();
      screen.render();
    }
  }

  function cleanupAndResolve(resolve) {
    if (resolving) return;
    resolving = true;
    stopBusyAnimation();
    screen.destroy();
    resolve({
      chattedSessions: [...chattedSessions],
      activeSessionName: currentSessionName,
    });
  }

  setStatus("ready");
  renderMessages();
  updateAutocompleteList();
  inputBox.focus();

  return new Promise((resolve) => {
    screen.key(["C-c"], () => cleanupAndResolve(resolve));
    screen.key(["pageup"], () => {
      chatBox.scroll(-5);
      followOutput = false;
      screen.render();
    });
    screen.key(["pagedown"], () => {
      chatBox.scroll(5);
      followOutput = chatBox.getScrollPerc() >= 95;
      screen.render();
    });

    inputBox.key("tab", () => {
      if (busy) return;
      const value = inputBox.getValue();
      if (!currentSuggestions.length) {
        currentSuggestions = getSlashSuggestions(value, AUTOCOMPLETE_LIST_MAX);
      }
      if (!currentSuggestions.length) return;

      const suggestion = currentSuggestions[suggestionSelectedIndex] ?? currentSuggestions[0];
      const completed = completeSlashCommand(value, [suggestion]);
      if (!completed) return;

      inputBox.setValue(completed);
      suggestionSelectedIndex = 0;
      updateAutocompleteList();
      inputBox.focus();
      screen.render();
    });

    inputBox.key(["up", "down"], (_ch, key) => {
      // If the autocomplete suggestion list is visible, navigate suggestions
      if (suggestionList.visible && currentSuggestions.length) {
        if (key.name === "up") {
          suggestionSelectedIndex =
            (suggestionSelectedIndex - 1 + currentSuggestions.length) % currentSuggestions.length;
        } else if (key.name === "down") {
          suggestionSelectedIndex = (suggestionSelectedIndex + 1) % currentSuggestions.length;
        }
        suggestionList.select(suggestionSelectedIndex);
        screen.render();
        return false;
      }

      // Otherwise navigate through input history
      if (inputHistory.length === 0) return false;
      if (key.name === "up") {
        if (inputHistoryIndex === -1) {
          // Save the current draft before we start navigating
          inputHistorySavedDraft = inputBox.getValue();
          inputHistoryIndex = inputHistory.length - 1;
        } else if (inputHistoryIndex > 0) {
          inputHistoryIndex -= 1;
        }
        inputBox.setValue(inputHistory[inputHistoryIndex]);
        screen.render();
        return false;
      }
      if (key.name === "down") {
        if (inputHistoryIndex === -1) return false;
        if (inputHistoryIndex < inputHistory.length - 1) {
          inputHistoryIndex += 1;
          inputBox.setValue(inputHistory[inputHistoryIndex]);
        } else {
          inputHistoryIndex = -1;
          inputBox.setValue(inputHistorySavedDraft);
        }
        screen.render();
        return false;
      }
      return false;
    });

    inputBox.on("keypress", (_ch, key) => {
      if (key?.name === "up" || key?.name === "down") return;
      // Any other keypress resets history navigation
      if (inputHistoryIndex !== -1) {
        inputHistoryIndex = -1;
        inputHistorySavedDraft = "";
      }
      suggestionSelectedIndex = 0;
      setImmediate(() => updateAutocompleteList());
    });

    suggestionList.on("select", (item, index) => {
      if (!currentSuggestions[index]) return;
      const value = inputBox.getValue();
      const completed = completeSlashCommand(value, [currentSuggestions[index]]);
      if (!completed) return;
      inputBox.setValue(completed);
      suggestionSelectedIndex = 0;
      updateAutocompleteList();
      inputBox.focus();
      screen.render();
    });

    inputBox.on("submit", async (value) => {
      inputBox.clearValue();
      suggestionSelectedIndex = 0;
      updateAutocompleteList();
      screen.render();

      try {
        const shouldExit = await handleSubmit(value);
        if (shouldExit) {
          cleanupAndResolve(resolve);
          return;
        }
      } catch (error) {
        pushMessage("error", `Operation failed: ${error.message}`);
        setStatus("error");
      } finally {
        inputBox.focus();
        updateAutocompleteList();
        screen.render();
      }
    });

    screen.render();
  });
}
