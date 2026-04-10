import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { loadWorkspaceMemory } from "../src/workspace-memory.js";

test("loadWorkspaceMemory reads configured instruction files", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-memory-test-"));
  try {
    await writeFile(path.join(workspace, "META.md"), "Always keep responses concise.\n", "utf8");
    await mkdir(path.join(workspace, ".meta-code"), { recursive: true });
    await writeFile(
      path.join(workspace, ".meta-code", "instructions.md"),
      "Prefer npm scripts over raw shell commands.\n",
      "utf8"
    );

    const memory = await loadWorkspaceMemory(workspace);
    assert.deepEqual(memory.sources, ["META.md", ".meta-code/instructions.md"]);
    assert.match(memory.text, /Always keep responses concise/);
    assert.match(memory.text, /Prefer npm scripts over raw shell commands/);
    assert.equal(memory.truncated, false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("loadWorkspaceMemory truncates oversized memory payloads", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-memory-test-"));
  try {
    await writeFile(path.join(workspace, "META.md"), "x".repeat(12_000), "utf8");
    const memory = await loadWorkspaceMemory(workspace);
    assert.equal(memory.sources.length, 1);
    assert.equal(memory.truncated, true);
    assert.equal(memory.text.length <= 9_000, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
