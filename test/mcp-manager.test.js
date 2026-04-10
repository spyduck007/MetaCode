import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { MCPManager } from "../src/mcp-manager.js";

function createRpcHttpServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.end("method not allowed");
        return;
      }
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", async () => {
        try {
          const payload = JSON.parse(body || "{}");
          const result = await handler(payload);
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(result));
        } catch (error) {
          res.statusCode = 500;
          res.end(String(error?.message ?? error));
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}/mcp`,
      });
    });
  });
}

test("MCPManager discovers and executes stdio MCP tools", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-mcp-manager-"));
  const scriptPath = path.join(workspace, "fake-stdio-mcp.js");
  const scriptContent = `
let buffer = Buffer.alloc(0);
function send(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  process.stdout.write("Content-Length: " + body.length + "\\r\\n\\r\\n");
  process.stdout.write(body);
}
function handle(message) {
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
    return;
  }
  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Echo text",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"]
            }
          },
          {
            name: "add",
            description: "Add numbers",
            inputSchema: {
              type: "object",
              properties: { a: { type: "number" }, b: { type: "number" } },
              required: ["a", "b"]
            }
          }
        ]
      }
    });
    return;
  }
  if (message.method === "tools/call") {
    const args = message.params?.arguments || {};
    if (message.params?.name === "echo") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: String(args.text || "") }], isError: false }
      });
      return;
    }
    if (message.params?.name === "add") {
      const sum = Number(args.a || 0) + Number(args.b || 0);
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: String(sum) }], isError: false }
      });
      return;
    }
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown tool" } });
    return;
  }
}
function flush() {
  while (true) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd < 0) return;
    const header = buffer.slice(0, headerEnd).toString("utf8");
    const match = header.match(/content-length:\\s*(\\d+)/i);
    if (!match) {
      buffer = buffer.slice(headerEnd + 4);
      continue;
    }
    const length = Number.parseInt(match[1], 10);
    const frameEnd = headerEnd + 4 + length;
    if (buffer.length < frameEnd) return;
    const body = buffer.slice(headerEnd + 4, frameEnd).toString("utf8");
    buffer = buffer.slice(frameEnd);
    try {
      handle(JSON.parse(body));
    } catch {}
  }
}
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  flush();
});
`;
  await writeFile(scriptPath, scriptContent, "utf8");

  const manager = new MCPManager({
    workspaceRoot: workspace,
    mcpServers: {
      local: {
        type: "stdio",
        command: process.execPath,
        args: [scriptPath],
        trust: true,
      },
    },
  });

  try {
    const discovery = await manager.discoverTools();
    assert.equal(discovery.errors.length, 0);
    assert.ok(discovery.tools.some((tool) => tool.name === "mcp.local.echo"));
    assert.ok(discovery.tools.some((tool) => tool.name === "mcp.local.add"));

    const outcome = await manager.executeToolCall({
      name: "mcp.local.add",
      arguments: { a: 3, b: 4 },
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.result.tool, "add");
  } finally {
    await manager.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("MCPManager enforces approval for untrusted servers", async () => {
  const { server, url } = await createRpcHttpServer(async (payload) => {
    if (payload.method === "initialize") {
      return { jsonrpc: "2.0", id: payload.id, result: { capabilities: {} } };
    }
    if (payload.method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id: payload.id,
        result: { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }] },
      };
    }
    if (payload.method === "tools/call") {
      return {
        jsonrpc: "2.0",
        id: payload.id,
        result: { content: [{ type: "text", text: "ok" }], isError: false },
      };
    }
    return { jsonrpc: "2.0", id: payload.id, result: {} };
  });

  const manager = new MCPManager({
    mcpServers: {
      docs: {
        type: "http",
        url,
        trust: false,
      },
    },
  });

  try {
    await manager.discoverTools();
    let approvalRequested = false;
    const outcome = await manager.executeToolCall(
      { name: "mcp.docs.echo", arguments: {} },
      {
        onApproval: async () => {
          approvalRequested = true;
          return { approved: false, reason: "denied for test" };
        },
      }
    );
    assert.equal(approvalRequested, true);
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /denied for test/);
  } finally {
    await manager.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("MCPManager supports HTTP and SSE-style messageUrl transports", async () => {
  const { server, url } = await createRpcHttpServer(async (payload) => {
    if (payload.method === "initialize") {
      return { jsonrpc: "2.0", id: payload.id, result: { capabilities: {} } };
    }
    if (payload.method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id: payload.id,
        result: { tools: [{ name: "ping", description: "Ping tool", inputSchema: { type: "object" } }] },
      };
    }
    if (payload.method === "tools/call") {
      return {
        jsonrpc: "2.0",
        id: payload.id,
        result: { content: [{ type: "text", text: "pong" }], isError: false },
      };
    }
    return { jsonrpc: "2.0", id: payload.id, result: {} };
  });

  const manager = new MCPManager({
    mcpServers: {
      web: {
        type: "http",
        url,
        trust: true,
      },
      ssebridge: {
        type: "sse",
        url: "http://127.0.0.1:9/unused",
        messageUrl: url,
        trust: true,
      },
    },
  });

  try {
    const discovery = await manager.discoverTools();
    assert.equal(discovery.errors.length, 0);
    assert.ok(discovery.tools.some((tool) => tool.name === "mcp.web.ping"));
    assert.ok(discovery.tools.some((tool) => tool.name === "mcp.ssebridge.ping"));

    const outcome = await manager.executeToolCall({
      name: "mcp.ssebridge.ping",
      arguments: {},
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.result.server, "ssebridge");
  } finally {
    await manager.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("MCPManager applies allow/deny filters during discovery", async () => {
  const { server, url } = await createRpcHttpServer(async (payload) => {
    if (payload.method === "initialize") {
      return { jsonrpc: "2.0", id: payload.id, result: { capabilities: {} } };
    }
    if (payload.method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          tools: [
            { name: "allowed", description: "allowed", inputSchema: { type: "object" } },
            { name: "blocked", description: "blocked", inputSchema: { type: "object" } },
          ],
        },
      };
    }
    if (payload.method === "tools/call") {
      return { jsonrpc: "2.0", id: payload.id, result: { content: [], isError: false } };
    }
    return { jsonrpc: "2.0", id: payload.id, result: {} };
  });

  const manager = new MCPManager({
    mcpServers: {
      policy: {
        type: "http",
        url,
        trust: true,
        allowTools: ["allowed"],
      },
    },
  });

  try {
    const discovery = await manager.discoverTools();
    assert.equal(discovery.tools.some((tool) => tool.name === "mcp.policy.allowed"), true);
    assert.equal(discovery.tools.some((tool) => tool.name === "mcp.policy.blocked"), false);
  } finally {
    await manager.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("MCPManager adapts startup timeout for package-exec stdio servers", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-mcp-manager-"));
  const fakeNpxPath = path.join(workspace, "npx");
  const scriptContent = `#!/usr/bin/env node
