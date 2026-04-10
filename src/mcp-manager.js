import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import {
  isMcpToolAllowed,
  normalizeMcpServerConfig,
  normalizeMcpServerName,
  normalizeMcpServers,
} from "./mcp-config.js";

const SENSITIVE_ENV_KEY_PATTERN = /(token|secret|password|cookie|credential|auth|api[_-]?key)/i;
const MCP_PROTOCOL_VERSION = "2024-11-05";

function toSafeErrorMessage(error) {
  return String(error?.message ?? error ?? "Unknown error");
}

function looksLikePackageExecCommand(commandName) {
  const normalized = path.basename(String(commandName || "").trim()).toLowerCase();
  return ["npx", "npm", "pnpm", "yarn", "bunx"].includes(normalized);
}

function withAdaptiveStartupTimeout(serverConfig) {
  const startupTimeoutMs = Number.parseInt(String(serverConfig?.startupTimeoutMs ?? ""), 10);
  if (!Number.isFinite(startupTimeoutMs)) return serverConfig;
  if (serverConfig.type !== "stdio") return serverConfig;
  if (startupTimeoutMs >= 120_000) return serverConfig;
  if (!looksLikePackageExecCommand(serverConfig.command)) return serverConfig;
  return {
    ...serverConfig,
    startupTimeoutMs: 120_000,
  };
}

function encodeRpcFrame(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const headers = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
  return Buffer.concat([headers, body]);
}

function expandEnvTemplate(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => process.env[name] ?? "")
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => process.env[name] ?? "")
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_, name) => process.env[name] ?? "");
}

function buildSanitizedEnv(customEnv = {}) {
  const base = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (SENSITIVE_ENV_KEY_PATTERN.test(key)) continue;
    base[key] = value;
  }
  for (const [key, rawValue] of Object.entries(customEnv)) {
    base[key] = expandEnvTemplate(String(rawValue ?? ""));
  }
  return base;
}

function buildHttpHeaders(serverConfig) {
  const headers = { "content-type": "application/json" };
  for (const [key, rawValue] of Object.entries(serverConfig.headers ?? {})) {
    headers[key] = expandEnvTemplate(String(rawValue ?? ""));
  }
  if (serverConfig.bearerTokenEnvVar) {
    const token = process.env[serverConfig.bearerTokenEnvVar];
    if (token) {
      headers.authorization = `Bearer ${token}`;
    }
  }
  return headers;
}

function resolveServerCwd(serverConfig, workspaceRoot) {
  const configured = serverConfig.cwd?.trim();
  if (!configured) return workspaceRoot;
  if (path.isAbsolute(configured)) return configured;
  return path.resolve(workspaceRoot, configured);
}

function parseToolArgsFromInputSchema(inputSchema) {
  const schema = inputSchema && typeof inputSchema === "object" ? inputSchema : {};
  const props = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.keys(props).map((name) => `${name}${required.has(name) ? "" : "?"}`);
}

function buildExposedToolName(serverName, toolName) {
  return `mcp.${serverName}.${toolName}`;
}

function extractRpcError(errorPayload) {
  if (!errorPayload || typeof errorPayload !== "object") return "Unknown MCP error.";
  const message = String(errorPayload.message ?? "Unknown MCP error.");
  const code =
    typeof errorPayload.code === "number" || typeof errorPayload.code === "string"
      ? ` (code=${errorPayload.code})`
      : "";
  return `${message}${code}`;
}

class StdioMcpClient {
  constructor(serverConfig, workspaceRoot) {
    this.serverConfig = serverConfig;
    this.workspaceRoot = workspaceRoot;
    this.child = null;
    this.buffer = Buffer.alloc(0);
    this.lineBuffer = "";
    this.nextRequestId = 1;
    this.pending = new Map();
    this.initialized = false;
    this.stderrTail = "";
    this.protocolMode = "content-length";
  }

