#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stderr } from "node:process";
import { DEFAULT_MODE } from "./constants.js";
import { hasSessionCookie, redactCookie, resolveCookie } from "./auth.js";
import { readConfig, updateConfig, writeConfig } from "./config.js";
import { MetaAIClient, normalizeMode } from "./meta-client.js";
import { loginWithBrowser } from "./browser-login.js";
import {
  deleteSession,
  ensureSession,
  generateSessionName,
  listSessions,
  readSessionState,
  renameSession,
  resetSession,
  updateSession,
  writeSessionState,
} from "./sessions.js";
import { startTui } from "./tui.js";
import { runAgentWithFileTools } from "./agent-orchestrator.js";
import { FILE_TOOL_DEFINITIONS } from "./file-tools.js";
import {
  describeAgentStatusFriendly,
  describeToolCallFriendly,
  pickThinkingPhrase,
} from "./progress-ui.js";
import { loadWorkspaceMemory, WORKSPACE_MEMORY_FILES } from "./workspace-memory.js";
import {
  DEFAULT_AGENT_STEPS,
  MAX_AGENT_STEPS,
  MIN_AGENT_STEPS,
  normalizeAgentSteps,
} from "./max-steps.js";
import { runDoctor } from "./doctor.js";

function toAuthSummary(auth) {
  return {
    source: auth.source,
    redacted: redactCookie(auth.cookie),
    hasSession: hasSessionCookie(auth.cookie) ? "yes" : "no",
  };
}

async function resolveAuthState({ requireClient = true } = {}) {
  const config = await readConfig();
  const auth = resolveCookie({ config });
  const authSummary = toAuthSummary(auth);

  if (!auth.cookie) {
    if (requireClient) {
      throw new Error(
        "No cookie available. Run /login in the UI, or set META_AI_COOKIE / meta-code auth set-cookie."
      );
    }
    return { client: null, authSummary };
  }

  return {
    client: new MetaAIClient({ cookie: auth.cookie }),
    authSummary,
  };
}

async function runBrowserLogin({ headless = false, timeoutSeconds = 300, onStatus } = {}) {
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 30) {
    throw new Error("Timeout must be an integer >= 30 seconds.");
  }

  const result = await loginWithBrowser({
    timeoutMs: timeoutSeconds * 1000,
    headless,
    onStatus,
  });
  await updateConfig({ cookie: result.cookieHeader });
  return resolveAuthState({ requireClient: true });
}

async function clearConfigCookie() {
  const config = await readConfig();
  const { cookie: _cookie, ...rest } = config;
  await writeConfig(rest);
  return resolveAuthState({ requireClient: false });
}

async function setConfigCookie(cookie) {
  const normalizedCookie = cookie?.trim();
  if (!normalizedCookie) {
    throw new Error("Cookie value cannot be empty.");
  }
  await updateConfig({ cookie: normalizedCookie });
  return resolveAuthState({ requireClient: false });
}

async function buildRuntime(
  options,
  { requireClient = true, freshSessionOnLaunch = false } = {}
) {
  const config = await readConfig();
  const { client, authSummary } = await resolveAuthState({ requireClient });

  const hasExplicitSession = typeof options.session === "string" && options.session.trim().length > 0;
  const sessionName =
    options.session?.trim() ||
    (freshSessionOnLaunch ? generateSessionName("chat") : "default");
  const { session } = await ensureSession(sessionName);
  const mode = normalizeMode(options.mode ?? session.mode ?? config.defaultMode ?? DEFAULT_MODE);
  const maxSteps = normalizeAgentSteps(options.maxSteps ?? config.defaultMaxSteps ?? DEFAULT_AGENT_STEPS);

  const baseSession = options.new ? await resetSession(sessionName) : session;
  const hydratedSession = await updateSession(sessionName, { ...baseSession, mode });

  return {
    client,
    sessionName,
    session: hydratedSession,
    maxSteps,
    authSummary,
    launchedFreshSession: freshSessionOnLaunch && !hasExplicitSession,
  };
}

