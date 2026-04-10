const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;
const SUPPORTED_MCP_TRANSPORTS = new Set(["stdio", "http", "sse"]);

function clampTimeout(value, fallback) {
  const numeric = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, numeric));
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(lowered)) return true;
    if (["false", "0", "no", "off"].includes(lowered)) return false;
  }
  return fallback;
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry ?? "").trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeStringMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output = {};
  for (const [key, raw] of Object.entries(value)) {
    const normalizedKey = String(key ?? "").trim();
    if (!normalizedKey) continue;
    output[normalizedKey] = String(raw ?? "");
  }
  return output;
}

export function normalizeMcpServerName(name) {
  const normalized = String(name ?? "").trim();
  if (!normalized) {
    throw new Error("MCP server name cannot be empty.");
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(normalized)) {
    throw new Error("MCP server name must only contain letters, numbers, hyphens, and underscores.");
  }
  return normalized;
}

export function normalizeMcpServerConfig(name, rawConfig = {}) {
  const normalizedName = normalizeMcpServerName(name);
  const rawType = String(rawConfig.type ?? "").trim().toLowerCase();
  const inferredType = rawType || (rawConfig.url ? "http" : "stdio");
  const type = SUPPORTED_MCP_TRANSPORTS.has(inferredType) ? inferredType : "stdio";

  return {
    name: normalizedName,
    type,
    enabled: normalizeBoolean(rawConfig.enabled, true),
    trust: normalizeBoolean(rawConfig.trust, false),
    startupTimeoutMs: clampTimeout(rawConfig.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS),
    toolTimeoutMs: clampTimeout(rawConfig.toolTimeoutMs, DEFAULT_TOOL_TIMEOUT_MS),
    command: typeof rawConfig.command === "string" ? rawConfig.command.trim() : "",
    args: normalizeStringList(rawConfig.args),
    cwd: typeof rawConfig.cwd === "string" ? rawConfig.cwd.trim() : "",
    env: normalizeStringMap(rawConfig.env),
    url: typeof rawConfig.url === "string" ? rawConfig.url.trim() : "",
    messageUrl: typeof rawConfig.messageUrl === "string" ? rawConfig.messageUrl.trim() : "",
    headers: normalizeStringMap(rawConfig.headers),
    bearerTokenEnvVar:
      typeof rawConfig.bearerTokenEnvVar === "string" ? rawConfig.bearerTokenEnvVar.trim() : "",
    allowTools: normalizeStringList(rawConfig.allowTools),
    denyTools: normalizeStringList(rawConfig.denyTools),
  };
}

export function normalizeMcpServers(rawServers) {
  if (!rawServers || typeof rawServers !== "object" || Array.isArray(rawServers)) {
    return {};
  }
  const normalized = {};
  for (const [name, config] of Object.entries(rawServers)) {
    try {
      const server = normalizeMcpServerConfig(name, config);
      normalized[server.name] = server;
    } catch {
      // Skip invalid server names to avoid crashing config load.
    }
  }
  return normalized;
}

export function upsertMcpServerConfig(existingServers, name, partialConfig = {}) {
  const normalizedName = normalizeMcpServerName(name);
  const current = normalizeMcpServers(existingServers)[normalizedName] ?? { name: normalizedName };
  const next = normalizeMcpServerConfig(normalizedName, { ...current, ...partialConfig });
  return {
    ...normalizeMcpServers(existingServers),
    [normalizedName]: next,
  };
}

export function removeMcpServerConfig(existingServers, name) {
  const normalizedName = normalizeMcpServerName(name);
  const next = { ...normalizeMcpServers(existingServers) };
  delete next[normalizedName];
  return next;
}

export function parseKeyValueEntries(entries) {
  const output = {};
  for (const entry of entries ?? []) {
    const raw = String(entry ?? "");
    const splitAt = raw.indexOf("=");
    if (splitAt <= 0) {
      throw new Error(`Invalid KEY=VALUE entry "${raw}".`);
    }
    const key = raw.slice(0, splitAt).trim();
    const value = raw.slice(splitAt + 1);
    if (!key) {
      throw new Error(`Invalid KEY=VALUE entry "${raw}".`);
    }
    output[key] = value;
  }
  return output;
}

export function isMcpToolAllowed(serverConfig, toolName) {
  const allow = normalizeStringList(serverConfig?.allowTools);
  const deny = normalizeStringList(serverConfig?.denyTools);
  if (deny.includes(toolName)) return false;
  if (allow.length === 0) return true;
  return allow.includes(toolName);
}

export function summarizeMcpServer(serverConfig) {
  const server = normalizeMcpServerConfig(serverConfig?.name ?? "unknown", serverConfig ?? {});
  const target =
    server.type === "stdio"
      ? `${server.command || "<missing command>"} ${server.args.join(" ")}`.trim()
      : server.url || "<missing url>";
  return `${server.name}: type=${server.type}, enabled=${server.enabled ? "yes" : "no"}, trust=${
    server.trust ? "yes" : "no"
  }, target=${target}`;
}

export const MCP_DEFAULT_TIMEOUTS = {
  startupMs: DEFAULT_STARTUP_TIMEOUT_MS,
  toolMs: DEFAULT_TOOL_TIMEOUT_MS,
};
