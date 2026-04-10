import path from "node:path";
import { promises as fs } from "node:fs";

/**
 * Format a messages array into a markdown document.
 * @param {Array<{role: string, text: string}>} messages
 * @param {object} opts
 * @param {string} [opts.sessionName]
 * @param {string} [opts.mode]
 * @returns {string}
 */
export function formatConversationAsMarkdown(messages, { sessionName = "", mode = "" } = {}) {
  const timestamp = new Date().toISOString();
  const lines = ["# Meta Code — Conversation Export", ""];
  if (sessionName) lines.push(`**Session:** ${sessionName}`);
  if (mode) lines.push(`**Mode:** ${mode}`);
  lines.push(`**Exported:** ${timestamp}`);
  lines.push("", "---", "");

  const conversationMessages = messages.filter(
    (m) => m.role === "user" || m.role === "assistant" || m.role === "error"
  );

  if (conversationMessages.length === 0) {
    lines.push("*No conversation messages to export.*");
    return lines.join("\n");
  }

  for (const message of conversationMessages) {
    if (message.role === "user") {
      lines.push(`## You`, "", message.text, "");
    } else if (message.role === "assistant") {
      lines.push(`## Assistant`, "", message.text, "");
    } else if (message.role === "error") {
      lines.push(`## Error`, "", `> ${message.text}`, "");
    }
    lines.push("---", "");
  }

  return lines.join("\n");
}

/**
 * Export a conversation to a file. Returns the resolved file path.
 * @param {Array<{role: string, text: string}>} messages
 * @param {object} opts
 * @param {string} [opts.filename]      Custom file name (may include path)
 * @param {string} [opts.outputDir]     Directory to write to (default: cwd)
 * @param {string} [opts.sessionName]
 * @param {string} [opts.mode]
 * @returns {Promise<{filePath: string, bytes: number, messageCount: number}>}
 */
export async function exportConversationToFile(messages, {
  filename,
  outputDir,
  sessionName = "",
  mode = "",
} = {}) {
  const dir = path.resolve(outputDir || process.cwd());
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").replace(/\..+$/, "");
  const resolvedFilename = filename?.trim() || `metacode-export-${stamp}.md`;
  const filePath = path.isAbsolute(resolvedFilename)
    ? resolvedFilename
    : path.join(dir, resolvedFilename);

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const content = formatConversationAsMarkdown(messages, { sessionName, mode });
  await fs.writeFile(filePath, content, "utf8");
  return {
    filePath,
    bytes: Buffer.byteLength(content, "utf8"),
    messageCount: messages.filter((m) => m.role === "user" || m.role === "assistant").length,
  };
}
