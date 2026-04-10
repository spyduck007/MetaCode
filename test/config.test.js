import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { readConfig, writeConfig, updateConfig } from "../src/config.js";
import { DEFAULT_AGENT_STEPS } from "../src/max-steps.js";

test("readConfig returns defaults including max steps", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "meta-config-test-"));
  try {
    const config = await readConfig(baseDir);
    assert.equal(config.defaultMaxSteps, DEFAULT_AGENT_STEPS);
    assert.ok(config.defaultMode);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("writeConfig and updateConfig persist defaultMaxSteps", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "meta-config-test-"));
  try {
    await writeConfig({ defaultMode: "think_hard", defaultMaxSteps: 30 }, baseDir);
    let config = await readConfig(baseDir);
    assert.equal(config.defaultMode, "think_hard");
    assert.equal(config.defaultMaxSteps, 30);

    await updateConfig({ defaultMaxSteps: 40 }, baseDir);
    config = await readConfig(baseDir);
    assert.equal(config.defaultMaxSteps, 40);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});
