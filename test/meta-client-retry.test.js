import test from "node:test";
import assert from "node:assert/strict";
import { MetaAIClient, normalizeMode } from "../src/meta-client.js";

// ──────────────────────────────────────────────────────────────────────────────
// normalizeMode already tested in meta-client.test.js but we extend here
// ──────────────────────────────────────────────────────────────────────────────

test("normalizeMode accepts fast shorthand", () => {
  assert.equal(normalizeMode("fast"), "think_fast");
});

test("normalizeMode accepts hard shorthand", () => {
  assert.equal(normalizeMode("hard"), "think_hard");
});

test("normalizeMode returns default for falsy input", () => {
  assert.equal(normalizeMode(null), "think_fast");
  assert.equal(normalizeMode(""), "think_fast");
  assert.equal(normalizeMode(undefined), "think_fast");
});

test("normalizeMode throws for unknown mode", () => {
  assert.throws(() => normalizeMode("turbo"), /Unsupported mode/);
});

// ──────────────────────────────────────────────────────────────────────────────
// sendMessage retry behaviour via mocked fetch
// ──────────────────────────────────────────────────────────────────────────────

function mockSseBody(text) {
  const encoder = new TextEncoder();
  const data = `event: next\ndata: ${JSON.stringify({ data: { sendMessageStream: { __typename: "AssistantMessage", content: text } } })}\n\nevent: complete\ndata: {}\n\n`;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(data));
      controller.close();
    },
  });
  return stream;
}

test("MetaAIClient.sendMessage retries on retryable 503 error then succeeds", async () => {
  const client = new MetaAIClient({ cookie: "test=cookie", retryDelayMs: 0 });
  let callCount = 0;

  // Temporarily replace global fetch
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    callCount += 1;
    if (callCount < 2) {
      return {
        ok: false,
        status: 503,
        text: async () => "Service Unavailable",
        body: null,
      };
    }
    return {
      ok: true,
      status: 200,
      body: mockSseBody("hello from retry"),
    };
  };

  try {
    const result = await client.sendMessage({ content: "hello" });
    assert.equal(result.content, "hello from retry");
    assert.equal(callCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MetaAIClient.sendMessage does not retry on 401 auth error", async () => {
  const client = new MetaAIClient({ cookie: "test=cookie", retryDelayMs: 0 });
  let callCount = 0;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    callCount += 1;
    return {
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
      body: null,
    };
  };

  try {
    await assert.rejects(
      () => client.sendMessage({ content: "hello" }),
      /Authentication failed \(401\)/
    );
    assert.equal(callCount, 1, "Should not retry on 401");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MetaAIClient.sendMessage retries on network ECONNRESET then succeeds", async () => {
  const client = new MetaAIClient({ cookie: "test=cookie", retryDelayMs: 0 });
  let callCount = 0;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    callCount += 1;
    if (callCount < 2) {
      const err = new Error("socket hang up");
      err.code = "ECONNRESET";
      throw err;
    }
    return {
      ok: true,
      status: 200,
      body: mockSseBody("retry success"),
    };
  };

  try {
    const result = await client.sendMessage({ content: "hello" });
    assert.equal(result.content, "retry success");
    assert.equal(callCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MetaAIClient.sendMessage throws after exhausting all retries", async () => {
  const client = new MetaAIClient({ cookie: "test=cookie", retryDelayMs: 0 });
  let callCount = 0;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    callCount += 1;
    return {
      ok: false,
      status: 503,
      text: async () => "always down",
      body: null,
    };
  };

  try {
    await assert.rejects(
      () => client.sendMessage({ content: "hello" }),
      /Meta API request failed: 503/
    );
    // 1 initial + 2 retries = 3
    assert.equal(callCount, 3, "Should attempt 3 times total");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MetaAIClient.sendMessage rejects empty content without any fetch call", async () => {
  const client = new MetaAIClient({ cookie: "test=cookie", retryDelayMs: 0 });
  await assert.rejects(
    () => client.sendMessage({ content: "" }),
    /Message content cannot be empty/
  );
});

test("MetaAIClient constructor requires cookie", () => {
  assert.throws(() => new MetaAIClient({}), /Cookie is required/);
  assert.throws(() => new MetaAIClient({ cookie: "" }), /Cookie is required/);
});

test("MetaAIClient.sendMessage retries on SSE_TIMEOUT and succeeds", async () => {
  const client = new MetaAIClient({ cookie: "test=cookie", retryDelayMs: 0, sseTimeoutMs: 50 });
  let callCount = 0;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    callCount += 1;
    if (callCount === 1) {
      // Return a body that never emits any bytes (simulates dead/stalled SSE stream)
      const { ReadableStream } = await import("node:stream/web");
      const body = new ReadableStream({
        start() {
          // Never call controller.enqueue() or controller.close() -> stream stalls
        },
      });
      return { ok: true, status: 200, body };
    }
    // Second call: succeed immediately with a complete event then an assistant message
    const { ReadableStream } = await import("node:stream/web");
    const sseText =
      'event: next\ndata: {"data":{"sendMessageStream":{"__typename":"AssistantMessage","content":"Hello!"}}}\n\n' +
      'event: complete\ndata: {}\n\n';
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseText));
        controller.close();
      },
    });
    return { ok: true, status: 200, body };
  };

  try {
    const result = await client.sendMessage({ content: "hi" });
    assert.equal(result.content, "Hello!");
    assert.equal(callCount, 2, "Should retry once after timeout");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MetaAIClient respects sseTimeoutMs constructor option", () => {
  const client = new MetaAIClient({ cookie: "test=cookie", sseTimeoutMs: 5000 });
  assert.equal(client._sseTimeoutMs, 5000);
});

test("MetaAIClient uses default sseTimeoutMs when not specified", () => {
  const client = new MetaAIClient({ cookie: "test=cookie" });
  assert.equal(typeof client._sseTimeoutMs, "number");
  assert.ok(client._sseTimeoutMs > 0);
});
