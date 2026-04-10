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
import {
  FILE_TOOL_DEFINITIONS,
  executeFileToolCall,
  formatToolDefinitionsForPrompt,
  isBuiltInFileToolName,
} from "./file-tools.js";
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
import { formatMcpToolDefinitionsForPrompt, MCPManager } from "./mcp-manager.js";
import {
  normalizeMcpServerConfig,
  normalizeMcpServerName,
  parseKeyValueEntries,
  removeMcpServerConfig,
  summarizeMcpServer,
  upsertMcpServerConfig,
} from "./mcp-config.js";

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

function buildToolDefinitionsForAgent(mcpTools = []) {
  if (!mcpTools.length) {
    return formatToolDefinitionsForPrompt();
  }
  return [formatToolDefinitionsForPrompt(), formatMcpToolDefinitionsForPrompt(mcpTools)]
    .filter(Boolean)
    .join("\n");
}

function formatMcpApprovalCommand({ serverName, toolName, args }) {
  const serializedArgs = JSON.stringify(args ?? {});
  return `mcp ${serverName}.${toolName} ${serializedArgs.length > 240 ? `${serializedArgs.slice(0, 240)}...` : serializedArgs}`;
}

async function buildMcpRuntime({ workspaceRoot }) {
  const config = await readConfig();
  const manager = new MCPManager({
    workspaceRoot,
    mcpServers: config.mcpServers,
  });
  const discovery = await manager.discoverTools();
  return {
    manager,
    tools: discovery.tools,
    errors: discovery.errors,
  };
}

function createInteractiveMcpController({ workspaceRoot }) {
  let manager = null;
  let cachedDiscovery = null;
  let discoveryPromise = null;

  async function closeManager() {
    const activeManager = manager;
    manager = null;
    cachedDiscovery = null;
    if (!activeManager) return;
    await activeManager.close();
  }

  async function ensureManager() {
    if (manager) return manager;
    const config = await readConfig();
    manager = new MCPManager({
      workspaceRoot,
      mcpServers: config.mcpServers,
    });
    return manager;
  }

  async function discover({ refresh = false } = {}) {
    if (refresh) {
      if (discoveryPromise) {
        await discoveryPromise.catch(() => {});
      }
      await closeManager();
    } else {
      if (cachedDiscovery) return cachedDiscovery;
      if (discoveryPromise) return discoveryPromise;
    }

    discoveryPromise = (async () => {
      const activeManager = await ensureManager();
      const result = await activeManager.discoverTools();
      cachedDiscovery = {
        tools: result.tools,
        errors: result.errors,
      };
      return cachedDiscovery;
    })();

    try {
      return await discoveryPromise;
    } finally {
      discoveryPromise = null;
    }
  }

  return {
    discover,
    prewarm: () => discover({ refresh: true }),
    testServer: async (name) => {
      const activeManager = await ensureManager();
      return activeManager.testServer(name);
    },
    getRuntimeSnapshot: async () => {
      const discovery = await discover();
      const activeManager = await ensureManager();
      return {
        manager: activeManager,
        tools: discovery.tools,
        errors: discovery.errors,
      };
    },
    close: closeManager,
  };
}

