import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { DEFAULT_MODE } from "./constants.js";
import { ensureAppDir, getAppPaths } from "./config.js";

function buildSessionRecord() {
  return {
    conversationId: randomUUID(),
    currentBranchPath: "0",
    mode: DEFAULT_MODE,
    updatedAt: new Date().toISOString(),
  };
}

function defaultSessionState() {
  return {
    activeSession: null,
    sessions: {},
  };
}

export function generateSessionName(prefix = "session") {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const short = randomUUID().slice(0, 6);
  return `${prefix}-${stamp}-${short}`;
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
    state.sessions[name] = buildSessionRecord();
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
  state.sessions[name] = buildSessionRecord();
  await writeSessionState(state, baseDir);
  return state.sessions[name];
}

export async function deleteSession(name, baseDir) {
  const state = await readSessionState(baseDir);
  if (!state.sessions[name]) {
    return { deleted: false, reason: "not_found", activeSession: state.activeSession };
  }

  delete state.sessions[name];
  if (state.activeSession === name) {
    const nextActive = Object.keys(state.sessions)[0] ?? null;
    state.activeSession = nextActive;
  }

  await writeSessionState(state, baseDir);
  return { deleted: true, activeSession: state.activeSession };
}

export async function listSessions(baseDir) {
  const state = await readSessionState(baseDir);
  return {
    activeSession: state.activeSession,
    sessions: state.sessions,
  };
}
