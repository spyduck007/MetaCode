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

test("describeToolCallFriendly list_dir without path", () => {
  assert.equal(
    describeToolCallFriendly({ name: "list_dir", arguments: {} }),
    "checking project folders"
  );
});

test("describeToolCallFriendly move_path with from and to", () => {
  assert.equal(
    describeToolCallFriendly({ name: "move_path", arguments: { from: "old.js", to: "new.js" } }),
    "moving old.js -> new.js"
  );
});

test("describeToolCallFriendly glob_files with pattern", () => {
  assert.equal(
    describeToolCallFriendly({ name: "glob_files", arguments: { pattern: "**/*.ts" } }),
    "finding files matching **/*.ts"
  );
});

test("describeToolCallFriendly glob_files without pattern", () => {
  assert.equal(
    describeToolCallFriendly({ name: "glob_files", arguments: {} }),
    "finding files by pattern"
  );
});

test("describeToolCallFriendly patch_file with path", () => {
  assert.equal(
    describeToolCallFriendly({ name: "patch_file", arguments: { path: "src/app.ts" } }),
    "patching src/app.ts"
  );
});

test("describeToolCallFriendly patch_file without path", () => {
  assert.equal(
    describeToolCallFriendly({ name: "patch_file", arguments: {} }),
    "patching a file"
  );
});

test("describeToolCallFriendly handles null call gracefully", () => {
  assert.equal(describeToolCallFriendly(null), "using a file tool");
  assert.equal(describeToolCallFriendly(undefined), "using a file tool");
});

test("describeToolCallFriendly truncates long paths", () => {
  const longPath = "a".repeat(50);
  const result = describeToolCallFriendly({ name: "read_file", arguments: { path: longPath } });
  assert.ok(result.includes("..."), "long path should be truncated");
});

test("describeToolCallFriendly unknown tool returns generic message", () => {
  assert.equal(
    describeToolCallFriendly({ name: "unknown_tool_xyz", arguments: {} }),
    "using a file tool"
  );
});

test("describeToolCallFriendly handles mcp tool names", () => {
  assert.equal(
    describeToolCallFriendly({ name: "mcp.docs.search", arguments: {} }),
    "calling mcp.docs.search"
  );
});

test("describeToolCallFriendly run_command with command", () => {
  assert.equal(
    describeToolCallFriendly({ name: "run_command", arguments: { command: "npm test" } }),
    'running "npm test"'
  );
});

test("describeAgentStatusFriendly maps all known status codes", () => {
  const mappings = [
    ["format correction", "reformatting response"],
    ["unsticking loop", "trying a different approach"],
    ["autonomous execution", "starting from scratch automatically"],
    ["reseeding conversation", "starting a fresh conversation"],
    ["recovering refusal", "recovering from model refusal"],
    ["stopping refusal loop", "stopping refusal loop"],
    ["stopping invalid loop", "stopping retry loop"],
    ["awaiting user follow-up", "waiting for your input"],
    ["continuing without follow-up", "continuing with assumptions"],
    ["finalizing", "finalizing answer"],
  ];
  for (const [input, expected] of mappings) {
    assert.equal(describeAgentStatusFriendly(input), expected);
  }
});

test("describeAgentStatusFriendly returns working for empty input", () => {
  assert.equal(describeAgentStatusFriendly(""), "working");
  assert.equal(describeAgentStatusFriendly(null), "working");
  assert.equal(describeAgentStatusFriendly(undefined), "working");
});

test("describeAgentStatusFriendly passes through unknown status texts", () => {
  assert.equal(describeAgentStatusFriendly("custom status text"), "custom status text");
});

test("pickThinkingPhrase avoids repeating the previous phrase", () => {
  const prev = pickThinkingPhrase();
  let sameCount = 0;
  for (let i = 0; i < 20; i++) {
    if (pickThinkingPhrase(prev) === prev) sameCount++;
  }
  assert.ok(sameCount < 5);
});