let buffer = Buffer.alloc(0);
function send(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  process.stdout.write("Content-Length: " + body.length + "\\r\\n\\r\\n");
  process.stdout.write(body);
}
function handle(message) {
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
    return;
  }
  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Echo text",
            inputSchema: { type: "object", properties: { text: { type: "string" } } }
          }
        ]
      }
    });
    return;
  }
  if (message.method === "tools/call") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "text", text: "ok" }], isError: false }
    });
  }
}
function flush() {
  while (true) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd < 0) return;
    const header = buffer.slice(0, headerEnd).toString("utf8");
    const match = header.match(/content-length:\\s*(\\d+)/i);
    if (!match) {
      buffer = buffer.slice(headerEnd + 4);
      continue;
    }
    const length = Number.parseInt(match[1], 10);
    const frameEnd = headerEnd + 4 + length;
    if (buffer.length < frameEnd) return;
    const body = buffer.slice(headerEnd + 4, frameEnd).toString("utf8");
    buffer = buffer.slice(frameEnd);
    try {
      handle(JSON.parse(body));
    } catch {}
  }
}
setTimeout(() => {
  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    flush();
  });
}, 1500);
`;
  await writeFile(fakeNpxPath, scriptContent, "utf8");
  await chmod(fakeNpxPath, 0o755);

  const manager = new MCPManager({
    workspaceRoot: workspace,
    mcpServers: {
      delayed: {
        type: "stdio",
        command: fakeNpxPath,
        startupTimeoutMs: 1000,
        trust: true,
      },
    },
  });

  try {
    const discovery = await manager.discoverTools();
    assert.equal(discovery.errors.length, 0);
    assert.ok(discovery.tools.some((tool) => tool.name === "mcp.delayed.echo"));
  } finally {
    await manager.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("MCPManager falls back to JSONL stdio protocol when content-length handshake times out", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "meta-mcp-manager-"));
  const serverPath = path.join(workspace, "jsonl-mcp");
  const scriptContent = `#!/usr/bin/env node
let lineBuffer = "";
function send(payload) {
  process.stdout.write(JSON.stringify(payload) + "\\n");
}
function handle(message) {
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
    return;
  }
  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object" } }]
      }
    });
    return;
  }
  if (message.method === "tools/call") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "text", text: "ok" }], isError: false }
    });
  }
}
process.stdin.on("data", (chunk) => {
  lineBuffer += chunk.toString("utf8");
  let idx = lineBuffer.indexOf("\\n");
  while (idx >= 0) {
    const line = lineBuffer.slice(0, idx).trim();
    lineBuffer = lineBuffer.slice(idx + 1);
    idx = lineBuffer.indexOf("\\n");
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch {}
  }
});
`;
  await writeFile(serverPath, scriptContent, "utf8");
  await chmod(serverPath, 0o755);

  const manager = new MCPManager({
    workspaceRoot: workspace,
    mcpServers: {
      jsonl: {
        type: "stdio",
        command: serverPath,
        startupTimeoutMs: 1000,
        trust: true,
      },
    },
  });

  try {
    const discovery = await manager.discoverTools();
    assert.equal(discovery.errors.length, 0);
    assert.ok(discovery.tools.some((tool) => tool.name === "mcp.jsonl.echo"));
  } finally {
    await manager.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
