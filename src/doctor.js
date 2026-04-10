import process from "node:process";
import path from "node:path";
import { promises as fs } from "node:fs";
import { MIN_AGENT_STEPS, MAX_AGENT_STEPS, normalizeAgentSteps } from "./max-steps.js";
import { normalizeMode } from "./meta-client.js";
import { WORKSPACE_MEMORY_FILES } from "./workspace-memory.js";
import { normalizeMcpServers } from "./mcp-config.js";

function parseNodeMajor(version) {
  const match = String(version || "").match(/^v?(\d+)/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

export async function runDoctor({
  cwd = process.cwd(),
  authSummary = { source: "none", hasSession: "no" },
  config = {},
  mcpSummary = null,
} = {}) {
  const checks = [];
  const nodeMajor = parseNodeMajor(process.version);
  checks.push({
    name: "node-version",
    status: nodeMajor >= 20 ? "ok" : "error",
    detail: `Detected ${process.version} (requires >= v20).`,
  });

  const normalizedMode = (() => {
    try {
      return normalizeMode(config.defaultMode);
    } catch {
      return null;
    }
  })();
  checks.push({
    name: "default-mode",
    status: normalizedMode ? "ok" : "warn",
    detail: normalizedMode
      ? `defaultMode=${normalizedMode}`
      : `defaultMode is invalid (${String(config.defaultMode ?? "unset")}).`,
  });

  const normalizedSteps = (() => {
    try {
      return normalizeAgentSteps(config.defaultMaxSteps);
    } catch {
      return null;
    }
  })();
  checks.push({
    name: "max-steps",
    status: normalizedSteps ? "ok" : "warn",
    detail: normalizedSteps
      ? `defaultMaxSteps=${normalizedSteps} (${MIN_AGENT_STEPS}-${MAX_AGENT_STEPS} allowed)`
      : `defaultMaxSteps is invalid (${String(config.defaultMaxSteps ?? "unset")}).`,
  });

  checks.push({
    name: "auth",
    status: authSummary?.hasSession === "yes" ? "ok" : "warn",
    detail: `source=${authSummary?.source ?? "unknown"}, has_session_cookie=${authSummary?.hasSession ?? "no"}`,
  });

  const workspaceRoot = path.resolve(cwd);
  const probePath = path.join(workspaceRoot, ".meta-code-doctor-write-check.tmp");
  try {
    await fs.writeFile(probePath, "ok", "utf8");
    await fs.rm(probePath, { force: true });
    checks.push({
      name: "workspace-write",
      status: "ok",
      detail: `Writable workspace: ${workspaceRoot}`,
    });
  } catch (error) {
    checks.push({
      name: "workspace-write",
      status: "error",
      detail: `Cannot write to ${workspaceRoot}: ${error.message}`,
    });
  }

  // Check for workspace memory
  const foundMemoryFiles = [];
  for (const memFile of WORKSPACE_MEMORY_FILES) {
    const memPath = path.join(workspaceRoot, memFile);
    try {
      await fs.access(memPath);
      foundMemoryFiles.push(memFile);
    } catch {
      // file doesn't exist
    }
  }
  checks.push({
    name: "workspace-memory",
    status: foundMemoryFiles.length > 0 ? "ok" : "warn",
    detail:
      foundMemoryFiles.length > 0
        ? `Found: ${foundMemoryFiles.join(", ")}`
        : `No workspace memory file found. Create META.md, METACODE.md, or .meta-code/instructions.md to add persistent project instructions.`,
  });

  const mcpServers = normalizeMcpServers(config.mcpServers);
  const mcpEnabled = Object.values(mcpServers).filter((server) => server.enabled);
  checks.push({
    name: "mcp-servers",
    status: mcpEnabled.length > 0 ? "ok" : "warn",
    detail:
      mcpEnabled.length > 0
        ? `${mcpEnabled.length} enabled / ${Object.keys(mcpServers).length} configured`
        : "No enabled MCP servers configured.",
  });

  const malformedEnabledServers = mcpEnabled.filter((server) => {
    if (server.type === "stdio") return !server.command;
    return !server.url;
  });
  if (malformedEnabledServers.length > 0) {
    checks.push({
      name: "mcp-config",
      status: "warn",
      detail: `Enabled servers missing command/url: ${malformedEnabledServers
        .map((server) => server.name)
        .join(", ")}`,
    });
  } else if (mcpEnabled.length > 0) {
    checks.push({
      name: "mcp-config",
      status: "ok",
      detail: "Enabled MCP server configurations look valid.",
    });
  }

  if (mcpSummary && typeof mcpSummary === "object") {
    const toolCount = Array.isArray(mcpSummary.tools) ? mcpSummary.tools.length : 0;
    const errorCount = Array.isArray(mcpSummary.errors) ? mcpSummary.errors.length : 0;
    checks.push({
      name: "mcp-tools",
      status: toolCount > 0 || mcpEnabled.length === 0 ? "ok" : "warn",
      detail:
        toolCount > 0
          ? `${toolCount} MCP tool(s) discovered.`
          : mcpEnabled.length > 0
            ? "No MCP tools discovered from enabled servers."
            : "No enabled MCP servers to discover tools from.",
    });
    if (errorCount > 0) {
      checks.push({
        name: "mcp-discovery",
        status: "warn",
        detail: mcpSummary.errors.map((entry) => `${entry.server}: ${entry.error}`).join(" | "),
      });
    }
  }

  const hasErrors = checks.some((check) => check.status === "error");
  return { ok: !hasErrors, checks };
}
