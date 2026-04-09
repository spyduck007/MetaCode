import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { DEFAULT_MODE } from "./constants.js";
import { ensureAppDir, getAppPaths } from "./config.js";

function defaultSessionState() {
  return {
    activeSession: "default",
    sessions: {
      default: {
        conversationId: randomUUID(),
        currentBranchPath: "0",
        mode: DEFAULT_MODE,
        updatedAt: new Date().toISOString(),
      },
    },
  };
}

export async function readSessionState(baseDir) {
  const { sessionsPath } = getAppPaths(baseDir);
  try {
    const raw = await readFile(sessionsPath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return defaultSessionState();
    }
    throw error;
  }
}

export async function writeSessionState(state, baseDir) {
  await ensureAppDir(baseDir);
  const { sessionsPath } = getAppPaths(baseDir);
  await writeFile(sessionsPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function ensureSession(name, baseDir) {
  const state = await readSessionState(baseDir);
  if (!state.sessions[name]) {
    state.sessions[name] = {
      conversationId: randomUUID(),
      currentBranchPath: "0",
      mode: DEFAULT_MODE,
      updatedAt: new Date().toISOString(),
    };
  }
  state.activeSession = name;
  await writeSessionState(state, baseDir);
  return { state, session: state.sessions[name] };
}

export async function updateSession(name, patch, baseDir) {
  const { state, session } = await ensureSession(name, baseDir);
  const nextSession = {
    ...session,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  state.sessions[name] = nextSession;
  await writeSessionState(state, baseDir);
  return nextSession;
}

export async function resetSession(name, baseDir) {
  const { state } = await ensureSession(name, baseDir);
  state.sessions[name] = {
    conversationId: randomUUID(),
    currentBranchPath: "0",
    mode: DEFAULT_MODE,
    updatedAt: new Date().toISOString(),
  };
  await writeSessionState(state, baseDir);
  return state.sessions[name];
}

export async function listSessions(baseDir) {
  const state = await readSessionState(baseDir);
  return {
    activeSession: state.activeSession,
    sessions: state.sessions,
  };
}

