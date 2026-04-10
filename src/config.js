import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { APP_DIR_NAME, DEFAULT_MODE, LEGACY_APP_DIR_NAME } from "./constants.js";
import { DEFAULT_AGENT_STEPS } from "./max-steps.js";

function resolveDefaultBaseDir() {
  const home = os.homedir();
  const primaryPath = path.join(home, APP_DIR_NAME);
  const legacyPath = path.join(home, LEGACY_APP_DIR_NAME);
  if (existsSync(primaryPath) || !existsSync(legacyPath)) {
    return primaryPath;
  }
  return legacyPath;
}

function getBaseDir(baseDir) {
  if (baseDir) return baseDir;
  return resolveDefaultBaseDir();
}

export function getAppPaths(baseDir) {
  const resolvedBaseDir = getBaseDir(baseDir);
  return {
    baseDir: resolvedBaseDir,
    configPath: path.join(resolvedBaseDir, "config.json"),
    sessionsPath: path.join(resolvedBaseDir, "sessions.json"),
  };
}

export async function ensureAppDir(baseDir) {
  const { baseDir: resolvedBaseDir } = getAppPaths(baseDir);
  await mkdir(resolvedBaseDir, { recursive: true });
}

async function readJsonFile(filePath, fallbackValue) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return fallbackValue;
    }
    throw error;
  }
}

async function writeJsonFile(filePath, value) {
  const serialized = JSON.stringify(value, null, 2);
  await writeFile(filePath, `${serialized}\n`, "utf8");
}

export async function readConfig(baseDir) {
  const { configPath } = getAppPaths(baseDir);
  const loaded = await readJsonFile(configPath, {});
  return {
    ...loaded,
    defaultMode: loaded.defaultMode ?? DEFAULT_MODE,
    defaultMaxSteps: Number.isInteger(loaded.defaultMaxSteps)
      ? loaded.defaultMaxSteps
      : DEFAULT_AGENT_STEPS,
  };
}

export async function writeConfig(config, baseDir) {
  await ensureAppDir(baseDir);
  const { configPath } = getAppPaths(baseDir);
  const normalized = {
    defaultMode: config.defaultMode ?? DEFAULT_MODE,
    ...(Number.isInteger(config.defaultMaxSteps)
      ? { defaultMaxSteps: config.defaultMaxSteps }
      : {}),
    ...(config.cookie ? { cookie: config.cookie } : {}),
  };
  await writeJsonFile(configPath, normalized);
  return normalized;
}

export async function updateConfig(partial, baseDir) {
  const current = await readConfig(baseDir);
  return writeConfig({ ...current, ...partial }, baseDir);
}
