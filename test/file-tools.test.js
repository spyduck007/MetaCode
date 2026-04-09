import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { executeFileToolCall } from "../src/file-tools.js";

test("file tools write/read/edit lifecycle works", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-file-tools-"));
  try {
    const writeResult = await executeFileToolCall(
      {
        name: "write_file",
        arguments: {
          path: "src/example.txt",
          content: "line1\nline2\nline3",
        },
      },
      { workspaceRoot: workspace }
    );
    assert.equal(writeResult.ok, true);

    const readResult = await executeFileToolCall(
      {
        name: "read_file",
        arguments: { path: "src/example.txt", startLine: 2, endLine: 3 },
      },
      { workspaceRoot: workspace }
    );
    assert.equal(readResult.ok, true);
    assert.match(readResult.result.content, /2\. line2/);

    const editResult = await executeFileToolCall(
      {
        name: "edit_file",
        arguments: { path: "src/example.txt", oldText: "line2", newText: "line-two" },
      },
      { workspaceRoot: workspace }
    );
    assert.equal(editResult.ok, true);

    const finalContent = await readFile(path.join(workspace, "src/example.txt"), "utf8");
    assert.match(finalContent, /line-two/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("file tools enforce workspace boundaries", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-file-tools-"));
  try {
    const result = await executeFileToolCall(
      {
        name: "read_file",
        arguments: { path: "../outside.txt" },
      },
      { workspaceRoot: workspace }
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /outside workspace root/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("search_files finds matching lines", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-file-tools-"));
  try {
    await executeFileToolCall(
      {
        name: "write_file",
        arguments: {
          path: "a.txt",
          content: "apple\nbanana\ncherry",
        },
      },
      { workspaceRoot: workspace }
    );
    await executeFileToolCall(
      {
        name: "write_file",
        arguments: {
          path: "b.txt",
          content: "alpha\nbanana split",
        },
      },
      { workspaceRoot: workspace }
    );

    const search = await executeFileToolCall(
      {
        name: "search_files",
        arguments: { query: "banana", path: "." },
      },
      { workspaceRoot: workspace }
    );

    assert.equal(search.ok, true);
    assert.equal(search.result.count >= 2, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("run_command respects approval callback", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-file-tools-"));
  try {
    const denied = await executeFileToolCall(
      {
        name: "run_command",
        arguments: { command: "echo hello" },
      },
      {
        workspaceRoot: workspace,
        confirmCommand: async () => ({ approved: false, reason: "nope" }),
      }
    );
    assert.equal(denied.ok, false);
    assert.match(denied.error, /nope/);

    const allowed = await executeFileToolCall(
      {
        name: "run_command",
        arguments: { command: "echo hello" },
      },
      {
        workspaceRoot: workspace,
        confirmCommand: async () => ({ approved: true }),
      }
    );
    assert.equal(allowed.ok, true);
    assert.equal(allowed.result.exitCode, 0);
    assert.match(allowed.result.stdout, /hello/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
