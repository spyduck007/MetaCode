import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  deleteSession,
  ensureSession,
  generateSessionName,
  listSessions,
  readSessionState,
  renameSession,
  resetSession,
  updateSession,
} from "../src/sessions.js";

test("ensureSession creates named session", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "meta-code-test-"));
  try {
    const { session } = await ensureSession("work", baseDir);
    assert.equal(typeof session.conversationId, "string");
    assert.equal(session.currentBranchPath, "0");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("updateSession persists values", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "meta-code-test-"));
  try {
    await ensureSession("default", baseDir);
    await updateSession(
      "default",
      { currentBranchPath: "2", mode: "think_hard", conversationId: "abc-123" },
      baseDir
    );
    const state = await readSessionState(baseDir);
    assert.equal(state.sessions.default.currentBranchPath, "2");
    assert.equal(state.sessions.default.mode, "think_hard");
    assert.equal(state.sessions.default.conversationId, "abc-123");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("resetSession creates new conversationId", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "meta-code-test-"));
  try {
    const { session } = await ensureSession("scratch", baseDir);
    const previousConversationId = session.conversationId;
    const reset = await resetSession("scratch", baseDir);
    assert.notEqual(reset.conversationId, previousConversationId);
    assert.equal(reset.currentBranchPath, "0");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("deleteSession removes session and updates active session", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "meta-code-test-"));
  try {
    await ensureSession("one", baseDir);
    await ensureSession("two", baseDir);
    await ensureSession("one", baseDir);
    const result = await deleteSession("two", baseDir);
    assert.equal(result.deleted, true);
    assert.equal(result.activeSession, "one");
    const state = await readSessionState(baseDir);
    assert.equal(Boolean(state.sessions.two), false);
    assert.equal(state.activeSession, "one");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("deleteSession rejects deleting active session", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "meta-code-test-"));
  try {
    await ensureSession("active", baseDir);
    const result = await deleteSession("active", baseDir);
    assert.equal(result.deleted, false);
    assert.equal(result.reason, "active_session");
    const state = await readSessionState(baseDir);
    assert.equal(Boolean(state.sessions.active), true);
    assert.equal(state.activeSession, "active");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("generateSessionName creates unique prefixed names", () => {
  const a = generateSessionName("chat");
  const b = generateSessionName("chat");
  assert.equal(a.startsWith("chat-"), true);
  assert.equal(b.startsWith("chat-"), true);
  assert.notEqual(a, b);
});

// ──────────────────────────────────────────────────────────────────────────────
// renameSession
// ──────────────────────────────────────────────────────────────────────────────

test("renameSession renames a session successfully", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "meta-sess-rename-"));
  try {
    await ensureSession("old-name", dir);
    const result = await renameSession("old-name", "new-name", dir);
    assert.equal(result.renamed, true);
    const info = await listSessions(dir);
    assert.ok(info.sessions["new-name"], "new-name should exist");
    assert.ok(!info.sessions["old-name"], "old-name should not exist");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("renameSession updates active session pointer", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "meta-sess-rename-active-"));
  try {
    await ensureSession("active-old", dir);
    const result = await renameSession("active-old", "active-new", dir);
    assert.equal(result.renamed, true);
    assert.equal(result.activeSession, "active-new");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("renameSession returns not_found for unknown session", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "meta-sess-rename-miss-"));
  try {
    const result = await renameSession("does-not-exist", "new-name", dir);
    assert.equal(result.renamed, false);
    assert.equal(result.reason, "not_found");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("renameSession returns already_exists when target name taken", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "meta-sess-rename-dup-"));
  try {
    await ensureSession("alpha", dir);
    await ensureSession("beta", dir);
    const result = await renameSession("alpha", "beta", dir);
    assert.equal(result.renamed, false);
    assert.equal(result.reason, "already_exists");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("renameSession returns invalid_new_name for names with spaces", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "meta-sess-rename-inv-"));
  try {
    await ensureSession("good-name", dir);
    const result = await renameSession("good-name", "bad name!", dir);
    assert.equal(result.renamed, false);
    assert.equal(result.reason, "invalid_new_name");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("renameSession returns same_name when old and new are equal", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "meta-sess-rename-same-"));
  try {
    await ensureSession("my-session", dir);
    const result = await renameSession("my-session", "my-session", dir);
    assert.equal(result.renamed, false);
    assert.equal(result.reason, "same_name");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
