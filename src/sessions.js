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
  if (state.activeSession === name) {
    return { deleted: false, reason: "active_session", activeSession: state.activeSession };
  }

  delete state.sessions[name];

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

/**
 * Rename a session to a new name.
 * - The new name must not already exist.
 * - If the renamed session was the active session, the active session pointer is updated.
 */
export async function renameSession(oldName, newName, baseDir) {
  const normalizedOld = oldName?.trim();
  const normalizedNew = newName?.trim();
  if (!normalizedOld) return { renamed: false, reason: "old_name_empty" };
  if (!normalizedNew) return { renamed: false, reason: "new_name_empty" };
  if (normalizedOld === normalizedNew) return { renamed: false, reason: "same_name" };
  if (!/^[a-zA-Z0-9_-]+$/.test(normalizedNew)) {
    return { renamed: false, reason: "invalid_new_name" };
  }

  const state = await readSessionState(baseDir);
  if (!state.sessions[normalizedOld]) {
    return { renamed: false, reason: "not_found" };
  }
  if (state.sessions[normalizedNew]) {
    return { renamed: false, reason: "already_exists" };
  }

  state.sessions[normalizedNew] = {
    ...state.sessions[normalizedOld],
    updatedAt: new Date().toISOString(),
  };
  delete state.sessions[normalizedOld];

  if (state.activeSession === normalizedOld) {
    state.activeSession = normalizedNew;
  }

  await writeSessionState(state, baseDir);
  return { renamed: true, activeSession: state.activeSession };
}
