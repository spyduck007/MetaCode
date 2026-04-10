import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSlashCommand,
  formatSlashHelpLines,
  getSlashSuggestions,
  completeSlashCommand,
  SLASH_COMMAND_DEFINITIONS,
} from "../src/slash-commands.js";

// ──────────────────────────────────────────────────────────────────────────────
// parseSlashCommand edge cases
// ──────────────────────────────────────────────────────────────────────────────

test("parseSlashCommand handles leading whitespace before slash (trims input)", () => {
  // The function trims the input, so leading whitespace is ignored
  const result = parseSlashCommand("  /help");
  assert.ok(result, "Leading whitespace should be trimmed and command parsed");
  assert.equal(result.name, "help");
});

test("parseSlashCommand handles uppercase command names", () => {
  const result = parseSlashCommand("/HELP");
  assert.ok(result);
  assert.equal(result.name, "help");
});

test("parseSlashCommand returns null for just a slash", () => {
  const result = parseSlashCommand("/");
  assert.equal(result, null);
});

test("parseSlashCommand handles multi-word args correctly", () => {
  const result = parseSlashCommand("/sessions delete my-session-name");
  assert.ok(result);
  assert.equal(result.name, "sessions");
  assert.deepEqual(result.args, ["delete", "my-session-name"]);
});

test("parseSlashCommand handles extra spaces between args", () => {
  const result = parseSlashCommand("/mode   think_fast");
  assert.ok(result);
  assert.equal(result.name, "mode");
  assert.deepEqual(result.args, ["think_fast"]);
});

test("parseSlashCommand returns null for empty string", () => {
  assert.equal(parseSlashCommand(""), null);
  assert.equal(parseSlashCommand(null), null);
  assert.equal(parseSlashCommand(undefined), null);
});

// ──────────────────────────────────────────────────────────────────────────────
// New command definitions exist
// ──────────────────────────────────────────────────────────────────────────────

test("SLASH_COMMAND_DEFINITIONS includes export command", () => {
  const names = SLASH_COMMAND_DEFINITIONS.map((c) => c.name);
  assert.ok(names.includes("export"), "export command should be defined");
});

test("SLASH_COMMAND_DEFINITIONS includes compact command", () => {
  const names = SLASH_COMMAND_DEFINITIONS.map((c) => c.name);
  assert.ok(names.includes("compact"), "compact command should be defined");
});

test("SLASH_COMMAND_DEFINITIONS includes history command", () => {
  const names = SLASH_COMMAND_DEFINITIONS.map((c) => c.name);
  assert.ok(names.includes("history"), "history command should be defined");
});

test("SLASH_COMMAND_DEFINITIONS includes agent command", () => {
  const names = SLASH_COMMAND_DEFINITIONS.map((c) => c.name);
  assert.ok(names.includes("agent"), "agent command should be defined");
});

test("SLASH_COMMAND_DEFINITIONS includes diff command", () => {
  const names = SLASH_COMMAND_DEFINITIONS.map((c) => c.name);
  assert.ok(names.includes("diff"), "diff command should be defined");
});

test("every SLASH_COMMAND_DEFINITIONS entry has name, usage, and description", () => {
  for (const entry of SLASH_COMMAND_DEFINITIONS) {
    assert.ok(typeof entry.name === "string" && entry.name.length > 0, `${JSON.stringify(entry)} missing name`);
    assert.ok(typeof entry.usage === "string" && entry.usage.length > 0, `${entry.name} missing usage`);
    assert.ok(typeof entry.description === "string" && entry.description.length > 0, `${entry.name} missing description`);
  }
});

test("SLASH_COMMAND_DEFINITIONS has no duplicate command names", () => {
  const names = SLASH_COMMAND_DEFINITIONS.map((c) => c.name);
  const unique = new Set(names);
  assert.equal(unique.size, names.length, "Duplicate command names found");
});

// ──────────────────────────────────────────────────────────────────────────────
// formatSlashHelpLines
// ──────────────────────────────────────────────────────────────────────────────

test("formatSlashHelpLines contains all commands", () => {
  const lines = formatSlashHelpLines();
  assert.equal(lines.length, SLASH_COMMAND_DEFINITIONS.length);
  for (const entry of SLASH_COMMAND_DEFINITIONS) {
    assert.ok(lines.some((line) => line.includes(entry.usage)), `Missing line for ${entry.name}`);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// getSlashSuggestions
// ──────────────────────────────────────────────────────────────────────────────

test("getSlashSuggestions returns all commands for bare /", () => {
  const suggestions = getSlashSuggestions("/");
  assert.ok(suggestions.length > 0);
});

test("getSlashSuggestions filters by prefix case-insensitively", () => {
  const suggestions = getSlashSuggestions("/EX");
  assert.ok(suggestions.some((s) => s.name === "exit" || s.name === "export"), "should match export or exit");
});

test("getSlashSuggestions returns empty array for non-slash input", () => {
  assert.deepEqual(getSlashSuggestions("hello"), []);
  assert.deepEqual(getSlashSuggestions(""), []);
});

test("getSlashSuggestions respects the limit parameter", () => {
  const suggestions = getSlashSuggestions("/", 3);
  assert.ok(suggestions.length <= 3);
});

test("getSlashSuggestions returns empty when command has args already typed", () => {
  const suggestions = getSlashSuggestions("/mode think_fast");
  assert.deepEqual(suggestions, []);
});

// ──────────────────────────────────────────────────────────────────────────────
// completeSlashCommand
// ──────────────────────────────────────────────────────────────────────────────

test("completeSlashCommand returns null when input already has args", () => {
  const suggestions = [{ name: "mode", completion: "/mode " }];
  const result = completeSlashCommand("/mode think_fast", suggestions);
  assert.equal(result, null);
});

test("completeSlashCommand returns null when no suggestions given", () => {
  assert.equal(completeSlashCommand("/hel", []), null);
  assert.equal(completeSlashCommand("/hel", null), null);
});

test("completeSlashCommand uses first suggestion completion", () => {
  const suggestions = [{ name: "history", completion: "/history " }];
  const result = completeSlashCommand("/hi", suggestions);
  assert.equal(result, "/history ");
});
