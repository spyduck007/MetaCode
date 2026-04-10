import process from "node:process";
import path from "node:path";
import { promises as fs } from "node:fs";
import { MIN_AGENT_STEPS, MAX_AGENT_STEPS, normalizeAgentSteps } from "./max-steps.js";
import { normalizeMode } from "./meta-client.js";
import { WORKSPACE_MEMORY_FILES } from "./workspace-memory.js";

function parseNodeMajor(version) {
  const match = String(version || "").match(/^v?(\d+)/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

export async function runDoctor({
  cwd = process.cwd(),
  authSummary = { source: "none", hasSession: "no" },
  config = {},
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

  const hasErrors = checks.some((check) => check.status === "error");

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

  return {
    ok: !hasErrors,
    checks,
  };
}