  async ensureStarted() {
    if (this.child) return;
    if (!this.serverConfig.command) {
      throw new Error(`MCP server "${this.serverConfig.name}" is stdio but command is missing.`);
    }

    const cwd = resolveServerCwd(this.serverConfig, this.workspaceRoot);
    this.child = spawn(this.serverConfig.command, this.serverConfig.args, {
      cwd,
      env: buildSanitizedEnv(this.serverConfig.env),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });

    this.child.stdout.on("data", (chunk) => {
      if (this.protocolMode === "jsonl") {
        this.lineBuffer += chunk.toString("utf8");
        this.#flushJsonLines();
        return;
      }
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.#flushFrames();
    });

    this.child.stderr.on("data", (chunk) => {
      this.stderrTail += chunk.toString("utf8");
      if (this.stderrTail.length > 2_000) {
        this.stderrTail = this.stderrTail.slice(-2_000);
      }
    });

    this.child.on("error", (error) => {
      this.#rejectAllPending(`MCP stdio process error: ${toSafeErrorMessage(error)}`);
    });

    this.child.on("close", (code, signal) => {
      const reason = `MCP stdio process exited (code=${code ?? "null"}, signal=${signal ?? "null"})`;
      this.#rejectAllPending(`${reason}${this.stderrTail ? `\n${this.stderrTail}` : ""}`);
      this.child = null;
      this.initialized = false;
      this.buffer = Buffer.alloc(0);
      this.lineBuffer = "";
    });
  }

  #flushFrames() {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const headerText = this.buffer.slice(0, headerEnd).toString("utf8");
      const contentLengthMatch = headerText.match(/content-length:\s*(\d+)/i);
      if (!contentLengthMatch) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const contentLength = Number.parseInt(contentLengthMatch[1], 10);
      const frameEnd = headerEnd + 4 + contentLength;
      if (this.buffer.length < frameEnd) return;
      const payloadText = this.buffer.slice(headerEnd + 4, frameEnd).toString("utf8");
      this.buffer = this.buffer.slice(frameEnd);

      let payload;
      try {
        payload = JSON.parse(payloadText);
      } catch {
        continue;
      }
      this.#handlePayload(payload);
    }
  }

  #handlePayload(payload) {
    const responseId = payload?.id;
    if (responseId === undefined || responseId === null) return;
    const pending = this.pending.get(responseId);
    if (!pending) return;
    this.pending.delete(responseId);
    if (payload.error) {
      pending.reject(new Error(extractRpcError(payload.error)));
      return;
    }
    pending.resolve(payload.result);
  }

  #flushJsonLines() {
    let newlineIndex = this.lineBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.lineBuffer.slice(0, newlineIndex).trim();
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      newlineIndex = this.lineBuffer.indexOf("\n");
      if (!line) continue;
      let payload;
      try {
        payload = JSON.parse(line);
      } catch {
        continue;
      }
      this.#handlePayload(payload);
    }
  }

  #rejectAllPending(message) {
    const error = new Error(message);
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  async request(method, params = {}, timeoutMs = this.serverConfig.toolTimeoutMs) {
    await this.ensureStarted();
    const id = this.nextRequestId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `MCP request timed out after ${timeoutMs}ms (${method}).${
              this.stderrTail ? `\n${this.stderrTail}` : ""
            }`
          )
        );
      }, timeoutMs);
      timer.unref();

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      if (this.protocolMode === "jsonl") {
        this.child.stdin.write(`${JSON.stringify(payload)}\n`);
      } else {
        this.child.stdin.write(encodeRpcFrame(payload));
      }
    });
  }

  notify(method, params = {}) {
    if (!this.child) return;
    const payload = { jsonrpc: "2.0", method, params };
    if (this.protocolMode === "jsonl") {
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    } else {
      this.child.stdin.write(encodeRpcFrame(payload));
    }
  }

  async initialize() {
    if (this.initialized) return;
    const initializeParams = {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: "meta-code",
        version: "1.0.0",
      },
    };

    const tryInitialize = async (timeoutMs) => {
      await this.request("initialize", initializeParams, timeoutMs);
      this.notify("notifications/initialized", {});
      this.initialized = true;
    };

    if (this.protocolMode === "jsonl") {
      await tryInitialize(this.serverConfig.startupTimeoutMs);
      return;
    }

    const probeTimeoutMs = Math.min(this.serverConfig.startupTimeoutMs, 12_000);
    try {
      await tryInitialize(probeTimeoutMs);
      return;
    } catch (contentLengthError) {
      if (!/timed out/i.test(toSafeErrorMessage(contentLengthError))) {
        throw contentLengthError;
      }

      await this.close();
      this.protocolMode = "jsonl";
      await this.ensureStarted();
      try {
        await tryInitialize(this.serverConfig.startupTimeoutMs);
        return;
      } catch (jsonlError) {
        await this.close();
        this.protocolMode = "content-length";
        await this.ensureStarted();
        await tryInitialize(this.serverConfig.startupTimeoutMs);
      }
    }
  }

  async listTools() {
    await this.initialize();
    const tools = [];
    let cursor;
    do {
      const result = await this.request(
        "tools/list",
        cursor ? { cursor } : {},
        this.serverConfig.toolTimeoutMs
      );
      const pageTools = Array.isArray(result?.tools) ? result.tools : [];
      tools.push(...pageTools);
      cursor = typeof result?.nextCursor === "string" ? result.nextCursor : null;
    } while (cursor);
    return tools;
  }

  async callTool(toolName, args = {}) {
    await this.initialize();
    return this.request(
      "tools/call",
      {
        name: toolName,
        arguments: args,
      },
      this.serverConfig.toolTimeoutMs
    );
  }

  async close() {
    this.#rejectAllPending("MCP client closed.");
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.initialized = false;

    const onClose = new Promise((resolve) => {
      child.once("close", resolve);
    });
    child.kill("SIGTERM");
    await Promise.race([onClose, delay(250)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await Promise.race([onClose, delay(250)]);
    }

    this.child = null;
    this.initialized = false;
  }
}

