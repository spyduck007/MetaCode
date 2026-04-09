import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { extractAgentDirective, runAgentWithFileTools } from "../src/agent-orchestrator.js";
import { executeFileToolCall } from "../src/file-tools.js";

test("extractAgentDirective parses fenced tool call JSON", () => {
  const directive = extractAgentDirective(
    '```json\n{"type":"tool_call","name":"read_file","arguments":{"path":"README.md"}}\n```'
  );
  assert.equal(directive.type, "tool_call");
  assert.equal(directive.name, "read_file");
  assert.equal(directive.arguments.path, "README.md");
});

test("extractAgentDirective treats plain text as final fallback", () => {
  const directive = extractAgentDirective("Here is your plain answer.");
  assert.equal(directive.type, "final");
  assert.equal(directive.content, "Here is your plain answer.");
});

test("extractAgentDirective accepts response-field JSON as final", () => {
  const directive = extractAgentDirective('{"response":"Done from response key."}');
  assert.equal(directive.type, "final");
  assert.equal(directive.content, "Done from response key.");
});

test("extractAgentDirective unwraps escaped final JSON output", () => {
  const directive = extractAgentDirective(
    '\\"{\\"type\\":\\"final\\",\\"content\\":\\"Clean final answer.\\"}\\"'
  );
  assert.equal(directive.type, "final");
  assert.equal(directive.content, "Clean final answer.");
});

test("extractAgentDirective unwraps slash-prefixed final JSON output", () => {
  const directive = extractAgentDirective(
    '\\{"type":"final","content":"Recovered from slash-prefixed JSON."}'
  );
  assert.equal(directive.type, "final");
  assert.equal(directive.content, "Recovered from slash-prefixed JSON.");
});

test("extractAgentDirective supports final value key", () => {
  const directive = extractAgentDirective('{"type":"final","value":"Done using value key."}');
  assert.equal(directive.type, "final");
  assert.equal(directive.content, "Done using value key.");
});

test("extractAgentDirective unwraps escaped final value JSON output", () => {
  const directive = extractAgentDirective(
    '\\{"type":"final","value":"Done from escaped value payload."}'
  );
  assert.equal(directive.type, "final");
  assert.equal(directive.content, "Done from escaped value payload.");
});

test("runAgentWithFileTools executes tool call then returns final", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-agent-test-"));
  try {
    await executeFileToolCall(
      {
        name: "write_file",
        arguments: { path: "hello.txt", content: "hi" },
      },
      { workspaceRoot: workspace }
    );

    const scriptedResponses = [
      '```json\n{"type":"tool_call","name":"list_dir","arguments":{"path":"."}}\n```',
      '```json\n{"type":"final","content":"Finished."}\n```',
    ];

    const fakeClient = {
      async sendMessage() {
        const content = scriptedResponses.shift();
        return {
          content,
          conversationId: "conv-1",
          currentBranchPath: "2",
          mode: "think_fast",
        };
      },
    };

    const toolCalls = [];
    const toolResults = [];

    const result = await runAgentWithFileTools({
      client: fakeClient,
      task: "List files and finish.",
      conversationId: "conv-1",
      currentBranchPath: "0",
      mode: "think_fast",
      workspaceRoot: workspace,
      onToolCall: (call) => toolCalls.push(call),
      onToolResult: (outcome) => toolResults.push(outcome),
    });

    assert.equal(result.content, "Finished.");
    assert.equal(result.steps, 2);
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].name, "list_dir");
    assert.equal(toolResults.length, 1);
    assert.equal(toolResults[0].ok, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runAgentWithFileTools can finalize without tool call", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-agent-test-"));
  try {
    const scriptedResponses = ['```json\n{"type":"final","content":"Done directly."}\n```'];

    const fakeClient = {
      async sendMessage() {
        const content = scriptedResponses.shift();
        return {
          content,
          conversationId: "conv-2",
          currentBranchPath: "3",
          mode: "think_fast",
        };
      },
    };

    const result = await runAgentWithFileTools({
      client: fakeClient,
      task: "Use tools.",
      conversationId: "conv-2",
      currentBranchPath: "0",
      mode: "think_fast",
      workspaceRoot: workspace,
    });

    assert.equal(result.content, "Done directly.");
    assert.equal(result.steps, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runAgentWithFileTools breaks repeated tool loop and still finalizes", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-agent-test-"));
  try {
    await executeFileToolCall(
      {
        name: "write_file",
        arguments: { path: "hello.txt", content: "hi" },
      },
      { workspaceRoot: workspace }
    );

    const scriptedResponses = [
      '```json\n{"type":"tool_call","name":"list_dir","arguments":{"path":"."}}\n```',
      '```json\n{"type":"tool_call","name":"list_dir","arguments":{"path":"."}}\n```',
      '```json\n{"type":"tool_call","name":"list_dir","arguments":{"path":"."}}\n```',
      '```json\n{"type":"final","content":"Finished after loop break."}\n```',
    ];

    const fakeClient = {
      async sendMessage() {
        const content = scriptedResponses.shift();
        return {
          content,
          conversationId: "conv-loop",
          currentBranchPath: "4",
          mode: "think_fast",
        };
      },
    };

    const result = await runAgentWithFileTools({
      client: fakeClient,
      task: "List files and finish.",
      conversationId: "conv-loop",
      currentBranchPath: "0",
      mode: "think_fast",
      workspaceRoot: workspace,
      maxSteps: 6,
    });

    assert.equal(result.content, "Finished after loop break.");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runAgentWithFileTools nudges past permission question for create-from-scratch task", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-agent-test-"));
  try {
    const scriptedResponses = [
      '```json\n{"type":"final","content":"The directory is empty. Do you want me to create files?"}\n```',
      '```json\n{"type":"tool_call","name":"write_file","arguments":{"path":"index.html","content":"<h1>Hello</h1>"}}\n```',
      '```json\n{"type":"final","content":"Done, created index.html."}\n```',
    ];

    const fakeClient = {
      async sendMessage() {
        const content = scriptedResponses.shift();
        return {
          content,
          conversationId: "conv-create",
          currentBranchPath: "2",
          mode: "think_fast",
        };
      },
    };

    const result = await runAgentWithFileTools({
      client: fakeClient,
      task: "Build a full site from scratch.",
      conversationId: "conv-create",
      currentBranchPath: "0",
      mode: "think_fast",
      workspaceRoot: workspace,
    });

    assert.equal(result.content, "Done, created index.html.");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runAgentWithFileTools continues when final response is clearly incomplete", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-agent-test-"));
  try {
    const scriptedResponses = [
      '```json\n{"type":"tool_call","name":"write_file","arguments":{"path":"index.html","content":"ok"}}\n```',
      '```json\n{"type":"final","content":"Starting with styles next."}\n```',
      '```json\n{"type":"tool_call","name":"write_file","arguments":{"path":"styles.css","content":"ok"}}\n```',
      '```json\n{"type":"final","content":"Done now."}\n```',
    ];

    const fakeClient = {
      async sendMessage() {
        const content = scriptedResponses.shift();
        return {
          content,
          conversationId: "conv-incomplete",
          currentBranchPath: "2",
          mode: "think_fast",
        };
      },
    };

    const result = await runAgentWithFileTools({
      client: fakeClient,
      task: "Create index.html and styles.css from scratch.",
      conversationId: "conv-incomplete",
      currentBranchPath: "0",
      mode: "think_fast",
      workspaceRoot: workspace,
    });

    assert.equal(result.content, "Done now.");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