async function runAgentTask({
  client,
  task,
  session,
  workspaceRoot = process.cwd(),
  mcpRuntime = null,
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
  const runtime = mcpRuntime ?? (await buildMcpRuntime({ workspaceRoot }));
  const toolDescriptions = buildToolDefinitionsForAgent(runtime.tools);
  if (runtime.errors.length > 0 && typeof onStatus === "function") {
    onStatus("mcp degraded");
  }

  try {
    return await runAgentWithFileTools({
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
      toolDescriptions,
      executeToolCall: async (call, context) => {
        if (isBuiltInFileToolName(call?.name)) {
          return executeFileToolCall(call, {
            workspaceRoot: context.workspaceRoot,
            confirmCommand:
              call?.name === "run_command" && typeof context.onCommandApproval === "function"
                ? context.onCommandApproval
                : undefined,
          });
        }

        return runtime.manager.executeToolCall(call, {
          onApproval:
            typeof context.onCommandApproval === "function"
              ? ({ serverName, toolName, arguments: args, timeoutMs }) =>
                  context.onCommandApproval({
                    command: formatMcpApprovalCommand({ serverName, toolName, args }),
                    cwd: "mcp",
                    timeoutMs,
                  })
              : undefined,
        });
      },
    });
  } finally {
    if (!mcpRuntime) {
      await runtime.manager.close();
    }
  }
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

async function listMcpServersFromConfig() {
  const config = await readConfig();
  return config.mcpServers ?? {};
}

async function saveMcpServersToConfig(nextServers) {
  await updateConfig({ mcpServers: nextServers });
  const config = await readConfig();
  return config.mcpServers ?? {};
}

async function upsertMcpServer(name, partialConfig) {
  const config = await readConfig();
  const nextServers = upsertMcpServerConfig(config.mcpServers, name, partialConfig);
  return saveMcpServersToConfig(nextServers);
}

async function removeMcpServer(name) {
  const config = await readConfig();
  const nextServers = removeMcpServerConfig(config.mcpServers, name);
  return saveMcpServersToConfig(nextServers);
}

async function testMcpServer(name, { workspaceRoot = process.cwd() } = {}) {
  const config = await readConfig();
  const manager = new MCPManager({
    workspaceRoot,
    mcpServers: config.mcpServers,
  });
  try {
    return await manager.testServer(name);
  } finally {
    await manager.close();
  }
}

async function discoverMcpTools({ workspaceRoot = process.cwd() } = {}) {
  const runtime = await buildMcpRuntime({ workspaceRoot });
  try {
    return {
      tools: runtime.tools,
      errors: runtime.errors,
    };
  } finally {
    await runtime.manager.close();
  }
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
        const workspaceRoot = process.cwd();
        const interactiveMcp = createInteractiveMcpController({ workspaceRoot });
        void interactiveMcp.prewarm().catch(() => {});

        const refreshInteractiveMcp = () => {
          void interactiveMcp.discover({ refresh: true }).catch(() => {});
        };

        let tuiResult;
        try {
          tuiResult = await startTui({
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
            getConfig: async () => readConfig(),
            listMcpServers: async () => listMcpServersFromConfig(),
            setMcpServerEnabled: async (name, enabled) => {
              const updated = await upsertMcpServer(name, { enabled: Boolean(enabled) });
              refreshInteractiveMcp();
              return updated;
            },
            setMcpServerTrust: async (name, trust) => {
              const updated = await upsertMcpServer(name, { trust: Boolean(trust) });
              refreshInteractiveMcp();
              return updated;
            },
            removeMcpServer: async (name) => {
              const updated = await removeMcpServer(name);
              refreshInteractiveMcp();
              return updated;
            },
            testMcpServer: async (name) => interactiveMcp.testServer(name),
            discoverMcpTools: async () => interactiveMcp.discover(),
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
            }) => {
              const mcpRuntime = await interactiveMcp.getRuntimeSnapshot();
              return runAgentTask({
                client: client ?? runtime.client,
                task,
                session,
                workspaceRoot,
                mcpRuntime,
                maxSteps: maxSteps ?? runtime.maxSteps,
                onStatus,
                onThinking,
                onToolCall,
                onToolResult,
                onCommandApproval,
                onFollowUpQuestion,
              });
            },
          });
        } finally {
          await interactiveMcp.close();
        }
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

const toolsCommand = program.command("tools").description("Inspect available agent tools");
toolsCommand
  .command("list")
  .description("List available file tools")
  .action(async () => {
    FILE_TOOL_DEFINITIONS.forEach((tool) => {
      console.log(`${tool.name}(${tool.args.join(", ")})`);
      console.log(`  ${tool.description}`);
    });

    const mcpSummary = await discoverMcpTools({ workspaceRoot: process.cwd() });
    if (mcpSummary.tools.length > 0) {
      console.log("");
      console.log(chalk.bold("MCP tools"));
      mcpSummary.tools
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach((tool) => {
          console.log(`${tool.name}(${tool.args.join(", ")})`);
          console.log(`  ${tool.description}`);
        });
    }
    if (mcpSummary.errors.length > 0) {
      console.log("");
      console.log(chalk.yellow("MCP discovery errors:"));
      mcpSummary.errors.forEach((entry) => {
        console.log(`- ${entry.server}: ${entry.error}`);
      });
    }
  });

toolsCommand
  .command("describe")
  .description("Show detailed help for a specific file tool")
  .argument("<name>", "Tool name (e.g. edit_file, glob_files)")
  .action(async (name) => {
    const tool = FILE_TOOL_DEFINITIONS.find((t) => t.name === name);
    if (tool) {
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
      return;
    }

    const mcpSummary = await discoverMcpTools({ workspaceRoot: process.cwd() });
    const mcpTool = mcpSummary.tools.find((entry) => entry.name === name);
    if (mcpTool) {
      console.log(chalk.bold(`${mcpTool.name}(${mcpTool.args.join(", ")})`));
      console.log(`${mcpTool.description}`);
      console.log("");
      console.log(
        chalk.dim(
          `MCP source: server=${mcpTool.serverName}, tool=${mcpTool.toolName}. Configure with 'meta-code mcp ...'.`
        )
      );
      return;
    }

    const allNames = [...FILE_TOOL_DEFINITIONS.map((t) => t.name), ...mcpSummary.tools.map((t) => t.name)];
    console.error(chalk.red(`Unknown tool "${name}". Available tools: ${allNames.join(", ")}`));
    process.exitCode = 1;
  });

const mcpCommand = program.command("mcp").description("Manage MCP servers and discovered MCP tools");

mcpCommand
  .command("list")
  .description("List configured MCP servers")
  .action(async () => {
    const servers = await listMcpServersFromConfig();
    const names = Object.keys(servers).sort((a, b) => a.localeCompare(b));
    if (names.length === 0) {
      console.log(chalk.yellow("No MCP servers configured."));
      return;
    }
    for (const name of names) {
      console.log(summarizeMcpServer(servers[name]));
    }
  });

mcpCommand
  .command("add-stdio")
  .allowUnknownOption(true)
  .description("Add or update a stdio MCP server")
  .argument("<name>", "Server name")
  .argument("<command>", "Executable command")
  .argument("[args...]", "Command arguments")
  .option("--cwd <path>", "Working directory (default: current workspace)")
  .option("--env <entry...>", "Environment variable entry KEY=VALUE")
  .option("--allow-tools <csv>", "Comma-separated allowlist of tool names")
  .option("--deny-tools <csv>", "Comma-separated denylist of tool names")
  .option("--startup-timeout <ms>", "Startup timeout in milliseconds")
  .option("--tool-timeout <ms>", "Tool call timeout in milliseconds")
  .option("--disable", "Create server in disabled state", false)
  .option("--trust", "Trust server and skip per-call approval prompts", false)
  .action(async (name, commandName, args = [], options) => {
    const envEntries = Array.isArray(options.env)
      ? options.env
      : options.env
        ? [options.env]
        : [];
    const env = parseKeyValueEntries(envEntries);
    const server = normalizeMcpServerConfig(name, {
      type: "stdio",
      command: commandName,
      args,
      cwd: options.cwd,
      env,
      allowTools: options.allowTools,
      denyTools: options.denyTools,
      enabled: !options.disable,
      trust: options.trust,
      startupTimeoutMs: options.startupTimeout,
      toolTimeoutMs: options.toolTimeout,
    });
    await upsertMcpServer(server.name, server);
    console.log(chalk.green(`Saved MCP server "${server.name}".`));
  });

mcpCommand
  .command("add-http")
  .description("Add or update an HTTP MCP server")
  .argument("<name>", "Server name")
  .argument("<url>", "HTTP endpoint URL")
  .option("--header <entry...>", "Header entry KEY=VALUE")
  .option("--bearer-env <name>", "Environment variable containing bearer token")
  .option("--allow-tools <csv>", "Comma-separated allowlist of tool names")
  .option("--deny-tools <csv>", "Comma-separated denylist of tool names")
  .option("--startup-timeout <ms>", "Startup timeout in milliseconds")
  .option("--tool-timeout <ms>", "Tool call timeout in milliseconds")
  .option("--disable", "Create server in disabled state", false)
  .option("--trust", "Trust server and skip per-call approval prompts", false)
  .action(async (name, url, options) => {
    const headerEntries = Array.isArray(options.header)
      ? options.header
      : options.header
        ? [options.header]
        : [];
    const headers = parseKeyValueEntries(headerEntries);
    const server = normalizeMcpServerConfig(name, {
      type: "http",
      url,
      headers,
      bearerTokenEnvVar: options.bearerEnv,
      allowTools: options.allowTools,
      denyTools: options.denyTools,
      enabled: !options.disable,
      trust: options.trust,
      startupTimeoutMs: options.startupTimeout,
      toolTimeoutMs: options.toolTimeout,
    });
    await upsertMcpServer(server.name, server);
    console.log(chalk.green(`Saved MCP server "${server.name}".`));
  });

mcpCommand
  .command("add-sse")
  .description("Add or update an SSE MCP server")
  .argument("<name>", "Server name")
  .argument("<url>", "SSE endpoint URL")
  .option("--message-url <url>", "Optional message POST endpoint URL")
  .option("--header <entry...>", "Header entry KEY=VALUE")
  .option("--bearer-env <name>", "Environment variable containing bearer token")
  .option("--allow-tools <csv>", "Comma-separated allowlist of tool names")
  .option("--deny-tools <csv>", "Comma-separated denylist of tool names")
  .option("--startup-timeout <ms>", "Startup timeout in milliseconds")
  .option("--tool-timeout <ms>", "Tool call timeout in milliseconds")
  .option("--disable", "Create server in disabled state", false)
  .option("--trust", "Trust server and skip per-call approval prompts", false)
  .action(async (name, url, options) => {
    const headerEntries = Array.isArray(options.header)
      ? options.header
      : options.header
        ? [options.header]
        : [];
    const headers = parseKeyValueEntries(headerEntries);
    const server = normalizeMcpServerConfig(name, {
      type: "sse",
      url,
      messageUrl: options.messageUrl,
      headers,
      bearerTokenEnvVar: options.bearerEnv,
      allowTools: options.allowTools,
      denyTools: options.denyTools,
      enabled: !options.disable,
      trust: options.trust,
      startupTimeoutMs: options.startupTimeout,
      toolTimeoutMs: options.toolTimeout,
    });
    await upsertMcpServer(server.name, server);
    console.log(chalk.green(`Saved MCP server "${server.name}".`));
  });

mcpCommand
  .command("remove")
  .description("Remove an MCP server from config")
  .argument("<name>", "Server name")
  .action(async (name) => {
    const normalizedName = normalizeMcpServerName(name);
    const servers = await listMcpServersFromConfig();
    if (!servers[normalizedName]) {
      console.log(chalk.yellow(`MCP server "${normalizedName}" was not found.`));
      return;
    }
    await removeMcpServer(normalizedName);
    console.log(chalk.green(`Removed MCP server "${normalizedName}".`));
  });

mcpCommand
  .command("enable")
  .description("Enable a configured MCP server")
  .argument("<name>", "Server name")
  .action(async (name) => {
    const normalizedName = normalizeMcpServerName(name);
    const servers = await listMcpServersFromConfig();
    if (!servers[normalizedName]) {
      throw new Error(`Unknown MCP server "${normalizedName}".`);
    }
    await upsertMcpServer(normalizedName, { enabled: true });
    console.log(chalk.green(`Enabled MCP server "${normalizedName}".`));
  });

mcpCommand
  .command("disable")
  .description("Disable a configured MCP server")
  .argument("<name>", "Server name")
  .action(async (name) => {
    const normalizedName = normalizeMcpServerName(name);
    const servers = await listMcpServersFromConfig();
    if (!servers[normalizedName]) {
      throw new Error(`Unknown MCP server "${normalizedName}".`);
    }
    await upsertMcpServer(normalizedName, { enabled: false });
    console.log(chalk.green(`Disabled MCP server "${normalizedName}".`));
  });

mcpCommand
  .command("trust")
  .description("Set trust mode for an MCP server (on|off)")
  .argument("<name>", "Server name")
  .argument("<mode>", "on|off")
  .action(async (name, mode) => {
    const normalizedName = normalizeMcpServerName(name);
    const servers = await listMcpServersFromConfig();
    if (!servers[normalizedName]) {
      throw new Error(`Unknown MCP server "${normalizedName}".`);
    }
    const normalizedMode = String(mode ?? "").trim().toLowerCase();
    if (!["on", "off"].includes(normalizedMode)) {
      throw new Error('Trust mode must be "on" or "off".');
    }
    await upsertMcpServer(normalizedName, { trust: normalizedMode === "on" });
    console.log(chalk.green(`Trust for "${normalizedName}" set to ${normalizedMode}.`));
  });

mcpCommand
  .command("test")
  .description("Initialize a server and list discovered tools")
  .argument("<name>", "Server name")
  .action(async (name) => {
    const result = await testMcpServer(name);
    console.log(
      chalk.green(
        `MCP server "${result.server}" (${result.type}) is reachable. tools=${result.toolCount}`
      )
    );
    if (result.tools.length > 0) {
      result.tools.forEach((tool) => console.log(`- ${tool}`));
    }
  });

mcpCommand
  .command("tools")
  .description("List discovered MCP tools across enabled servers")
  .argument("[server]", "Optional server name filter")
  .action(async (server) => {
    const filter = server ? normalizeMcpServerName(server) : "";
    const { tools, errors } = await discoverMcpTools();
    const visibleTools = filter ? tools.filter((tool) => tool.serverName === filter) : tools;
    if (visibleTools.length === 0) {
      console.log(chalk.yellow("No MCP tools discovered."));
    } else {
      visibleTools
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach((tool) => console.log(`${tool.name}(${tool.args.join(", ")})`));
    }
    if (errors.length > 0) {
      console.log("");
      console.log(chalk.yellow("Discovery errors:"));
      errors.forEach((entry) => {
        console.log(`- ${entry.server}: ${entry.error}`);
      });
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
    const mcpSummary = await discoverMcpTools({ workspaceRoot: process.cwd() });
    const report = await runDoctor({
      cwd: process.cwd(),
      authSummary: authState.authSummary,
      config,
      mcpSummary,
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
