import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { runDoctor } from "../src/doctor.js";

test("runDoctor reports healthy checks for writable workspace", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-doctor-test-"));
  try {
    const report = await runDoctor({
      cwd: workspace,
      authSummary: { source: "config", hasSession: "yes" },
      config: { defaultMode: "think_fast", defaultMaxSteps: 24 },
    });

    assert.equal(report.ok, true);
    assert.equal(report.checks.some((check) => check.name === "workspace-write"), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runDoctor warns on missing session auth cookie", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-doctor-test-"));
  try {
    const report = await runDoctor({
      cwd: workspace,
      authSummary: { source: "none", hasSession: "no" },
      config: { defaultMode: "think_fast", defaultMaxSteps: 24 },
    });
    const authCheck = report.checks.find((check) => check.name === "auth");
    assert.equal(Boolean(authCheck), true);
    assert.equal(authCheck.status, "warn");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runDoctor includes workspace-memory check as warn when no memory file exists", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-doctor-test-"));
  try {
    const report = await runDoctor({
      cwd: workspace,
      authSummary: { source: "config", hasSession: "yes" },
      config: { defaultMode: "think_fast", defaultMaxSteps: 24 },
    });
    const memCheck = report.checks.find((c) => c.name === "workspace-memory");
    assert.ok(memCheck, "workspace-memory check must be present");
    assert.equal(memCheck.status, "warn");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runDoctor includes workspace-memory check as ok when META.md exists", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-doctor-test-"));
  try {
    await writeFile(path.join(workspace, "META.md"), "# Instructions\nBe helpful.", "utf8");
    const report = await runDoctor({
      cwd: workspace,
      authSummary: { source: "config", hasSession: "yes" },
      config: { defaultMode: "think_fast", defaultMaxSteps: 24 },
    });
    const memCheck = report.checks.find((c) => c.name === "workspace-memory");
    assert.ok(memCheck, "workspace-memory check must be present");
    assert.equal(memCheck.status, "ok");
    assert.ok(memCheck.detail.includes("META.md"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runDoctor detects .meta-code/instructions.md as workspace memory", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-doctor-test-"));
  try {
    await mkdir(path.join(workspace, ".meta-code"), { recursive: true });
    await writeFile(path.join(workspace, ".meta-code", "instructions.md"), "# Project notes", "utf8");
    const report = await runDoctor({
      cwd: workspace,
      authSummary: { source: "config", hasSession: "yes" },
      config: { defaultMode: "think_fast", defaultMaxSteps: 24 },
    });
    const memCheck = report.checks.find((c) => c.name === "workspace-memory");
    assert.ok(memCheck);
    assert.equal(memCheck.status, "ok");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runDoctor ok flag reflects only error-level checks", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-doctor-test-"));
  try {
    const report = await runDoctor({
      cwd: workspace,
      authSummary: { source: "none", hasSession: "no" },
      config: { defaultMode: "think_fast", defaultMaxSteps: 24 },
    });
    assert.equal(report.ok, true, "report.ok should be true if only warnings exist");
    const hasError = report.checks.some((c) => c.status === "error");
    assert.equal(hasError, false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runDoctor reports MCP configuration and discovery summary", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-doctor-test-"));
  try {
    const report = await runDoctor({
      cwd: workspace,
      authSummary: { source: "config", hasSession: "yes" },
      config: {
        defaultMode: "think_fast",
        defaultMaxSteps: 24,
        mcpServers: {
          docs: { type: "http", url: "https://example.com/mcp", enabled: true },
        },
      },
      mcpSummary: {
        tools: [{ name: "mcp.docs.search", serverName: "docs", toolName: "search", args: [] }],
        errors: [],
      },
    });
    const serversCheck = report.checks.find((check) => check.name === "mcp-servers");
    const toolsCheck = report.checks.find((check) => check.name === "mcp-tools");
    assert.ok(serversCheck);
    assert.ok(toolsCheck);
    assert.equal(serversCheck.status, "ok");
    assert.equal(toolsCheck.status, "ok");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
