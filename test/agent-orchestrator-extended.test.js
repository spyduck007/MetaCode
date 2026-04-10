import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { extractAgentDirective, runAgentWithFileTools } from "../src/agent-orchestrator.js";
import { executeFileToolCall } from "../src/file-tools.js";

// ──────────────────────────────────────────────────────────────────────────────
// extractAgentDirective edge cases
// ──────────────────────────────────────────────────────────────────────────────

test("extractAgentDirective parses follow-up with no choices", () => {
  const directive = extractAgentDirective(
    '{"type":"follow_up","question":"What name should I use?","allow_freeform":true}'
  );
  assert.equal(directive.type, "follow_up");
  assert.equal(directive.question, "What name should I use?");
  assert.deepEqual(directive.choices, []);
  assert.equal(directive.allowFreeform, true);
});

test("extractAgentDirective handles nested JSON in content field", () => {
  // Sometimes the model wraps the final in another final
  const inner = JSON.stringify({ type: "final", content: "The real answer." });
  const directive = extractAgentDirective(JSON.stringify({ type: "final", content: inner }));
  assert.equal(directive.type, "final");
  assert.equal(directive.content, "The real answer.");
});

test("extractAgentDirective handles thought field in tool_call", () => {
  const directive = extractAgentDirective(
    '{"type":"tool_call","name":"read_file","arguments":{"path":"x.txt"},"thought":"Reading the file to understand content."}'
  );
  assert.equal(directive.type, "tool_call");
  assert.equal(directive.thought, "Reading the file to understand content.");
});

test("extractAgentDirective treats tool_call-like JSON without type field as tool_call", () => {
  const directive = extractAgentDirective(
    '{"name":"write_file","arguments":{"path":"a.txt","content":"hello"}}'
  );
  assert.equal(directive.type, "tool_call");
  assert.equal(directive.name, "write_file");
});

test("extractAgentDirective falls back to plain text as final for non-JSON", () => {
  const directive = extractAgentDirective("This is a plain text answer.");
  assert.equal(directive.type, "final");
  assert.equal(directive.content, "This is a plain text answer.");
});

// ──────────────────────────────────────────────────────────────────────────────
// runAgentWithFileTools — glob_files tool integration
// ──────────────────────────────────────────────────────────────────────────────

test("runAgentWithFileTools can use glob_files tool and return results", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-agent-ext-"));
  try {
    await writeFile(path.join(workspace, "app.ts"), "const x = 1;", "utf8");
    await writeFile(path.join(workspace, "utils.ts"), "export function y() {}", "utf8");
    await writeFile(path.join(workspace, "README.md"), "# readme", "utf8");

    const scriptedResponses = [
      '{"type":"tool_call","name":"glob_files","arguments":{"pattern":"**/*.ts"}}',
      '{"type":"final","content":"Found TypeScript files."}',
    ];

    const fakeClient = {
      async sendMessage() {
        const content = scriptedResponses.shift();
        return { content, conversationId: "conv-glob", currentBranchPath: "0", mode: "think_fast" };
      },
    };

    const toolCalls = [];
    const result = await runAgentWithFileTools({
      client: fakeClient,
      task: "Find all TypeScript files.",
      conversationId: "conv-glob",
      currentBranchPath: "0",
      mode: "think_fast",
      workspaceRoot: workspace,
      onToolCall: (call) => toolCalls.push(call),
    });

    assert.equal(result.content, "Found TypeScript files.");
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].name, "glob_files");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// runAgentWithFileTools — collectTouchedFiles behaviour
// ──────────────────────────────────────────────────────────────────────────────

