import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_AGENT_STEPS,
  MAX_AGENT_STEPS,
  MIN_AGENT_STEPS,
  normalizeAgentSteps,
} from "../src/max-steps.js";

test("normalizeAgentSteps uses fallback for undefined values", () => {
  assert.equal(normalizeAgentSteps(undefined), DEFAULT_AGENT_STEPS);
  assert.equal(normalizeAgentSteps(undefined, 12), 12);
});

test("normalizeAgentSteps accepts valid integers and numeric strings", () => {
  assert.equal(normalizeAgentSteps(16), 16);
  assert.equal(normalizeAgentSteps("20"), 20);
});

test("normalizeAgentSteps rejects out of range and non-integer values", () => {
  assert.throws(() => normalizeAgentSteps("abc"), /max steps must be an integer/i);
  assert.throws(() => normalizeAgentSteps(MIN_AGENT_STEPS - 1), /max steps must be between/i);
  assert.throws(() => normalizeAgentSteps(MAX_AGENT_STEPS + 1), /max steps must be between/i);
});
