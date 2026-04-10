import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
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
