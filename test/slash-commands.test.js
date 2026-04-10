import test from "node:test";
import assert from "node:assert/strict";
import {
  completeSlashCommand,
  formatSlashHelpLines,
  getSlashSuggestions,
  parseSlashCommand,
} from "../src/slash-commands.js";

test("parseSlashCommand parses command and args", () => {
  const parsed = parseSlashCommand("/mode think_hard");
  assert.deepEqual(parsed, {
    name: "mode",
    args: ["think_hard"],
    raw: "/mode think_hard",
  });
});

test("parseSlashCommand parses session delete command", () => {
  const parsed = parseSlashCommand("/sessions delete archive");
  assert.deepEqual(parsed, {
    name: "sessions",
    args: ["delete", "archive"],
    raw: "/sessions delete archive",
  });
});

test("parseSlashCommand returns null for non-command input", () => {
  assert.equal(parseSlashCommand("hello world"), null);
  assert.equal(parseSlashCommand(""), null);
});

test("formatSlashHelpLines contains login and mode commands", () => {
  const lines = formatSlashHelpLines();
  assert.equal(lines.some((line) => line.startsWith("/login")), true);
  assert.equal(lines.some((line) => line.startsWith("/mode")), true);
  assert.equal(lines.some((line) => line.startsWith("/tools")), true);
  assert.equal(lines.some((line) => line.startsWith("/memory")), true);
  assert.equal(lines.some((line) => line.startsWith("/yolo")), true);
  assert.equal(lines.some((line) => line.startsWith("/sessions")), true);
});

test("getSlashSuggestions returns matching slash commands", () => {
  const suggestions = getSlashSuggestions("/mo");
  assert.equal(suggestions.length > 0, true);
  assert.equal(suggestions[0].name, "mode");
  assert.equal(suggestions[0].completion, "/mode ");
});

test("completeSlashCommand uses top suggestion", () => {
  const completion = completeSlashCommand("/lo", [
    { name: "login", completion: "/login " },
    { name: "logout", completion: "/logout " },
  ]);
  assert.equal(completion, "/login ");
  assert.equal(completeSlashCommand("hello", []), null);
});
