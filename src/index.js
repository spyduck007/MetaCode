#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
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

  const baseSession = options.new ? await resetSession(sessionName) : session;
  const hydratedSession = await updateSession(sessionName, { ...baseSession, mode });

  return {
    client,
    sessionName,
    session: hydratedSession,
    authSummary,
    launchedFreshSession: freshSessionOnLaunch && !hasExplicitSession,
  };
}

async function runAgentTask({
  client,
  task,
  session,
  workspaceRoot = process.cwd(),
  onStatus,
  onThinking,
  onToolCall,
  onToolResult,
  onCommandApproval,
  onFollowUpQuestion,
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
    onStatus,
    onThinking,
    onToolCall,
    onToolResult,
    onCommandApproval,
    onFollowUpQuestion,
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
  .option("-s, --session <name>", "Session name")
  .option("-n, --new", "Start a new conversation in this session")
  .option("--yolo", "Auto-approve terminal command tool calls")
  .option("--json", "Print one-shot output as JSON")
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
          runAgentTask: async ({
            client,
            task,
            session,
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
      let output = "";
      const showProgress = !options.json;
      const yoloState = { enabled: Boolean(options.yolo) };
      let lastProgressMessage = "";
      let thinkingPhrase = pickThinkingPhrase();
      const progress = (message) => {
        if (!showProgress || !message || message === lastProgressMessage) return;
        lastProgressMessage = message;
        process.stderr.write(chalk.dim(`• ${message}\n`));
      };

      const result = await runAgentTask({
        client: runtime.client,
        task: prompt,
        session: runtime.session,
        onStatus: (message) => progress(describeAgentStatusFriendly(message)),
        onThinking: (message) => {
          thinkingPhrase = message?.trim() || pickThinkingPhrase(thinkingPhrase);
          progress(thinkingPhrase);
        },
        onToolCall: (call) => progress(describeToolCallFriendly(call)),
        onToolResult: (toolResult) => {
          if (!toolResult.ok) {
            progress(`ran into an issue: ${toolResult.error}`);
          }
        },
        onCommandApproval: async ({ command, cwd, timeoutMs }) => {
          return promptCommandApproval({
            command,
            cwd,
            timeoutMs,
            yoloState,
            progress,
          });
        },
        onFollowUpQuestion: async ({ question, choices, allowFreeform }) => {
          return promptAgentFollowUp({
            question,
            choices,
            allowFreeform,
            progress,
          });
        },
      });
      output = result.content;
      if (!options.json) process.stdout.write(`${output}\n`);

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
              content: output || result.content,
              session: runtime.sessionName,
              conversationId: result.conversationId,
              branchPath: result.currentBranchPath,
              mode: result.mode,
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

await program.parseAsync(process.argv);