async function runAgentTask({
  client,
  task,
  session,
  workspaceRoot = process.cwd(),
  maxSteps,
  onStatus,
  onThinking,
  onToolCall,
  onToolResult,
  onCommandApproval,
  onFollowUpQuestion,
  onDelta,
}) {
  if (!client) {
    throw new Error("No active auth session. Run /login first.");
  }
  return runAgentWithFileTools({
    client,
    task,
    conversationId: session.conversationId,
    currentBranchPath: session.currentBranchPath,
    mode: session.mode,
    workspaceRoot,
    maxSteps,
    onStatus,
    onThinking,
    onToolCall,
    onToolResult,
    onCommandApproval,
    onFollowUpQuestion,
    onDelta,
  });
}

async function deleteSessionEverywhere(name, { clientOverride } = {}) {
  const normalizedName = name?.trim();
  if (!normalizedName) {
    throw new Error("Session name is required.");
  }

  const sessionState = await readSessionState();
  const existingSession = sessionState.sessions?.[normalizedName];
  if (!existingSession) {
    return { deleted: false, reason: "not_found", activeSession: sessionState.activeSession };
  }
  if (sessionState.activeSession === normalizedName) {
    return { deleted: false, reason: "active_session", activeSession: sessionState.activeSession };
  }

  if (clientOverride === null) {
    return { deleted: false, reason: "auth_required", activeSession: sessionState.activeSession };
  }

  let client = clientOverride;
  if (!client) {
    try {
      client = (await resolveAuthState({ requireClient: true })).client;
    } catch (error) {
      if (String(error?.message ?? "").includes("No cookie available")) {
        return { deleted: false, reason: "auth_required", activeSession: sessionState.activeSession };
      }
      throw error;
    }
  }

  const remote = await client.deleteConversation({
    conversationId: existingSession.conversationId,
  });

  const local = await deleteSession(normalizedName);
  return {
    ...local,
    remote,
    conversationId: existingSession.conversationId,
  };
}

async function cleanupUnusedLaunchSession({ sessionName, chattedSessions }) {
  if (!sessionName) return;
  if (chattedSessions?.has(sessionName)) return;

  const state = await readSessionState();
  if (!state.sessions?.[sessionName]) return;

  delete state.sessions[sessionName];
  if (state.activeSession === sessionName) {
    state.activeSession = Object.keys(state.sessions)[0] ?? null;
  }

  await writeSessionState(state);
}

async function promptCommandApproval({ command, cwd, timeoutMs, yoloState, progress }) {
  if (yoloState.enabled) {
    progress(`running command in yolo mode: ${command}`);
    return { approved: true };
  }

  if (!stdin.isTTY || !stderr.isTTY) {
    return {
      approved: false,
      reason: `Command execution requires interactive approval. Re-run with --yolo to allow: ${command}`,
    };
  }

  stderr.write(
    `\n${chalk.yellow("Command requested by agent")}\n` +
      `${chalk.dim(`cwd: ${cwd ?? process.cwd()} | timeout: ${timeoutMs ?? 15000}ms`)}\n` +
      `${command}\n`
  );

  const rl = createInterface({ input: stdin, output: stderr });
  const answer = (
    await rl.question("Approve? [y] once / [n] deny / [a] always for this run: ")
  )
    .trim()
    .toLowerCase();
  rl.close();

  if (answer === "a" || answer === "always") {
    yoloState.enabled = true;
    progress("yolo enabled for this one-shot run");
    return { approved: true };
  }
  if (answer === "y" || answer === "yes") {
    return { approved: true };
  }
  return { approved: false, reason: `User denied command: ${command}` };
}

