import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { executeFileToolCall } from "../src/file-tools.js";

// ──────────────────────────────────────────────────────────────────────────────
// write_file edge cases
// ──────────────────────────────────────────────────────────────────────────────

test("write_file with overwrite=false fails if file already exists", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-ft-ext-"));
  try {
    await writeFile(path.join(workspace, "existing.txt"), "original content", "utf8");

    const result = await executeFileToolCall(
      { name: "write_file", arguments: { path: "existing.txt", content: "new", overwrite: false } },
      { workspaceRoot: workspace }
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /already exists/i);

    // Original content should still be there
    const content = await readFile(path.join(workspace, "existing.txt"), "utf8");
    assert.equal(content, "original content");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("write_file creates nested directories automatically", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-ft-ext-"));
  try {
    const result = await executeFileToolCall(
      { name: "write_file", arguments: { path: "a/b/c/deep.txt", content: "deep content" } },
      { workspaceRoot: workspace }
    );
    assert.equal(result.ok, true);
    const content = await readFile(path.join(workspace, "a", "b", "c", "deep.txt"), "utf8");
    assert.equal(content, "deep content");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("write_file missing content argument returns error", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-ft-ext-"));
  try {
    const result = await executeFileToolCall(
      { name: "write_file", arguments: { path: "test.txt" } },
      { workspaceRoot: workspace }
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /"content" must be a string/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// edit_file edge cases
// ──────────────────────────────────────────────────────────────────────────────

test("edit_file replaceAll replaces every occurrence", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-ft-ext-"));
  try {
    await writeFile(path.join(workspace, "multi.txt"), "foo bar foo baz foo", "utf8");

    const result = await executeFileToolCall(
      {
        name: "edit_file",
        arguments: { path: "multi.txt", oldText: "foo", newText: "qux", replaceAll: true },
      },
      { workspaceRoot: workspace }
    );
    assert.equal(result.ok, true);
    assert.equal(result.result.replacements, 3);
    const content = await readFile(path.join(workspace, "multi.txt"), "utf8");
    assert.equal(content, "qux bar qux baz qux");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("edit_file without replaceAll only replaces first occurrence", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-ft-ext-"));
  try {
    await writeFile(path.join(workspace, "multi.txt"), "foo foo foo", "utf8");

    const result = await executeFileToolCall(
      {
        name: "edit_file",
        arguments: { path: "multi.txt", oldText: "foo", newText: "bar", replaceAll: false },
      },
      { workspaceRoot: workspace }
    );
    assert.equal(result.ok, true);
    assert.equal(result.result.replacements, 1);
    const content = await readFile(path.join(workspace, "multi.txt"), "utf8");
    assert.equal(content, "bar foo foo");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("edit_file returns error when oldText is not found", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-ft-ext-"));
  try {
    await writeFile(path.join(workspace, "file.txt"), "hello world", "utf8");
    const result = await executeFileToolCall(
      {
        name: "edit_file",
        arguments: { path: "file.txt", oldText: "not present", newText: "x" },
      },
      { workspaceRoot: workspace }
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /not found/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// append_file
// ──────────────────────────────────────────────────────────────────────────────

test("append_file adds content to end of existing file", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-ft-ext-"));
  try {
    await writeFile(path.join(workspace, "log.txt"), "line1\n", "utf8");
    const result = await executeFileToolCall(
      { name: "append_file", arguments: { path: "log.txt", content: "line2\n" } },
      { workspaceRoot: workspace }
    );
    assert.equal(result.ok, true);
    const content = await readFile(path.join(workspace, "log.txt"), "utf8");
    assert.equal(content, "line1\nline2\n");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("append_file creates file if it does not exist", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-ft-ext-"));
  try {
    const result = await executeFileToolCall(
      { name: "append_file", arguments: { path: "new.txt", content: "created!" } },
      { workspaceRoot: workspace }
    );
    assert.equal(result.ok, true);
    const content = await readFile(path.join(workspace, "new.txt"), "utf8");
    assert.equal(content, "created!");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// delete_path
// ──────────────────────────────────────────────────────────────────────────────

test("delete_path removes a file", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-ft-ext-"));
  try {
    await writeFile(path.join(workspace, "delete-me.txt"), "bye", "utf8");
    const result = await executeFileToolCall(
      { name: "delete_path", arguments: { path: "delete-me.txt" } },
      { workspaceRoot: workspace }
    );
    assert.equal(result.ok, true);
    await assert.rejects(
      () => readFile(path.join(workspace, "delete-me.txt"), "utf8"),
      { code: "ENOENT" }
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("delete_path fails to delete non-empty directory without recursive=true", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-ft-ext-"));
  try {
    await mkdir(path.join(workspace, "subdir"));
    await writeFile(path.join(workspace, "subdir", "file.txt"), "content", "utf8");

    const result = await executeFileToolCall(
      { name: "delete_path", arguments: { path: "subdir", recursive: false } },
      { workspaceRoot: workspace }
    );
    assert.equal(result.ok, false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("delete_path with recursive=true removes a directory and its contents", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-ft-ext-"));
  try {
    await mkdir(path.join(workspace, "subdir"));
    await writeFile(path.join(workspace, "subdir", "file.txt"), "content", "utf8");

    const result = await executeFileToolCall(
      { name: "delete_path", arguments: { path: "subdir", recursive: true } },
      { workspaceRoot: workspace }
    );
    assert.equal(result.ok, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// move_path
// ──────────────────────────────────────────────────────────────────────────────

test("move_path renames a file", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-ft-ext-"));
  try {
    await writeFile(path.join(workspace, "old.txt"), "content", "utf8");
    const result = await executeFileToolCall(
      { name: "move_path", arguments: { from: "old.txt", to: "new.txt" } },
      { workspaceRoot: workspace }
    );
    assert.equal(result.ok, true);
    const content = await readFile(path.join(workspace, "new.txt"), "utf8");
    assert.equal(content, "content");
    await assert.rejects(
      () => readFile(path.join(workspace, "old.txt"), "utf8"),
      { code: "ENOENT" }
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// stat_path
// ──────────────────────────────────────────────────────────────────────────────

test("stat_path returns file metadata", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-ft-ext-"));
  try {
    await writeFile(path.join(workspace, "hello.txt"), "hello", "utf8");
    const result = await executeFileToolCall(
      { name: "stat_path", arguments: { path: "hello.txt" } },
      { workspaceRoot: workspace }
    );
    assert.equal(result.ok, true);
    assert.equal(result.result.type, "file");
    assert.equal(result.result.size, 5);
    assert.ok(typeof result.result.mtime === "string");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("stat_path returns directory metadata", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-ft-ext-"));
  try {
    await mkdir(path.join(workspace, "mydir"));
    const result = await executeFileToolCall(
      { name: "stat_path", arguments: { path: "mydir" } },
      { workspaceRoot: workspace }
    );
    assert.equal(result.ok, true);
    assert.equal(result.result.type, "directory");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// search_files edge cases
// ──────────────────────────────────────────────────────────────────────────────

test("search_files with regex mode finds pattern matches", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-ft-ext-"));
  try {
    await writeFile(path.join(workspace, "code.js"), "const x = 42;\nlet y = 100;\nvar z = 0;", "utf8");
    const result = await executeFileToolCall(
      { name: "search_files", arguments: { query: "(const|let)\\s+\\w+", regex: true } },
      { workspaceRoot: workspace }
    );
    assert.equal(result.ok, true);
    assert.equal(result.result.count, 2);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("search_files case-insensitive match works", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-ft-ext-"));
  try {
    await writeFile(path.join(workspace, "text.txt"), "Hello World\nhello planet", "utf8");
    const result = await executeFileToolCall(
      { name: "search_files", arguments: { query: "HELLO", caseSensitive: false } },
      { workspaceRoot: workspace }
    );
    assert.equal(result.ok, true);
    assert.equal(result.result.count, 2);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("search_files case-sensitive match only finds exact case", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-ft-ext-"));
  try {
    await writeFile(path.join(workspace, "text.txt"), "Hello World\nhello planet", "utf8");
    const result = await executeFileToolCall(
      { name: "search_files", arguments: { query: "Hello", caseSensitive: true } },
      { workspaceRoot: workspace }
    );
    assert.equal(result.ok, true);
    assert.equal(result.result.count, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// executeFileToolCall - unknown tool
// ──────────────────────────────────────────────────────────────────────────────

test("executeFileToolCall returns error for unknown tool name", async () => {
  const result = await executeFileToolCall(
    { name: "non_existent_tool", arguments: {} },
    { workspaceRoot: process.cwd() }
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /Unknown tool/);
});

test("executeFileToolCall returns error for missing tool name", async () => {
  const result = await executeFileToolCall(
    { arguments: {} },
    { workspaceRoot: process.cwd() }
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /"name"/);
});
