import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeMcpServerConfig,
  normalizeMcpServers,
  parseKeyValueEntries,
  removeMcpServerConfig,
  upsertMcpServerConfig,
} from "../src/mcp-config.js";

test("normalizeMcpServerConfig normalizes stdio defaults", () => {
  const server = normalizeMcpServerConfig("local", {
    command: "npx",
    args: ["-y", "test-mcp"],
  });
  assert.equal(server.name, "local");
  assert.equal(server.type, "stdio");
  assert.equal(server.enabled, true);
  assert.equal(server.trust, false);
  assert.equal(server.command, "npx");
  assert.deepEqual(server.args, ["-y", "test-mcp"]);
});

test("normalizeMcpServers skips invalid names and normalizes values", () => {
  const servers = normalizeMcpServers({
    good_name: { type: "http", url: "https://example.com", allowTools: "a,b" },
    "bad name": { type: "stdio", command: "node" },
  });
  assert.ok(servers.good_name);
  assert.equal(servers.good_name.type, "http");
  assert.deepEqual(servers.good_name.allowTools, ["a", "b"]);
  assert.equal(servers["bad name"], undefined);
});

test("upsertMcpServerConfig and removeMcpServerConfig mutate server maps safely", () => {
  let servers = {};
  servers = upsertMcpServerConfig(servers, "docs", {
    type: "http",
    url: "https://docs.example.com/mcp",
  });
  assert.ok(servers.docs);
  assert.equal(servers.docs.url, "https://docs.example.com/mcp");

  servers = upsertMcpServerConfig(servers, "docs", { enabled: false });
  assert.equal(servers.docs.enabled, false);

  servers = removeMcpServerConfig(servers, "docs");
  assert.equal(servers.docs, undefined);
});

test("parseKeyValueEntries parses valid pairs and rejects invalid input", () => {
  const parsed = parseKeyValueEntries(["A=1", "B=hello"]);
  assert.deepEqual(parsed, { A: "1", B: "hello" });
  assert.throws(() => parseKeyValueEntries(["missing-equals"]), /Invalid KEY=VALUE entry/);
});