async function promptAgentFollowUp({ question, choices = [], allowFreeform = true, progress }) {
  const normalizedQuestion = String(question || "").trim();
  if (!normalizedQuestion) return null;

  if (!stdin.isTTY || !stderr.isTTY) {
    progress?.("agent asked for clarification but input is non-interactive");
    return null;
  }

  stderr.write(`\n${chalk.yellow("Agent needs clarification")}\n${normalizedQuestion}\n`);
  const normalizedChoices = Array.isArray(choices)
    ? choices
        .map((choice) => String(choice ?? "").trim())
        .filter(Boolean)
        .slice(0, 8)
    : [];

  const rl = createInterface({ input: stdin, output: stderr });
  try {
    if (normalizedChoices.length > 0) {
      normalizedChoices.forEach((choice, index) => {
        stderr.write(`${index + 1}. ${choice}\n`);
      });
      if (allowFreeform) {
        stderr.write(`${normalizedChoices.length + 1}. Provide custom answer\n`);
      }

      const upperBound = normalizedChoices.length + (allowFreeform ? 1 : 0);
      const response = (await rl.question(`Choose 1-${upperBound}, or type your answer: `)).trim();
      if (!response) return null;

      if (/^\d+$/.test(response)) {
        const selected = Number.parseInt(response, 10);
        if (selected >= 1 && selected <= normalizedChoices.length) {
          return normalizedChoices[selected - 1];
        }
        if (allowFreeform && selected === normalizedChoices.length + 1) {
          const custom = (await rl.question("Your custom answer: ")).trim();
          return custom || null;
        }
      }

      return response;
    }

    const answer = (await rl.question("Your answer: ")).trim();
    return answer || null;
  } finally {
    rl.close();
  }
}

const program = new Command();

