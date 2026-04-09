import test from "node:test";
import assert from "node:assert/strict";
import { shouldSubmitPromptOnEnter } from "../src/tui.js";

test("shouldSubmitPromptOnEnter accepts normal Enter submit", () => {
  assert.equal(shouldSubmitPromptOnEnter("\r", { name: "enter", sequence: "\r" }), true);
});

test("shouldSubmitPromptOnEnter rejects shifted Enter", () => {
  assert.equal(shouldSubmitPromptOnEnter("\r", { name: "enter", shift: true, sequence: "\r" }), false);
});

test("shouldSubmitPromptOnEnter rejects line-feed Enter from paste", () => {
  assert.equal(shouldSubmitPromptOnEnter("\n", { name: "enter", sequence: "\n" }), false);
});

test("shouldSubmitPromptOnEnter rejects non-enter keys", () => {
  assert.equal(shouldSubmitPromptOnEnter("a", { name: "a", sequence: "a" }), false);
});

test("shouldSubmitPromptOnEnter rejects enter during rapid input burst", () => {
  assert.equal(
    shouldSubmitPromptOnEnter("\r", { name: "enter", sequence: "\r" }, { rapidInputBurst: true }),
    false
  );
});