class HttpLikeMcpClient {
  constructor(serverConfig) {
    this.serverConfig = serverConfig;
    this.initialized = false;
  }

  get endpoint() {
    if (this.serverConfig.type === "sse") {
      return this.serverConfig.messageUrl || this.serverConfig.url;
    }
    return this.serverConfig.url;
  }

  async request(method, params = {}, timeoutMs = this.serverConfig.toolTimeoutMs) {
    const endpoint = this.endpoint;
    if (!endpoint) {
      throw new Error(
        `MCP server "${this.serverConfig.name}" is ${this.serverConfig.type} but URL is missing.`
      );
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref();
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: buildHttpHeaders(this.serverConfig),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`HTTP ${response.status}: ${body.slice(0, 500)}`);
      }
      const payload = await response.json();
      if (payload?.error) {
        throw new Error(extractRpcError(payload.error));
      }
      return payload?.result;
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error(`MCP HTTP request timed out after ${timeoutMs}ms (${method}).`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async initialize() {
    if (this.initialized) return;
    await this.request(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: "meta-code",
          version: "1.0.0",
        },
      },
      this.serverConfig.startupTimeoutMs
    );
    this.initialized = true;
  }

  async listTools() {
    await this.initialize();
    const result = await this.request("tools/list", {}, this.serverConfig.toolTimeoutMs);
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(toolName, args = {}) {
    await this.initialize();
    return this.request(
      "tools/call",
      {
        name: toolName,
        arguments: args,
      },
      this.serverConfig.toolTimeoutMs
    );
  }

  async close() {
    this.initialized = false;
  }
}

export function isMcpToolCallName(toolName) {
  return String(toolName || "").startsWith("mcp.");
}

export function formatMcpToolDefinitionsForPrompt(tools = []) {
  if (!Array.isArray(tools) || tools.length === 0) return "";
  return tools
    .map((tool) => {
      const args = tool.args?.length ? tool.args.join(", ") : "none";
      return `- ${tool.name}: ${tool.description || "MCP tool"} Args: ${args}`;
    })
    .join("\n");
}