program
  .name("meta-code")
  .description("Meta Code: full-screen coding agent with slash commands")
  .argument("[prompt...]", "One-shot prompt text. Omit for full-screen interactive mode.")
  .option("-m, --mode <mode>", "think_fast | think_hard")
  .option(
    "--max-steps <count>",
    `Maximum autonomous agent steps (${MIN_AGENT_STEPS}-${MAX_AGENT_STEPS})`
  )
  .option("-s, --session <name>", "Session name")
  .option("-n, --new", "Start a new conversation in this session")
  .option("--yolo", "Auto-approve terminal command tool calls")
  .option("--json", "Print one-shot output as JSON (includes steps, touchedFiles, durationMs)")
  .option("--stream", "Stream output tokens to stdout as they arrive in one-shot mode")
  .action(async (promptParts, options) => {
    try {
      const prompt = Array.isArray(promptParts) ? promptParts.join(" ").trim() : "";

      if (!prompt) {
        const runtime = await buildRuntime(options, {
          requireClient: false,
          freshSessionOnLaunch: true,
        });
        const tuiResult = await startTui({
          client: runtime.client,
          sessionName: runtime.sessionName,
          session: runtime.session,
          saveSession: (name, patch) => updateSession(name, patch),
          loadSession: async (name) => (await ensureSession(name)).session,
          listSessions: () => listSessions(),
          deleteSessionState: (name, { client } = {}) =>
            deleteSessionEverywhere(name, { clientOverride: client }),
          createSessionName: () => generateSessionName("chat"),
          resetSessionState: (name) => resetSession(name),
          getAuthSummary: async () => (await resolveAuthState({ requireClient: false })).authSummary,
          login: async (onStatus) => runBrowserLogin({ onStatus }),
          logout: async () => clearConfigCookie(),
          setCookie: async (cookie) => setConfigCookie(cookie),
          initialSystemMessage: runtime.launchedFreshSession
            ? `Started a fresh session "${runtime.sessionName}" for this launch.`
            : null,
          defaultMaxSteps: runtime.maxSteps,
          runAgentTask: async ({
            client,
            task,
            session,
            maxSteps,
            onStatus,
            onThinking,
            onToolCall,
            onToolResult,
            onCommandApproval,
            onFollowUpQuestion,
          }) =>
            runAgentTask({
              client: client ?? runtime.client,
              task,
              session,
              maxSteps: maxSteps ?? runtime.maxSteps,
              onStatus,
              onThinking,
              onToolCall,
              onToolResult,
              onCommandApproval,
              onFollowUpQuestion,
            }),
        });
        if (runtime.launchedFreshSession) {
          await cleanupUnusedLaunchSession({
            sessionName: runtime.sessionName,
            chattedSessions: new Set(tuiResult?.chattedSessions ?? []),
          });
        }
        return;
      }

      const runtime = await buildRuntime(options, { requireClient: true });
      const showProgress = !options.json && !options.stream;
      const streamMode = Boolean(options.stream) && !options.json;
      const yoloState = { enabled: Boolean(options.yolo) };
      let lastProgressMessage = "";
      let thinkingPhrase = pickThinkingPhrase();
      const startMs = Date.now();
      let streamedContent = "";

      const progress = (message) => {
        if (!showProgress || !message || message === lastProgressMessage) return;
        lastProgressMessage = message;
        process.stderr.write(chalk.dim(`• ${message}\n`));
      };

      const result = await runAgentTask({
        client: runtime.client,
        task: prompt,
        session: runtime.session,
        maxSteps: runtime.maxSteps,
        onStatus: (message) => {
          if (streamMode) {
            process.stderr.write(chalk.dim(`\r• ${describeAgentStatusFriendly(message)}   `));
          } else {
            progress(describeAgentStatusFriendly(message));
          }
        },
        onThinking: (message) => {
          thinkingPhrase = message?.trim() || pickThinkingPhrase(thinkingPhrase);
          if (streamMode) {
            process.stderr.write(chalk.dim(`\r• ${thinkingPhrase}   `));
          } else {
            progress(thinkingPhrase);
          }
        },
        onToolCall: (call) => {
          const desc = describeToolCallFriendly(call);
          if (streamMode) {
            process.stderr.write(chalk.dim(`\r• ${desc}   `));
          } else {
            progress(desc);
          }
        },
        onToolResult: (toolResult) => {
          if (!toolResult.ok) {
            progress(`ran into an issue: ${toolResult.error}`);
          }
        },
        onDelta: streamMode
          ? (delta) => {
              streamedContent += delta;
              process.stdout.write(delta);
            }
          : undefined,
        onCommandApproval: async ({ command, cwd, timeoutMs }) => {
          if (streamMode) process.stderr.write("\n");
          return promptCommandApproval({
            command,
            cwd,
            timeoutMs,
            yoloState,
            progress,
          });
        },
        onFollowUpQuestion: async ({ question, choices, allowFreeform }) => {
          if (streamMode) process.stderr.write("\n");
          return promptAgentFollowUp({
            question,
            choices,
            allowFreeform,
            progress,
          });
        },
      });

      const durationMs = Date.now() - startMs;
      const output = result.content;

      if (streamMode) {
        // Delta was already streamed to stdout; ensure trailing newline
        if (!streamedContent.endsWith("\n")) process.stdout.write("\n");
        process.stderr.write("\n");
      } else if (!options.json) {
        process.stdout.write(`${output}\n`);
      }

      await updateSession(runtime.sessionName, {
        ...runtime.session,
        conversationId: result.conversationId,
        currentBranchPath: result.currentBranchPath,
        mode: normalizeMode(result.mode),
      });

      if (options.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              content: output,
              session: runtime.sessionName,
              conversationId: result.conversationId,
              branchPath: result.currentBranchPath,
              mode: result.mode,
              maxSteps: runtime.maxSteps,
              steps: result.steps ?? null,
              touchedFiles: result.touchedFiles ?? [],
              durationMs,
            },
            null,
            2
          )}\n`
        );
      }
    } catch (error) {
      console.error(chalk.red(error.message));
      process.exitCode = 1;
    }
  });

const authCommand = program
  .command("auth")
  .description("Manage auth state: login, status, set-cookie, clear");

authCommand
  .command("status")
  .description("Show current auth source and cookie health")
  .action(async () => {
    const { authSummary } = await resolveAuthState({ requireClient: false });
    console.log(`source=${authSummary.source}`);
    console.log(`cookie=${authSummary.redacted}`);
    console.log(`has ecto_1_sess=${authSummary.hasSession}`);
  });

authCommand
  .command("set-cookie")
  .description("Persist a cookie string to config")
  .argument("<cookie>", "Cookie header value")
  .action(async (cookie) => {
    await updateConfig({ cookie: cookie.trim() });
    console.log(chalk.green("Cookie saved to config."));
  });

authCommand
  .command("login")
  .description("Open browser, complete Meta login, and save cookies automatically")
  .option("--headless", "Run login browser in headless mode", false)
  .option("--timeout <seconds>", "Login timeout in seconds", "300")
  .action(async (options) => {
    try {
      const timeoutSeconds = Number.parseInt(options.timeout, 10);
      console.log(chalk.cyan("Starting browser login flow."));
      const { authSummary } = await runBrowserLogin({
        headless: options.headless,
        timeoutSeconds,
        onStatus: (message) => console.log(chalk.dim(message)),
      });
      console.log(chalk.green("Login successful. Cookie saved to config."));
      console.log(`cookie=${authSummary.redacted}`);
      console.log(`has ecto_1_sess=${authSummary.hasSession}`);
    } catch (error) {
      console.error(chalk.red(`Login failed: ${error.message}`));
      process.exitCode = 1;
    }
  });

authCommand
  .command("clear")
  .description("Remove config cookie from this CLI (env fallback may still apply)")
  .action(async () => {
    await clearConfigCookie();
    console.log(chalk.green("Config cookie removed."));
  });

const configCommand = program.command("config").description("Manage local configuration");
configCommand
  .command("show")
  .description("Show current config values")
  .action(async () => {
    const config = await readConfig();
    console.log(
      JSON.stringify(
        {
          ...config,
          cookie: config.cookie ? redactCookie(config.cookie) : undefined,
        },
        null,
        2
      )
    );
  });

configCommand
  .command("set-mode")
  .description("Set default mode for new prompts")
  .argument("<mode>", "think_fast | think_hard")
  .action(async (mode) => {
    const normalized = normalizeMode(mode);
    await updateConfig({ defaultMode: normalized });
    console.log(chalk.green(`Default mode set to ${normalized}`));
  });

configCommand
  .command("set-max-steps")
  .description(`Set default agent max steps (${MIN_AGENT_STEPS}-${MAX_AGENT_STEPS})`)
  .argument("<count>", "Integer max steps")
  .action(async (count) => {
    const normalized = normalizeAgentSteps(count);
    await updateConfig({ defaultMaxSteps: normalized });
    console.log(chalk.green(`Default max steps set to ${normalized}`));
  });

configCommand
  .command("init")
  .description("Interactive first-time setup: choose default mode and max steps")
  .action(async () => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });

    console.log(chalk.cyan("Meta Code — first-time setup"));
    console.log(chalk.dim("Press Enter to keep the default value shown in brackets.\n"));

    const modeAnswer = ((await rl.question(`Default mode [think_fast / think_hard] (default: think_fast): `)) || "").trim();
    let defaultMode;
    try {
      defaultMode = normalizeMode(modeAnswer || "think_fast");
    } catch {
      console.log(chalk.yellow(`Invalid mode "${modeAnswer}", using think_fast.`));
      defaultMode = "think_fast";
    }

    const stepsAnswer = ((await rl.question(`Default max agent steps [${MIN_AGENT_STEPS}-${MAX_AGENT_STEPS}] (default: ${DEFAULT_AGENT_STEPS}): `)) || "").trim();
    let defaultMaxSteps;
    try {
      defaultMaxSteps = normalizeAgentSteps(stepsAnswer || DEFAULT_AGENT_STEPS);
    } catch {
      console.log(chalk.yellow(`Invalid steps "${stepsAnswer}", using ${DEFAULT_AGENT_STEPS}.`));
      defaultMaxSteps = DEFAULT_AGENT_STEPS;
    }

    rl.close();

    await updateConfig({ defaultMode, defaultMaxSteps });
    console.log("");
    console.log(chalk.green("Configuration saved:"));
    console.log(`  defaultMode:     ${defaultMode}`);
    console.log(`  defaultMaxSteps: ${defaultMaxSteps}`);
    console.log("");
    console.log(chalk.dim("Run `meta-code auth login` to complete setup."));
  });

const sessionsCommand = program.command("sessions").description("Inspect and manage local sessions");
sessionsCommand
  .command("list")
  .description("List known sessions")
  .action(async () => {
    const info = await listSessions();
    console.log(chalk.bold(`Active session: ${info.activeSession ?? "<none>"}`));
    Object.entries(info.sessions).forEach(([name, session]) => {
      const activeTag = info.activeSession === name ? " [active]" : "";
      console.log(
        `${name}${activeTag}  mode=${session.mode}  conversationId=${session.conversationId}  branch=${session.currentBranchPath}`
      );
    });
  });

sessionsCommand
  .command("reset")
  .description("Reset session conversation context")
  .argument("[name]", "Session name")
  .action(async (name) => {
    const info = await listSessions();
    const targetName = name ?? info.activeSession ?? "default";
    const nextSession = await resetSession(targetName);
    console.log(chalk.green(`Session "${targetName}" reset.`));
    console.log(`conversationId=${nextSession.conversationId}`);
  });

sessionsCommand
  .command("delete")
  .description("Delete a session locally and on Meta by name")
  .argument("<name>", "Session name")
  .action(async (name) => {
    const result = await deleteSessionEverywhere(name);
    if (!result.deleted) {
      if (result.reason === "active_session") {
        console.log(chalk.red(`Cannot delete active session "${name}". Switch sessions first.`));
        process.exitCode = 1;
        return;
      }
      if (result.reason === "auth_required") {
        console.log(chalk.red("Deleting sessions requires auth. Run meta-code auth login first."));
        process.exitCode = 1;
        return;
      }
      console.log(chalk.yellow(`Session "${name}" was not found.`));
      return;
    }
    console.log(chalk.green(`Session "${name}" deleted.`));
    if (result.remote?.reason === "not_found") {
      console.log(chalk.yellow("Remote conversation was already missing on Meta."));
    } else {
      console.log("remote=deleted");
    }
    if (result.activeSession) {
      console.log(`activeSession=${result.activeSession}`);
    } else {
      console.log("activeSession=<none>");
    }
  });

sessionsCommand
  .command("rename")
  .description("Rename a session (only renames locally)")
  .argument("<old-name>", "Current session name")
  .argument("<new-name>", "New session name (alphanumeric, hyphens and underscores only)")
  .action(async (oldName, newName) => {
    const result = await renameSession(oldName, newName);
    if (!result.renamed) {
      const messages = {
        not_found: `Session "${oldName}" was not found.`,
        already_exists: `Session "${newName}" already exists. Choose a different name.`,
        same_name: "Old and new names are the same.",
        old_name_empty: "Old session name cannot be empty.",
        new_name_empty: "New session name cannot be empty.",
        invalid_new_name:
          'New session name must only contain letters, numbers, hyphens, and underscores.',
      };
      console.error(chalk.red(messages[result.reason] ?? `Rename failed: ${result.reason}`));
      process.exitCode = 1;
      return;
    }
    console.log(chalk.green(`Session renamed: "${oldName}" → "${newName}"`));
    if (result.activeSession === newName) {
      console.log(chalk.dim("(Active session pointer updated to new name.)"));
    }
  });

const toolsCommand = program.command("tools").description("Inspect built-in tool-enabled agent file tools");
toolsCommand
  .command("list")
  .description("List available file tools")
  .action(() => {
    FILE_TOOL_DEFINITIONS.forEach((tool) => {
      console.log(`${tool.name}(${tool.args.join(", ")})`);
      console.log(`  ${tool.description}`);
    });
  });

toolsCommand
  .command("describe")
  .description("Show detailed help for a specific file tool")
  .argument("<name>", "Tool name (e.g. edit_file, glob_files)")
  .action((name) => {
    const tool = FILE_TOOL_DEFINITIONS.find((t) => t.name === name);
    if (!tool) {
      const allNames = FILE_TOOL_DEFINITIONS.map((t) => t.name).join(", ");
      console.error(chalk.red(`Unknown tool "${name}". Available tools: ${allNames}`));
      process.exitCode = 1;
      return;
    }
    console.log(chalk.bold(`${tool.name}(${tool.args.join(", ")})`));
    console.log(`${tool.description}`);
    if (tool.details) {
      console.log("");
      console.log(tool.details);
    }
    if (tool.example) {
      console.log("");
      console.log(chalk.dim("Example:"));
      console.log(`  ${tool.example}`);
    }
  });

const memoryCommand = program
  .command("memory")
  .description("Inspect workspace instruction files that guide the agent");
memoryCommand
  .command("show")
  .description("Show loaded workspace memory files and effective instruction text")
  .action(async () => {
    const memory = await loadWorkspaceMemory(process.cwd());
    if (!memory.sources.length) {
      console.log(chalk.yellow("No workspace memory files found."));
      console.log(`Checked: ${WORKSPACE_MEMORY_FILES.join(", ")}`);
      return;
    }
    console.log(chalk.bold(`Loaded from: ${memory.sources.join(", ")}`));
    if (memory.truncated) {
      console.log(chalk.yellow("Memory text was truncated for safety."));
    }
    console.log("");
    console.log(memory.text);
  });

memoryCommand
  .command("create")
  .description("Create a META.md workspace memory file in the current directory")
  .option("--force", "Overwrite existing META.md if it exists")
  .action(async (opts) => {
    const { promises: fs } = await import("node:fs");
    const targetPath = path.join(process.cwd(), "META.md");

    let exists = false;
    try {
      await fs.access(targetPath);
      exists = true;
    } catch {
      // does not exist
    }

    if (exists && !opts.force) {
      console.log(chalk.yellow("META.md already exists. Use --force to overwrite it."));
      process.exitCode = 1;
      return;
    }

    const template = [
      "# Workspace Instructions",
      "",
      "This file is automatically loaded by Meta Code and included in every agent run.",
      "Add persistent instructions, coding conventions, or project context below.",
      "",
      "## Project overview",
      "",
      "<!-- Describe the project here -->",
      "",
      "## Coding conventions",
      "",
      "<!-- Add conventions like language, style, naming rules -->",
      "",
      "## Things to always/never do",
      "",
      "<!-- Examples: always use TypeScript, never delete test files, etc. -->",
      "",
    ].join("\n");

    await fs.writeFile(targetPath, template, "utf8");
    console.log(chalk.green(`Created META.md in ${process.cwd()}`));
    console.log(chalk.dim("Edit it to add project-specific instructions for the agent."));
  });

program
  .command("doctor")
  .description("Run quick diagnostics for auth/config/workspace health")
  .action(async () => {
    const [config, authState] = await Promise.all([
      readConfig(),
      resolveAuthState({ requireClient: false }),
    ]);
    const report = await runDoctor({
      cwd: process.cwd(),
      authSummary: authState.authSummary,
      config,
    });

    for (const check of report.checks) {
      const statusLabel =
        check.status === "ok"
          ? chalk.green("OK")
          : check.status === "warn"
            ? chalk.yellow("WARN")
            : chalk.red("ERROR");
      console.log(`${statusLabel} ${check.name}: ${check.detail}`);
    }
    if (!report.ok) {
      process.exitCode = 1;
    }
  });

await program.parseAsync(process.argv);