test("runAgentWithFileTools tracks touched files via write_file", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-agent-ext-"));
  try {
    const scriptedResponses = [
      '{"type":"tool_call","name":"write_file","arguments":{"path":"output.txt","content":"hello"}}',
      '{"type":"final","content":"File written."}',
    ];

    const fakeClient = {
      async sendMessage() {
        return {
          content: scriptedResponses.shift(),
          conversationId: "conv-touch",
          currentBranchPath: "0",
          mode: "think_fast",
        };
      },
    };

    const toolResults = [];
    await runAgentWithFileTools({
      client: fakeClient,
      task: "Write a file.",
      conversationId: "conv-touch",
      currentBranchPath: "0",
      mode: "think_fast",
      workspaceRoot: workspace,
      onToolResult: (r) => toolResults.push(r),
    });

    assert.equal(toolResults.length, 1);
    assert.equal(toolResults[0].ok, true);

    // Confirm file was actually written
    const content = await readFile(path.join(workspace, "output.txt"), "utf8");
    assert.equal(content, "hello");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// runAgentWithFileTools — max steps exhaustion fallback
// ──────────────────────────────────────────────────────────────────────────────

test("runAgentWithFileTools falls back when max steps exhausted", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-agent-ext-"));
  try {
    // Agent always returns a tool call, never a final — exhausts steps
    const fakeClient = {
      callCount: 0,
      async sendMessage() {
        this.callCount += 1;
        // After step exhaustion, expect force-finalize call
        if (this.callCount > 4) {
          return {
            content: '{"type":"final","content":"Force-finalized."}',
            conversationId: "conv-steps",
            currentBranchPath: "0",
            mode: "think_fast",
          };
        }
        return {
          content: '{"type":"tool_call","name":"list_dir","arguments":{"path":"."}}',
          conversationId: "conv-steps",
          currentBranchPath: "0",
          mode: "think_fast",
        };
      },
    };

    const result = await runAgentWithFileTools({
      client: fakeClient,
      task: "List everything.",
      conversationId: "conv-steps",
      currentBranchPath: "0",
      mode: "think_fast",
      workspaceRoot: workspace,
      maxSteps: 4,
    });

    assert.ok(result.content, "should have some content after step exhaustion");
    assert.ok(result.steps >= 4, "steps should reflect that we used them all");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// runAgentWithFileTools — command approval denied path
// ──────────────────────────────────────────────────────────────────────────────

test("runAgentWithFileTools handles denied command and continues", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-agent-ext-"));
  try {
    const scriptedResponses = [
      '{"type":"tool_call","name":"run_command","arguments":{"command":"echo hello"}}',
      '{"type":"final","content":"Completed after denied command."}',
    ];

    const fakeClient = {
      async sendMessage() {
        return {
          content: scriptedResponses.shift(),
          conversationId: "conv-cmd",
          currentBranchPath: "0",
          mode: "think_fast",
        };
      },
    };

    const toolResults = [];
    const result = await runAgentWithFileTools({
      client: fakeClient,
      task: "Run echo.",
      conversationId: "conv-cmd",
      currentBranchPath: "0",
      mode: "think_fast",
      workspaceRoot: workspace,
      maxSteps: 4,
      onCommandApproval: async () => ({ approved: false, reason: "Test: user denied command" }),
      onToolResult: (r) => toolResults.push(r),
    });

    assert.equal(result.content, "Completed after denied command.");
    assert.equal(toolResults.length, 1);
    // Command denial is surfaced as a failed tool result
    assert.equal(toolResults[0].ok, false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// runAgentWithFileTools — approved command runs
// ──────────────────────────────────────────────────────────────────────────────

test("runAgentWithFileTools runs approved command and captures output", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-agent-ext-"));
  try {
    const scriptedResponses = [
      '{"type":"tool_call","name":"run_command","arguments":{"command":"echo hello-world","cwd":"."}}',
      '{"type":"final","content":"Command ran successfully."}',
    ];

    const fakeClient = {
      async sendMessage() {
        return {
          content: scriptedResponses.shift(),
          conversationId: "conv-yolo",
          currentBranchPath: "0",
          mode: "think_fast",
        };
      },
    };

    const toolResults = [];
    const result = await runAgentWithFileTools({
      client: fakeClient,
      task: "Run echo.",
      conversationId: "conv-yolo",
      currentBranchPath: "0",
      mode: "think_fast",
      workspaceRoot: workspace,
      maxSteps: 4,
      onCommandApproval: async () => ({ approved: true }),
      onToolResult: (r) => toolResults.push(r),
    });

    assert.equal(result.content, "Command ran successfully.");
    assert.equal(toolResults.length, 1);
    assert.equal(toolResults[0].ok, true);
    assert.ok(String(toolResults[0].result?.stdout ?? "").includes("hello-world"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// runAgentWithFileTools — onStatus callback
// ──────────────────────────────────────────────────────────────────────────────

test("runAgentWithFileTools calls onStatus with step progress", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-agent-ext-"));
  try {
    const scriptedResponses = [
      '{"type":"final","content":"Quick answer."}',
    ];

    const fakeClient = {
      async sendMessage() {
        return {
          content: scriptedResponses.shift(),
          conversationId: "conv-status",
          currentBranchPath: "0",
          mode: "think_fast",
        };
      },
    };

    const statusMessages = [];
    await runAgentWithFileTools({
      client: fakeClient,
      task: "Simple task.",
      conversationId: "conv-status",
      currentBranchPath: "0",
      mode: "think_fast",
      workspaceRoot: workspace,
      maxSteps: 5,
      onStatus: (msg) => statusMessages.push(msg),
    });

    assert.ok(statusMessages.some((m) => m.startsWith("step ")), "should emit step N/M status messages");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// runAgentWithFileTools — onDelta callback
// ──────────────────────────────────────────────────────────────────────────────

test("runAgentWithFileTools calls onDelta with final answer content", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-agent-delta-"));
  try {
    const scriptedResponses = [
      '{"type":"final","content":"The answer is 42."}',
    ];

    const deltas = [];
    const fakeClient = {
      async sendMessage({ onDelta }) {
        const content = scriptedResponses.shift();
        // Simulate streaming by calling onDelta with chunks
        if (onDelta) {
          onDelta('{"type":"final","content":"The answer is 42."}');
        }
        return {
          content,
          conversationId: "conv-delta",
          currentBranchPath: "0",
          mode: "think_fast",
        };
      },
    };

    await runAgentWithFileTools({
      client: fakeClient,
      task: "What is the answer?",
      conversationId: "conv-delta",
      currentBranchPath: "0",
      mode: "think_fast",
      workspaceRoot: workspace,
      onDelta: (chunk) => deltas.push(chunk),
    });

    assert.ok(deltas.length > 0, "onDelta should have been called");
    assert.equal(deltas[deltas.length - 1], "The answer is 42.");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runAgentWithFileTools awaits onToolCall before executing tool", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-agent-toolcall-order-"));
  try {
    const scriptedResponses = [
      '{"type":"tool_call","name":"write_file","arguments":{"path":"ordered.txt","content":"ok"}}',
      '{"type":"final","content":"Done."}',
    ];

    let snapshotDone = false;
    let snapshotDoneAtToolResult = false;
    const fakeClient = {
      async sendMessage() {
        return {
          content: scriptedResponses.shift(),
          conversationId: "conv-order",
          currentBranchPath: "0",
          mode: "think_fast",
        };
      },
    };

    await runAgentWithFileTools({
      client: fakeClient,
      task: "Write a file.",
      conversationId: "conv-order",
      currentBranchPath: "0",
      mode: "think_fast",
      workspaceRoot: workspace,
      onToolCall: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        snapshotDone = true;
      },
      onToolResult: () => {
        snapshotDoneAtToolResult = snapshotDone;
      },
    });

    assert.equal(snapshotDone, true);
    assert.equal(snapshotDoneAtToolResult, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// runAgentWithFileTools — touchedFiles in result
// ──────────────────────────────────────────────────────────────────────────────

test("runAgentWithFileTools includes touchedFiles array in result", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-agent-tf-"));
  try {
    const scriptedResponses = [
      '{"type":"tool_call","name":"write_file","arguments":{"path":"result.txt","content":"done"}}',
      '{"type":"final","content":"File created."}',
    ];

    const fakeClient = {
      async sendMessage({ onDelta }) {
        return {
          content: scriptedResponses.shift(),
          conversationId: "conv-tf",
          currentBranchPath: "0",
          mode: "think_fast",
        };
      },
    };

    const result = await runAgentWithFileTools({
      client: fakeClient,
      task: "Create a file.",
      conversationId: "conv-tf",
      currentBranchPath: "0",
      mode: "think_fast",
      workspaceRoot: workspace,
    });

    assert.ok(Array.isArray(result.touchedFiles), "result.touchedFiles should be an array");
    assert.ok(result.touchedFiles.length > 0, "result.touchedFiles should contain the written file");
    assert.ok(
      result.touchedFiles.some((f) => f.includes("result.txt")),
      "result.touchedFiles should include result.txt"
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runAgentWithFileTools result has touchedFiles even when no files touched", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-agent-tf-empty-"));
  try {
    const fakeClient = {
      async sendMessage() {
        return {
          content: '{"type":"final","content":"No files needed."}',
          conversationId: "conv-tf-empty",
          currentBranchPath: "0",
          mode: "think_fast",
        };
      },
    };

    const result = await runAgentWithFileTools({
      client: fakeClient,
      task: "Simple question.",
      conversationId: "conv-tf-empty",
      currentBranchPath: "0",
      mode: "think_fast",
      workspaceRoot: workspace,
    });

    assert.ok(Array.isArray(result.touchedFiles), "result.touchedFiles should be an array");
    assert.equal(result.touchedFiles.length, 0, "should be empty when no files touched");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
