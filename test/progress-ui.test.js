import test from "node:test";
import assert from "node:assert/strict";
import {
  describeAgentStatusFriendly,
  describeToolCallFriendly,
  pickThinkingPhrase,
} from "../src/progress-ui.js";

test("describeToolCallFriendly returns human-readable tool text", () => {
  const message = describeToolCallFriendly({
    name: "read_file",
    arguments: { path: "src/index.js" },
  });
  assert.equal(message, "reading src/index.js");
});

test("describeAgentStatusFriendly simplifies step status", () => {
  assert.equal(describeAgentStatusFriendly("step 2/10"), "working through steps");
});

test("pickThinkingPhrase returns non-empty phrase", () => {
  const phrase = pickThinkingPhrase();
  assert.equal(typeof phrase, "string");
  assert.equal(phrase.length > 0, true);
});

