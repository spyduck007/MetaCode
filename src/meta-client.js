import { randomUUID } from "node:crypto";
import {
  DEFAULT_MODE,
  DELETE_CONVERSATION_DOC_ID,
  GRAPHQL_URL,
  SEND_MESSAGE_DOC_ID,
  SUPPORTED_MODES,
} from "./constants.js";
import { parseSseStream } from "./sse.js";

const NETWORK_RETRY_ATTEMPTS = 2;
const NETWORK_RETRY_DELAY_MS = 1500;
const SSE_IDLE_TIMEOUT_MS = 60_000; // 60 s of no new events = assume dead stream

function isRetryableError(error) {
  if (!error) return false;
  const msg = String(error.message ?? "").toLowerCase();
  // Retry on network/connection errors but not on auth failures or client errors
  return (
    error.code === "ECONNRESET" ||
    error.code === "ECONNREFUSED" ||
    error.code === "ETIMEDOUT" ||
    error.code === "ENOTFOUND" ||
    error.code === "SSE_TIMEOUT" ||
    msg.includes("fetch failed") ||
    msg.includes("network error") ||
    msg.includes("econnreset") ||
    msg.includes("socket hang up") ||
    msg.includes("connection refused") ||
    msg.includes("sse stream timed out")
  );
}

function isRetryableStatus(status) {
  // Retry on server errors (5xx) but not on client errors (4xx)
  return status >= 500 && status < 600;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toUniqueMessageId() {
  return `${Date.now()}${Math.floor(Math.random() * 900 + 100)}`;
}

/**
 * Wraps a ReadableStream with an idle timeout. Each read() call must complete
 * within `timeoutMs` milliseconds; otherwise the stream is cancelled and an
 * SSE_TIMEOUT error is thrown, allowing the retry loop to attempt again.
 *
 * @param {ReadableStream} body
 * @param {number} timeoutMs
 * @returns {ReadableStream}
 */
function wrapStreamWithIdleTimeout(body, timeoutMs) {
  const reader = body.getReader();
  return new ReadableStream({
    async pull(controller) {
      let timer;
      const timeoutPromise = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          const err = new Error(
            `SSE stream timed out: no data for ${timeoutMs}ms`
          );
          err.code = "SSE_TIMEOUT";
          reject(err);
        }, timeoutMs);
      });
      try {
        const { done, value } = await Promise.race([reader.read(), timeoutPromise]);
        clearTimeout(timer);
        if (done) {
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (err) {
        clearTimeout(timer);
        reader.cancel(err).catch(() => {});
        controller.error(err);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
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
  constructor({ cookie, retryDelayMs, sseTimeoutMs } = {}) {
    if (!cookie) {
      throw new Error("Cookie is required for authenticated Meta AI requests.");
    }
    this.cookie = cookie;
    this._retryDelayMs = typeof retryDelayMs === "number" ? retryDelayMs : NETWORK_RETRY_DELAY_MS;
    this._sseTimeoutMs = typeof sseTimeoutMs === "number" ? sseTimeoutMs : SSE_IDLE_TIMEOUT_MS;
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

    let lastError;
    for (let attempt = 0; attempt <= NETWORK_RETRY_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        await sleep(this._retryDelayMs * attempt);
      }
      try {
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
          let message;
          if (response.status === 401 || response.status === 403) {
            message = `Authentication failed (${response.status}): Your session cookie has expired or is invalid. Run \`meta-code auth login\` or \`meta-code auth set-cookie <cookie>\` to re-authenticate.`;
          } else if (response.status === 429) {
            message = `Rate limited (429): You are sending requests too fast. Please wait a moment and try again.`;
          } else {
            message = `Meta API request failed: ${response.status} ${errorBody}`;
          }
          const err = new Error(message);
          err.status = response.status;
          if (isRetryableStatus(response.status) && attempt < NETWORK_RETRY_ATTEMPTS) {
            lastError = err;
            continue;
          }
          throw err;
        }

        if (!response.body) {
          throw new Error("Meta API response had no stream body.");
        }

        let assistantText = "";
        let resultConversationId = conversationId;
        let resultBranchPath = currentBranchPath;
        let resultConversationType = normalizedMode;

        // Wrap the response body in a timeout-aware stream so a dead/stalled stream
        // doesn't hang indefinitely. Each chunk must arrive within sseTimeoutMs.
        const timeoutBody = wrapStreamWithIdleTimeout(response.body, this._sseTimeoutMs);

        for await (const event of parseSseStream(timeoutBody)) {
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
      } catch (error) {
        if (isRetryableError(error) && attempt < NETWORK_RETRY_ATTEMPTS) {
          lastError = error;
          continue;
        }
        throw error;
      }
    }
    throw lastError;
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
