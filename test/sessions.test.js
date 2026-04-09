import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { ensureSession, readSessionState, resetSession, updateSession } from "../src/sessions.js";

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
