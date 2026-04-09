import { randomUUID } from "node:crypto";
import {
  DEFAULT_MODE,
  DELETE_CONVERSATION_DOC_ID,
  GRAPHQL_URL,
  SEND_MESSAGE_DOC_ID,
  SUPPORTED_MODES,
} from "./constants.js";
import { parseSseStream } from "./sse.js";

function toUniqueMessageId() {
  return `${Date.now()}${Math.floor(Math.random() * 900 + 100)}`;
}

export function normalizeMode(value) {
  if (!value) return DEFAULT_MODE;
  const normalized = value.toLowerCase().trim();
  if (normalized === "fast") return "think_fast";
  if (normalized === "hard") return "think_hard";
  if (SUPPORTED_MODES.includes(normalized)) return normalized;
  throw new Error(`Unsupported mode "${value}". Use think_fast or think_hard.`);
}

export function buildSendPayload({ content, conversationId, currentBranchPath, mode }) {
  return {
    doc_id: SEND_MESSAGE_DOC_ID,
    variables: {
      conversationId,
      content,
      userMessageId: randomUUID(),
      assistantMessageId: randomUUID(),
      userUniqueMessageId: toUniqueMessageId(),
      turnId: randomUUID(),
      currentBranchPath,
      promptEditType: "new_message",
      attachments: null,
      mode,
    },
  };
}

export function buildDeleteConversationPayload({ conversationId }) {
  return {
    doc_id: DELETE_CONVERSATION_DOC_ID,
    variables: {
      input: {
        id: conversationId,
      },
    },
  };
}

export class MetaAIClient {
  constructor({ cookie }) {
    if (!cookie) {
      throw new Error("Cookie is required for authenticated Meta AI requests.");
    }
    this.cookie = cookie;
  }

  async sendMessage({
    content,
    conversationId = randomUUID(),
    currentBranchPath = "0",
    mode = DEFAULT_MODE,
    onDelta,
    onEvent,
  }) {
    if (!content?.trim()) {
      throw new Error("Message content cannot be empty.");
    }

    const normalizedMode = normalizeMode(mode);
    const payload = buildSendPayload({
      content,
      conversationId,
      currentBranchPath,
      mode: normalizedMode,
    });

    const response = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: {
        accept: "text/event-stream",
        "content-type": "application/json",
        origin: "https://www.meta.ai",
        referer: "https://www.meta.ai/",
        cookie: this.cookie,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Meta API request failed: ${response.status} ${errorBody}`);
    }

    if (!response.body) {
      throw new Error("Meta API response had no stream body.");
    }

    let assistantText = "";
    let resultConversationId = conversationId;
    let resultBranchPath = currentBranchPath;
    let resultConversationType = normalizedMode;

    for await (const event of parseSseStream(response.body)) {
      onEvent?.(event);
      if (event.event === "complete") break;
      if (event.event !== "next" || !event.data) continue;

      let parsed;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        continue;
      }

      const streamNode = parsed?.data?.sendMessageStream;
      if (!streamNode) continue;

      if (streamNode.__typename === "AssistantMessage") {
        const nextText = streamNode.content ?? "";
        const delta = nextText.startsWith(assistantText) ? nextText.slice(assistantText.length) : nextText;
        if (delta) onDelta?.(delta, streamNode);
        assistantText = nextText;
        if (streamNode.conversationId) resultConversationId = streamNode.conversationId;
        if (streamNode.branchPath) resultBranchPath = streamNode.branchPath;
      } else if (streamNode.__typename === "Conversation") {
        if (streamNode.id) resultConversationId = streamNode.id;
        if (streamNode.type) resultConversationType = streamNode.type.toLowerCase();
      }
    }

    return {
      content: assistantText,
      conversationId: resultConversationId,
      currentBranchPath: resultBranchPath,
      mode: resultConversationType,
    };
  }

  async deleteConversation({ conversationId }) {
    const normalizedConversationId = conversationId?.trim();
    if (!normalizedConversationId) {
      throw new Error("Conversation id is required to delete a chat.");
    }

    const payload = buildDeleteConversationPayload({
      conversationId: normalizedConversationId,
    });

    const response = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: {
        accept: "multipart/mixed, application/json",
        "content-type": "application/json",
        origin: "https://www.meta.ai",
        referer: "https://www.meta.ai/",
        cookie: this.cookie,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Meta delete request failed: ${response.status} ${errorBody}`);
    }

    const body = await response.json();
    if (Array.isArray(body?.errors) && body.errors.length > 0) {
      const messages = body.errors
        .map((entry) => entry?.message)
        .filter(Boolean)
        .join(" | ");
      throw new Error(messages || "Meta delete request returned GraphQL errors.");
    }

    const deleted = body?.data?.deleteConversation;
    if (!deleted) {
      throw new Error("Meta delete request returned an unexpected response shape.");
    }

    if (deleted.success === true) {
      return { success: true, reason: "deleted", typename: deleted.__typename };
    }

    const typename = String(deleted.__typename ?? "");
    const message = String(deleted.message ?? "");
    if (typename === "GqlError" && /not found/i.test(message)) {
      return { success: false, reason: "not_found", typename, message };
    }
    if (/not.?found/i.test(typename)) {
      return { success: false, reason: "not_found", typename };
    }

    const detail = message ? `${typename || "unknown"}: ${message}` : typename || "unknown";
    throw new Error(`Meta delete request was not successful (${detail}).`);
  }
}