export class MCPManager {
  constructor({ workspaceRoot = process.cwd(), mcpServers = {} } = {}) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.servers = normalizeMcpServers(mcpServers);
    this.clients = new Map();
    this.toolIndex = new Map();
  }

  getServer(name) {
    const normalized = normalizeMcpServerName(name);
    return this.servers[normalized] ?? null;
  }

  getEnabledServers() {
    return Object.values(this.servers).filter((server) => server.enabled);
  }

  async #getClient(serverConfig) {
    const existing = this.clients.get(serverConfig.name);
    if (existing) return existing;
    const effectiveServerConfig = withAdaptiveStartupTimeout(serverConfig);
    let client;
    if (effectiveServerConfig.type === "stdio") {
      client = new StdioMcpClient(effectiveServerConfig, this.workspaceRoot);
    } else {
      client = new HttpLikeMcpClient(effectiveServerConfig);
    }
    this.clients.set(serverConfig.name, client);
    return client;
  }

  async discoverTools() {
    this.toolIndex.clear();
    const tools = [];
    const errors = [];

    for (const server of this.getEnabledServers()) {
      try {
        const client = await this.#getClient(server);
        const serverTools = await client.listTools();
        for (const tool of serverTools) {
          const rawToolName = String(tool?.name ?? "").trim();
          if (!rawToolName) continue;
          if (!isMcpToolAllowed(server, rawToolName)) continue;

          const exposedName = buildExposedToolName(server.name, rawToolName);
          const entry = {
            exposedName,
            serverName: server.name,
            toolName: rawToolName,
            description:
              typeof tool?.description === "string" && tool.description.trim()
                ? `[MCP ${server.name}] ${tool.description.trim()}`
                : `[MCP ${server.name}] ${rawToolName}`,
            inputSchema: tool?.inputSchema ?? {},
            args: parseToolArgsFromInputSchema(tool?.inputSchema),
          };
          this.toolIndex.set(exposedName, entry);
          tools.push({
            name: entry.exposedName,
            description: entry.description,
            args: entry.args,
            serverName: entry.serverName,
            toolName: entry.toolName,
          });
        }
      } catch (error) {
        errors.push({
          server: server.name,
          error: toSafeErrorMessage(error),
        });
      }
    }

    return { tools, errors };
  }

  async testServer(name) {
    const server = this.getServer(name);
    if (!server) {
      throw new Error(`Unknown MCP server "${name}".`);
    }
    const client = await this.#getClient(server);
    const tools = await client.listTools();
    return {
      server: server.name,
      type: server.type,
      toolCount: tools.length,
      tools: tools.map((tool) => String(tool?.name ?? "").trim()).filter(Boolean),
    };
  }

  async executeToolCall(call, { onApproval } = {}) {
    const exposedName = String(call?.name ?? "");
    const entry = this.toolIndex.get(exposedName);
    if (!entry) {
      return { ok: false, name: exposedName, error: `Unknown MCP tool "${exposedName}".` };
    }

    const server = this.getServer(entry.serverName);
    if (!server) {
      return {
        ok: false,
        name: exposedName,
        error: `MCP server "${entry.serverName}" is no longer configured.`,
      };
    }
    if (!server.enabled) {
      return { ok: false, name: exposedName, error: `MCP server "${entry.serverName}" is disabled.` };
    }

    if (!server.trust && typeof onApproval === "function") {
      const decision = await onApproval({
        serverName: entry.serverName,
        toolName: entry.toolName,
        arguments: call?.arguments ?? {},
        timeoutMs: server.toolTimeoutMs,
      });
      if (!decision?.approved) {
        return {
          ok: false,
          name: exposedName,
          error: decision?.reason || `MCP tool call "${exposedName}" was not approved.`,
        };
      }
    }

    try {
      const client = await this.#getClient(server);
      const result = await client.callTool(entry.toolName, call?.arguments ?? {});
      return {
        ok: true,
        name: exposedName,
        result: {
          server: entry.serverName,
          tool: entry.toolName,
          isError: Boolean(result?.isError),
          content: result?.content ?? result,
          raw: result,
        },
      };
    } catch (error) {
      return { ok: false, name: exposedName, error: toSafeErrorMessage(error) };
    }
  }

  async close() {
    await Promise.all(
      [...this.clients.values()].map(async (client) => {
        try {
          await client.close();
        } catch {
          // best-effort cleanup
        }
      })
    );
    this.clients.clear();
    this.toolIndex.clear();
  }
}

export function normalizeMcpServerForDisplay(name, config) {
  return normalizeMcpServerConfig(name, config);
}
