import test from "node:test";
import assert from "node:assert/strict";
import { DELETE_CONVERSATION_DOC_ID } from "../src/constants.js";
import { buildDeleteConversationPayload, MetaAIClient } from "../src/meta-client.js";

test("buildDeleteConversationPayload uses delete doc id", () => {
  const payload = buildDeleteConversationPayload({ conversationId: "conv-123" });
  assert.equal(payload.doc_id, DELETE_CONVERSATION_DOC_ID);
  assert.deepEqual(payload.variables, { input: { id: "conv-123" } });
});

test("deleteConversation returns success for deleted response", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let requestBody = null;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        data: { deleteConversation: { __typename: "ConversationDeleted", success: true } },
      }),
    };
  };

  const client = new MetaAIClient({ cookie: "ecto_1_sess=test" });
  const result = await client.deleteConversation({ conversationId: "conv-abc" });
  assert.equal(requestBody.doc_id, DELETE_CONVERSATION_DOC_ID);
  assert.deepEqual(requestBody.variables, { input: { id: "conv-abc" } });
  assert.equal(result.success, true);
  assert.equal(result.reason, "deleted");
});

test("deleteConversation treats not found as non-fatal", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      data: { deleteConversation: { __typename: "ConversationNotFound", success: false } },
    }),
  });

  const client = new MetaAIClient({ cookie: "ecto_1_sess=test" });
  const result = await client.deleteConversation({ conversationId: "conv-missing" });
  assert.equal(result.success, false);
  assert.equal(result.reason, "not_found");
});

test("deleteConversation treats GqlError not found as non-fatal", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      data: {
        deleteConversation: {
          __typename: "GqlError",
          message: "Conversation not found or you don't have permission to delete it",
        },
      },
    }),
  });

  const client = new MetaAIClient({ cookie: "ecto_1_sess=test" });
  const result = await client.deleteConversation({ conversationId: "conv-missing" });
  assert.equal(result.success, false);
  assert.equal(result.reason, "not_found");
});

test("deleteConversation throws on GraphQL errors", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      errors: [{ message: "unauthorized" }],
    }),
  });

  const client = new MetaAIClient({ cookie: "ecto_1_sess=test" });
  await assert.rejects(
    () => client.deleteConversation({ conversationId: "conv-1" }),
    /unauthorized/
  );
});
