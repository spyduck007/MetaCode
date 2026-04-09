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

const MAX_MESSAGES = 250;
const STATUS_HEIGHT = 1;
const INPUT_HEIGHT = 3;
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

function trimMessageHistory(messages) {
  if (messages.length > MAX_MESSAGES) {
    messages.splice(0, messages.length - MAX_MESSAGES);
  }
}

function formatAuthSummary(authSummary) {
  return `source=${authSummary.source}, session_cookie=${authSummary.hasSession}, cookie=${authSummary.redacted}`;
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
      padding: { left: 1, right: 1, top: 0, bottom: 0 },
      style: {
        border: { fg: "cyan" },
        bg: "black",
      },
    });

    const helpLine = blessed.box({
      parent: wrapper,
      top: 0,
      left: 0,
      width: "100%",
      height: 1,
      tags: true,
      content: "{gray-fg}↑/↓ move • Enter select • Esc cancel{/}",
    });

    const list = blessed.list({
      parent: wrapper,
      top: 1,
      left: 0,
      width: "100%",
      height: "100%-1",
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
      padding: { left: 1, right: 1, top: 1, bottom: 1 },
    });

    const info = blessed.box({
      parent: wrapper,
      top: 0,
      left: 0,
      width: "100%",
      height: 8,
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
      top: 9,
      left: 0,
      width: "100%",
      height: "100%-10",
      keys: true,
      mouse: true,
      vi: true,
      style: {
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
  resetSessionState,
  getAuthSummary,
  login,
  logout,
  setCookie,
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

  const inputBox = blessed.textbox({
    parent: screen,
    bottom: 0,
    left: 0,
    width: "100%",
    height: INPUT_HEIGHT,
    border: "line",
    inputOnFocus: true,
    keys: true,
    mouse: true,
    label: " Prompt ",
    style: {
      border: { fg: "yellow" },
      focus: {
        border: { fg: "magenta" },
      },
    },
    padding: { left: 1, right: 1 },
  });

  let busy = false;
  let resolving = false;
  let followOutput = true;
  let statusLabel = "ready";
  let spinnerIndex = 0;
  let spinnerTimer = null;
  let lastProgressText = "";
  let lastProgressTs = 0;
  let yoloMode = false;
  let liveProgressMessage = null;
  let liveProgressBaseText = "";

  function renderStatusBar() {
    const spinner = busy ? SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length] : ">";
    const activity = busy ? `working · ${statusLabel}` : statusLabel;
    statusBar.setContent(
      ` ${spinner} session=${escapeTags(currentSessionName)} | mode=${escapeTags(
        currentSession.mode
      )} | yolo=${yoloMode ? "on" : "off"} | auth=${escapeTags(currentAuth.source)} | ${escapeTags(activity)} `
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
    const sessionsInfo = await listSessions();
    const existingNames = Object.keys(sessionsInfo.sessions);
    const selected = await showSelectionMenu(screen, "Select Session", [
      ...existingNames.map((name) => ({ label: name, value: name })),
      { label: "Create new session", value: "__new__" },
    ]);
    if (!selected) return;

    if (selected === "__new__") {
      const generatedName = `session-${Date.now().toString().slice(-6)}`;
      await switchToSession(generatedName);
      return;
    }
    await switchToSession(selected);
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

    if (command.name === "status") {
      currentAuth = await getAuthSummary();
      pushMessage(
        "system",
        `session=${currentSessionName}, mode=${currentSession.mode}, yolo=${yoloMode ? "on" : "off"}, conversation=${currentSession.conversationId}, ${formatAuthSummary(
          currentAuth
        )}`
      );
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

    if (command.name === "sessions") {
      const sessionsInfo = await listSessions();
      const lines = Object.entries(sessionsInfo.sessions).map(
        ([name, details]) =>
          `${name}  mode=${details.mode}  conversation=${details.conversationId}  branch=${details.currentBranchPath}`
      );
      await showInfoModal(screen, "Sessions", [
        `Active: ${sessionsInfo.activeSession}`,
        "",
        ...lines,
      ]);
      return false;
    }

    if (command.name === "tools") {
      await showInfoModal(screen, "Agent File Tools", formatToolDefinitionsForPrompt().split("\n"));
      return false;
    }

    if (command.name === "session") {
      if (command.args.length === 0) {
        await chooseSessionFromMenu();
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

    pushMessage("error", `Unknown command "${command.raw}". Run /help for available commands.`);
    return false;
  }

  async function sendPrompt(content) {
    if (!runAgentTask) {
      pushMessage("error", "Agent runtime is unavailable.");
      return;
    }

    pushMessage("user", content, { forceBottom: true });
    pushProgress(pickThinkingPhrase(lastProgressText), { force: true });
    setStatus("getting started");
    const result = await runAgentTask({
      client: currentClient,
      task: content,
      session: currentSession,
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
          friendly === "continuing execution"
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
    renderMessages({ forceBottom: true });
  }

  async function handleSubmit(rawInput) {
    const input = rawInput.trim();
    if (!input) return false;

    if (busy) {
      pushMessage("error", "Still processing previous action. Please wait.");
      return false;
    }

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
    resolve();
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
      if (!suggestionList.visible || !currentSuggestions.length) return;
      if (key.name === "up") {
        suggestionSelectedIndex =
          (suggestionSelectedIndex - 1 + currentSuggestions.length) % currentSuggestions.length;
      } else if (key.name === "down") {
        suggestionSelectedIndex = (suggestionSelectedIndex + 1) % currentSuggestions.length;
      }
      suggestionList.select(suggestionSelectedIndex);
      screen.render();
      return false;
    });

    inputBox.on("keypress", (_ch, key) => {
      if (key?.name === "up" || key?.name === "down") return;
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
