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

test("extractAgentDirective parses follow-up directive with choices", () => {
  const directive = extractAgentDirective(
    '{"type":"follow_up","question":"Pick a stack","choices":["React","Vue"],"allow_freeform":true}'
  );
  assert.equal(directive.type, "follow_up");
  assert.equal(directive.question, "Pick a stack");
  assert.deepEqual(directive.choices, ["React", "Vue"]);
  assert.equal(directive.allowFreeform, true);
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

test("runAgentWithFileTools asks one follow-up when stuck after progress", async () => {
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
      '```json\n{"type":"tool_call","name":"read_file","arguments":{"path":"hello.txt"}}\n```',
      '```json\n{"type":"follow_up","question":"Choose output format","choices":["json","markdown"],"allow_freeform":true}\n```',
      '```json\n{"type":"final","content":"Done with the requested format."}\n```',
    ];

    const fakeClient = {
      async sendMessage() {
        const content = scriptedResponses.shift();
        return {
          content,
          conversationId: "conv-follow-up",
          currentBranchPath: "3",
          mode: "think_fast",
        };
      },
    };

    const asked = [];
    const result = await runAgentWithFileTools({
      client: fakeClient,
      task: "Inspect files and finish with the preferred format.",
      conversationId: "conv-follow-up",
      currentBranchPath: "0",
      mode: "think_fast",
      workspaceRoot: workspace,
      onFollowUpQuestion: async (questionPayload) => {
        asked.push(questionPayload);
        return "markdown";
      },
    });

    assert.equal(result.content, "Done with the requested format.");
    assert.equal(asked.length, 1);
    assert.equal(asked[0].question, "Choose output format");
    assert.deepEqual(asked[0].choices, ["json", "markdown"]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runAgentWithFileTools blocks early follow-up requests", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-agent-test-"));
  try {
    const scriptedResponses = [
      '```json\n{"type":"follow_up","question":"What should I do next?","choices":["A","B"]}\n```',
      '```json\n{"type":"final","content":"Used best assumptions and completed."}\n```',
    ];

    const fakeClient = {
      async sendMessage() {
        const content = scriptedResponses.shift();
        return {
          content,
          conversationId: "conv-early-follow-up",
          currentBranchPath: "1",
          mode: "think_fast",
        };
      },
    };

    let followUpCalls = 0;
    const result = await runAgentWithFileTools({
      client: fakeClient,
      task: "Do the task end-to-end.",
      conversationId: "conv-early-follow-up",
      currentBranchPath: "0",
      mode: "think_fast",
      workspaceRoot: workspace,
      onFollowUpQuestion: async () => {
        followUpCalls += 1;
        return "A";
      },
    });

    assert.equal(result.content, "Used best assumptions and completed.");
    assert.equal(followUpCalls, 0);
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

test("runAgentWithFileTools rejects manual handoff after tool errors and continues", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-agent-test-"));
  try {
    await executeFileToolCall(
      {
        name: "write_file",
        arguments: { path: "server/index.js", content: "const app = {};\n" },
      },
      { workspaceRoot: workspace }
    );

    const scriptedResponses = [
      '```json\n{"type":"tool_call","name":"edit_file","arguments":{"path":"server/index.js","oldText":"const missing = true;","newText":"const app = true;"}}\n```',
      '```json\n{"type":"final","content":"I hit a loop trying to fix the files automatically. Here are the exact fixes you need to make."}\n```',
      '```json\n{"type":"tool_call","name":"write_file","arguments":{"path":"server/index.js","content":"const app = true;\\n"}}\n```',
      '```json\n{"type":"final","content":"Done, the file is fixed automatically."}\n```',
    ];

    const fakeClient = {
      async sendMessage() {
        const content = scriptedResponses.shift();
        return {
          content,
          conversationId: "conv-manual-handoff",
          currentBranchPath: "5",
          mode: "think_fast",
        };
      },
    };

    const result = await runAgentWithFileTools({
      client: fakeClient,
      task: "Fix the server file completely.",
      conversationId: "conv-manual-handoff",
      currentBranchPath: "0",
      mode: "think_fast",
      workspaceRoot: workspace,
      maxSteps: 8,
    });

    assert.equal(result.content, "Done, the file is fixed automatically.");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runAgentWithFileTools reseeds conversation after refusal and keeps going", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-agent-test-"));
  try {
    const scriptedResponses = [
      {
        content: '```json\n{"type":"tool_call","name":"mkdir","arguments":{"path":"client","recursive":true}}\n```',
        conversationId: "conv-a",
        currentBranchPath: "1",
        mode: "think_fast",
      },
      {
        content:
          '```json\n{"type":"final","content":"Sorry, I can’t help you with this request right now. Is there anything else I can help you with?"}\n```',
        conversationId: "conv-a",
        currentBranchPath: "1",
        mode: "think_fast",
      },
      {
        content:
          '```json\n{"type":"tool_call","name":"write_file","arguments":{"path":"README.md","content":"ok","overwrite":true}}\n```',
        conversationId: "conv-b",
        currentBranchPath: "0",
        mode: "think_fast",
      },
      {
        content: '```json\n{"type":"final","content":"Completed after reseed."}\n```',
        conversationId: "conv-b",
        currentBranchPath: "2",
        mode: "think_fast",
      },
    ];
    const callInputs = [];

    const fakeClient = {
      async sendMessage(input) {
        callInputs.push(input);
        return scriptedResponses.shift();
      },
    };

    const result = await runAgentWithFileTools({
      client: fakeClient,
      task: "Create a dashboard app in this folder.",
      conversationId: "conv-provider-refusal",
      currentBranchPath: "0",
      mode: "think_fast",
      workspaceRoot: workspace,
      maxSteps: 8,
    });

    assert.equal(result.content, "Completed after reseed.");
    assert.equal(callInputs[2].conversationId, undefined);
    assert.match(callInputs[2].content, /RECOVERY_RESEED/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runAgentWithFileTools omits large write_file content in tool feedback prompt", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-agent-test-"));
  try {
    const largeContent = "x".repeat(5000);
    const scriptedResponses = [
      `\`\`\`json\n{"type":"tool_call","name":"write_file","arguments":{"path":"big.txt","content":"${largeContent}","overwrite":true}}\n\`\`\``,
      '```json\n{"type":"final","content":"Done."}\n```',
    ];
    const callInputs = [];

    const fakeClient = {
      async sendMessage(input) {
        callInputs.push(input);
        const content = scriptedResponses.shift();
        return {
          content,
          conversationId: "conv-feedback-sanitize",
          currentBranchPath: "3",
          mode: "think_fast",
        };
      },
    };

    const result = await runAgentWithFileTools({
      client: fakeClient,
      task: "Create one file.",
      conversationId: "conv-feedback-sanitize",
      currentBranchPath: "0",
      mode: "think_fast",
      workspaceRoot: workspace,
      maxSteps: 4,
    });

    assert.equal(result.content, "Done.");
    assert.match(callInputs[1].content, /\[omitted 5000 chars\]/);
    assert.equal(callInputs[1].content.includes("xxxxxxxxxxxxxxxxxxxxxxxx"), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runAgentWithFileTools does not treat Node.js as required file", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-agent-test-"));
  try {
    const scriptedResponses = [
      '```json\n{"type":"tool_call","name":"write_file","arguments":{"path":"package.json","content":"{}","overwrite":true}}\n```',
      '```json\n{"type":"final","content":"Done."}\n```',
    ];

    const fakeClient = {
      async sendMessage() {
        const content = scriptedResponses.shift();
        return {
          content,
          conversationId: "conv-nodejs-file-check",
          currentBranchPath: "11",
          mode: "think_fast",
        };
      },
    };

    const result = await runAgentWithFileTools({
      client: fakeClient,
      task: "Use Node.js and include package.json in the project.",
      conversationId: "conv-nodejs-file-check",
      currentBranchPath: "0",
      mode: "think_fast",
      workspaceRoot: workspace,
      maxSteps: 4,
    });

    assert.equal(result.content, "Done.");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
