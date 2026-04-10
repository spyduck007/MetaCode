import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { formatConversationAsMarkdown, exportConversationToFile } from "../src/export-conversation.js";

const sampleMessages = [
  { role: "banner", text: "Meta Code v1" },
  { role: "system", text: "Welcome to Meta Code." },
  { role: "user", text: "Write me a hello world function." },
  { role: "assistant", text: "Here it is:\n\n```js\nconsole.log('hello world');\n```" },
  { role: "user", text: "Now make it a named function." },
  { role: "assistant", text: "```js\nfunction greet() { console.log('hello world'); }\n```" },
];

test("formatConversationAsMarkdown includes session and mode headers", () => {
  const md = formatConversationAsMarkdown(sampleMessages, {
    sessionName: "my-session",
    mode: "think_fast",
  });
  assert.ok(md.includes("**Session:** my-session"));
  assert.ok(md.includes("**Mode:** think_fast"));
});

test("formatConversationAsMarkdown omits banner and system messages", () => {
  const md = formatConversationAsMarkdown(sampleMessages, {});
  assert.ok(!md.includes("Welcome to Meta Code"));
  assert.ok(!md.includes("Meta Code v1"));
});

test("formatConversationAsMarkdown includes user and assistant messages", () => {
  const md = formatConversationAsMarkdown(sampleMessages, {});
  assert.ok(md.includes("Write me a hello world function"));
  assert.ok(md.includes("Here it is:"));
  assert.ok(md.includes("Now make it a named function"));
});

test("formatConversationAsMarkdown includes ## You and ## Assistant headings", () => {
  const md = formatConversationAsMarkdown(sampleMessages, {});
  assert.ok(md.includes("## You"));
  assert.ok(md.includes("## Assistant"));
});

test("formatConversationAsMarkdown handles empty conversation gracefully", () => {
  const md = formatConversationAsMarkdown([{ role: "banner", text: "banner" }], {});
  assert.ok(md.includes("No conversation messages to export"));
});

test("formatConversationAsMarkdown includes error messages", () => {
  const msgs = [
    { role: "user", text: "Do something." },
    { role: "error", text: "Something went wrong." },
  ];
  const md = formatConversationAsMarkdown(msgs, {});
  assert.ok(md.includes("## Error"));
  assert.ok(md.includes("Something went wrong."));
});

test("exportConversationToFile writes a file and returns metadata", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "meta-export-"));
  try {
    const result = await exportConversationToFile(sampleMessages, {
      outputDir: dir,
      sessionName: "test-session",
      mode: "think_hard",
    });

    assert.ok(result.filePath.startsWith(dir));
    assert.ok(result.filePath.endsWith(".md"));
    assert.ok(result.bytes > 0);
    assert.equal(result.messageCount, 4); // 2 user + 2 assistant

    const content = await readFile(result.filePath, "utf8");
    assert.ok(content.includes("test-session"));
    assert.ok(content.includes("think_hard"));
    assert.ok(content.includes("Write me a hello world function"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("exportConversationToFile uses custom filename when provided", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "meta-export-"));
  try {
    const result = await exportConversationToFile(sampleMessages, {
      outputDir: dir,
      filename: "my-export.md",
    });
    assert.ok(result.filePath.endsWith("my-export.md"));
    const content = await readFile(result.filePath, "utf8");
    assert.ok(content.includes("# Meta Code"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("exportConversationToFile creates nested directories as needed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "meta-export-"));
  try {
    const nestedFilename = path.join(dir, "exports", "subdir", "out.md");
    const result = await exportConversationToFile(sampleMessages, {
      filename: nestedFilename,
    });
    assert.equal(result.filePath, nestedFilename);
    const content = await readFile(nestedFilename, "utf8");
    assert.ok(content.includes("## You"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("exportConversationToFile counts only user and assistant messages", async () => {
  const msgs = [
    { role: "banner", text: "banner" },
    { role: "system", text: "system" },
    { role: "user", text: "q1" },
    { role: "assistant", text: "a1" },
    { role: "error", text: "err" },
  ];
  const dir = await mkdtemp(path.join(os.tmpdir(), "meta-export-"));
  try {
    const result = await exportConversationToFile(msgs, { outputDir: dir });
    assert.equal(result.messageCount, 2); // only user + assistant
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
