import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { executeFileToolCall } from "../src/file-tools.js";

// ──────────────────────────────────────────────────────────────────────────────
// glob_files
// ──────────────────────────────────────────────────────────────────────────────

test("glob_files finds files by simple extension pattern", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-glob-"));
  try {
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await writeFile(path.join(workspace, "src", "index.js"), "// js");
    await writeFile(path.join(workspace, "src", "utils.js"), "// js");
    await writeFile(path.join(workspace, "src", "types.ts"), "// ts");
    await writeFile(path.join(workspace, "README.md"), "# readme");

    const result = await executeFileToolCall(
      { name: "glob_files", arguments: { pattern: "**/*.js" } },
      { workspaceRoot: workspace }
    );
    assert.equal(result.ok, true);
    assert.equal(result.result.count, 2);
    assert.ok(result.result.matches.some((m) => m.includes("index.js")));
    assert.ok(result.result.matches.some((m) => m.includes("utils.js")));
    assert.ok(!result.result.matches.some((m) => m.includes("types.ts")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("glob_files finds files with {a,b} alternation pattern", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-glob-"));
  try {
    await writeFile(path.join(workspace, "app.ts"), "");
    await writeFile(path.join(workspace, "app.js"), "");
    await writeFile(path.join(workspace, "app.py"), "");

    const result = await executeFileToolCall(
      { name: "glob_files", arguments: { pattern: "*.{ts,js}" } },
      { workspaceRoot: workspace }
    );
    assert.equal(result.ok, true);
    assert.equal(result.result.count, 2);
    assert.ok(result.result.matches.some((m) => m.endsWith(".ts")));
    assert.ok(result.result.matches.some((m) => m.endsWith(".js")));
    assert.ok(!result.result.matches.some((m) => m.endsWith(".py")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("glob_files returns error for missing pattern", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-glob-"));
  try {
    const result = await executeFileToolCall(
      { name: "glob_files", arguments: {} },
      { workspaceRoot: workspace }
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /pattern/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("glob_files skips node_modules and .git directories", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-glob-"));
  try {
    await mkdir(path.join(workspace, "node_modules", "lib"), { recursive: true });
    await writeFile(path.join(workspace, "node_modules", "lib", "index.js"), "");
    await writeFile(path.join(workspace, "index.js"), "");

    const result = await executeFileToolCall(
      { name: "glob_files", arguments: { pattern: "**/*.js" } },
      { workspaceRoot: workspace }
    );
    assert.equal(result.ok, true);
    assert.equal(result.result.count, 1);
    assert.ok(!result.result.matches.some((m) => m.includes("node_modules")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("glob_files uses single-segment wildcard * correctly", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-glob-"));
  try {
    await mkdir(path.join(workspace, "a", "b"), { recursive: true });
    await writeFile(path.join(workspace, "a", "root.txt"), "");
    await writeFile(path.join(workspace, "a", "b", "nested.txt"), "");

    // *.txt should only match at root level of the search dir
    const result = await executeFileToolCall(
      { name: "glob_files", arguments: { pattern: "a/*.txt" } },
      { workspaceRoot: workspace }
    );
    assert.equal(result.ok, true);
    assert.equal(result.result.count, 1);
    assert.ok(result.result.matches.some((m) => m.endsWith("root.txt")));
    assert.ok(!result.result.matches.some((m) => m.endsWith("nested.txt")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("glob_files uses ? wildcard to match single character", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-glob-"));
  try {
    await writeFile(path.join(workspace, "ab.txt"), "");
    await writeFile(path.join(workspace, "abc.txt"), "");
    await writeFile(path.join(workspace, "a.txt"), "");

    const result = await executeFileToolCall(
      { name: "glob_files", arguments: { pattern: "a?.txt" } },
      { workspaceRoot: workspace }
    );
    assert.equal(result.ok, true);
    assert.equal(result.result.count, 1);
    assert.ok(result.result.matches.some((m) => m.endsWith("ab.txt")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("glob_files enforces workspace boundaries", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-glob-"));
  try {
    const result = await executeFileToolCall(
      { name: "glob_files", arguments: { pattern: "*.js", path: "../outside" } },
      { workspaceRoot: workspace }
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /outside workspace root/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// patch_file
// ──────────────────────────────────────────────────────────────────────────────

test("patch_file requires hunks argument", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-patch-"));
  try {
    await writeFile(path.join(workspace, "file.txt"), "line1\nline2\nline3\n");
    const result = await executeFileToolCall(
      { name: "patch_file", arguments: { path: "file.txt" } },
      { workspaceRoot: workspace }
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /hunks/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("patch_file applies a simple addition hunk", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-patch-"));
  try {
    await writeFile(path.join(workspace, "file.txt"), "line1\nline2\nline3\n");
    const hunk = "@@ -2,1 +2,2 @@\n line2\n+inserted\n line3\n";
    const result = await executeFileToolCall(
      { name: "patch_file", arguments: { path: "file.txt", hunks: hunk } },
      { workspaceRoot: workspace }
    );
    assert.equal(result.ok, true);
    const content = await readFile(path.join(workspace, "file.txt"), "utf8");
    assert.ok(content.includes("inserted"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// glob pattern conversion helpers (tested via glob_files tool)
// ──────────────────────────────────────────────────────────────────────────────

test("glob_files handles deep nesting with ** pattern", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-glob-deep-"));
  try {
    await mkdir(path.join(workspace, "a", "b", "c"), { recursive: true });
    await writeFile(path.join(workspace, "a", "b", "c", "deep.ts"), "");
    await writeFile(path.join(workspace, "top.ts"), "");

    const result = await executeFileToolCall(
      { name: "glob_files", arguments: { pattern: "**/*.ts" } },
      { workspaceRoot: workspace }
    );
    assert.equal(result.ok, true);
    assert.equal(result.result.count, 2);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("glob_files returns empty matches array when nothing matches", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-glob-empty-"));
  try {
    await writeFile(path.join(workspace, "hello.py"), "");

    const result = await executeFileToolCall(
      { name: "glob_files", arguments: { pattern: "**/*.rs" } },
      { workspaceRoot: workspace }
    );
    assert.equal(result.ok, true);
    assert.equal(result.result.count, 0);
    assert.deepEqual(result.result.matches, []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
