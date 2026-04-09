import { executeFileToolCall, formatToolDefinitionsForPrompt } from "./file-tools.js";
import path from "node:path";
import { promises as fs } from "node:fs";

const MAX_STEPS_DEFAULT = 24;
const MAX_TOOL_RESULT_CHARS = 18_000;
const MAX_REPEAT_TOOL_CALLS = 3;

function safeJsonStringify(value) {
  return JSON.stringify(value, null, 2);
}

function truncateText(value, maxChars = MAX_TOOL_RESULT_CHARS) {
  if (!value || value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated]`;
}

export function extractAgentDirective(responseText) {
  const text = responseText?.trim() ?? "";
  if (!text) {
    throw new Error("Assistant returned empty response.");
  }

  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  const candidates = [];

  for (const match of text.matchAll(fenceRegex)) {
    if (match[1]) candidates.push(match[1].trim());
  }
  candidates.push(text);

  for (const candidate of candidates) {
    const parsed = parseCandidateJson(candidate);
    if (parsed) {
      const directive = coerceParsedDirective(parsed);
      if (directive) return directive;
    }
  }

  return { type: "final", content: text };
}

function buildAgentBootstrapPrompt({ task, workspaceRoot }) {
  const toolDescriptions = formatToolDefinitionsForPrompt();
  return [
    "You are Meta Code Agent running in tool mode.",
    `Workspace root: ${workspaceRoot}`,
    "You can solve tasks by calling one file tool at a time.",
    "",
    "Available tools:",
    toolDescriptions,
    "",
    "Output format rules (strict):",
    '1) For a tool call, respond ONLY with JSON: {"type":"tool_call","name":"...","arguments":{...},"thought":"short status"}',
    '2) For the final user answer, respond ONLY with JSON: {"type":"final","content":"..."}',
    "3) Do not include markdown unless it is inside the JSON string fields.",
    "4) Act autonomously: do not ask the user for permission to create/edit files unless the user explicitly asks you to ask.",
    "5) If the workspace is empty and the task asks to build/create from scratch, immediately create the needed files and folders.",
    "6) Use tools when needed to inspect or change files; do not invent file contents.",
    "7) run_command can be denied by the user; if denied, continue with non-command tools when possible.",
    "8) Keep thought short (max one sentence) and action-oriented.",
    "9) Prefer minimal file edits and stay inside workspace root.",
    "",
    `User task: ${task}`,
  ].join("\n");
}

function buildToolFeedbackPrompt({ call, outcome }) {
  const summary = safeJsonStringify({
    tool: call.name,
    arguments: call.arguments ?? {},
    outcome,
  });
  return [
    "TOOL_RESULT",
    truncateText(summary),
    "",
    "Continue solving the user task.",
    "Respond with either next tool_call JSON or final JSON.",
  ].join("\n");
}

function buildFormatRepairPrompt(receivedText) {
  return [
    "FORMAT_ERROR",
    "Your previous message did not follow the required JSON response schema.",
    "Respond again using ONLY one JSON object in one of these forms:",
    '{"type":"tool_call","name":"<tool_name>","arguments":{...}}',
    '{"type":"final","content":"<final answer>"}',
    "",
    "Previous invalid response:",
    truncateText(receivedText, 4000),
  ].join("\n");
}

function buildRepetitionPrompt(call) {
  return [
    "LOOP_DETECTED",
    `You repeated tool call "${call.name}" with the same arguments multiple times.`,
    "Choose a different next action using a different tool call, or return final if done.",
    'Respond ONLY with {"type":"tool_call",...} or {"type":"final",...}.',
  ].join("\n");
}

function buildForceFinalizePrompt() {
  return [
    "FORCE_FINALIZE",
    "Now return your best possible final answer immediately.",
    'Respond ONLY with JSON: {"type":"final","content":"..."}',
    "Do not call additional tools in this response.",
  ].join("\n");
}

function buildAutonomyNudgePrompt(previousFinal) {
  return [
    "AUTONOMOUS_EXECUTION_REQUIRED",
    "Do not ask the user for confirmation in this task.",
    "Proceed by creating/editing files directly and continue toward completion.",
    "Call a file tool next.",
    'Respond ONLY with JSON: {"type":"tool_call","name":"...","arguments":{...},"thought":"..."}',
    "",
    "Previous response:",
    truncateText(previousFinal, 2500),
  ].join("\n");
}

function buildContinueExecutionPrompt({ previousFinal, missingFiles = [] }) {
  const missingLine =
    missingFiles.length > 0
      ? `Missing required files: ${missingFiles.join(", ")}`
      : "Work appears incomplete for the requested task.";
  return [
    "CONTINUE_EXECUTION",
    "Your previous final response ended too early.",
    missingLine,
    "Continue by using tools to complete remaining work before returning final.",
    'Respond ONLY with {"type":"tool_call",...} or {"type":"final",...}.',
    "",
    "Previous final response:",
    truncateText(previousFinal, 3000),
  ].join("\n");
}

export async function runAgentWithFileTools({
  client,
  task,
  conversationId,
  currentBranchPath,
  mode,
  workspaceRoot,
  maxSteps = MAX_STEPS_DEFAULT,
  onStatus,
  onThinking,
  onToolCall,
  onToolResult,
  onCommandApproval,
}) {
  let nextConversationId = conversationId;
  let nextBranchPath = currentBranchPath;
  let nextMode = mode;
  let turnPrompt = buildAgentBootstrapPrompt({ task, workspaceRoot });
  let lastToolCallSignature = "";
  let repeatToolCallCount = 0;
  let toolCallsExecuted = 0;
  const touchedFiles = new Set();

  for (let step = 1; step <= maxSteps; step += 1) {
    onStatus?.(`step ${step}/${maxSteps}`);
    const assistantResponse = await client.sendMessage({
      content: turnPrompt,
      conversationId: nextConversationId,
      currentBranchPath: nextBranchPath,
      mode: nextMode,
    });

    nextConversationId = assistantResponse.conversationId;
    nextBranchPath = assistantResponse.currentBranchPath;
    nextMode = assistantResponse.mode;

    const directive = extractAgentDirective(assistantResponse.content);

    if (directive.type === "final") {
      const finalCheck = await validateFinalResponse({
        task,
        content: directive.content,
        toolCallsExecuted,
        touchedFiles,
        workspaceRoot,
      });
      if (!finalCheck.ok) {
        onStatus?.("continuing execution");
        turnPrompt = buildContinueExecutionPrompt({
          previousFinal: directive.content,
          missingFiles: finalCheck.missingFiles,
        });
        continue;
      }

      if (
        toolCallsExecuted === 0 &&
        taskImpliesAutonomousCreation(task) &&
        looksLikePermissionQuestion(directive.content)
      ) {
        onStatus?.("autonomous execution");
        turnPrompt = buildAutonomyNudgePrompt(directive.content);
        continue;
      }
      return {
        content: directive.content,
        conversationId: nextConversationId,
        currentBranchPath: nextBranchPath,
        mode: nextMode,
        steps: step,
      };
    }

    if (directive.type !== "tool_call") {
      onStatus?.("format correction");
      turnPrompt = buildFormatRepairPrompt(assistantResponse.content);
      continue;
    }

    const callSignature = JSON.stringify({
      name: directive.name,
      arguments: directive.arguments ?? {},
    });
    if (callSignature === lastToolCallSignature) {
      repeatToolCallCount += 1;
    } else {
      lastToolCallSignature = callSignature;
      repeatToolCallCount = 1;
    }
    if (repeatToolCallCount >= MAX_REPEAT_TOOL_CALLS) {
      onStatus?.("unsticking loop");
      turnPrompt = buildRepetitionPrompt(directive);
      continue;
    }

    if (directive.thought) {
      onThinking?.(directive.thought);
    }
    onToolCall?.(directive);
    const toolOutcome = await executeFileToolCall(directive, {
      workspaceRoot,
      confirmCommand:
        directive.name === "run_command" && typeof onCommandApproval === "function"
          ? onCommandApproval
          : undefined,
    });
    toolCallsExecuted += 1;
    if (toolOutcome.ok) {
      collectTouchedFiles(touchedFiles, directive, toolOutcome);
    }
    onToolResult?.(toolOutcome);
    turnPrompt = buildToolFeedbackPrompt({
      call: directive,
      outcome: toolOutcome,
    });
  }

  onStatus?.("finalizing");
  const finalAttempt = await client.sendMessage({
    content: buildForceFinalizePrompt(),
    conversationId: nextConversationId,
    currentBranchPath: nextBranchPath,
    mode: nextMode,
  });
  const finalDirective = extractAgentDirective(finalAttempt.content);
  if (finalDirective.type === "final") {
    return {
      content: finalDirective.content,
      conversationId: finalAttempt.conversationId,
      currentBranchPath: finalAttempt.currentBranchPath,
      mode: finalAttempt.mode,
      steps: maxSteps + 1,
    };
  }

  return {
    content:
      "I made partial progress but couldn’t complete cleanly in one pass. Re-run the prompt and I’ll continue from the current files.",
    conversationId: finalAttempt.conversationId,
    currentBranchPath: finalAttempt.currentBranchPath,
    mode: finalAttempt.mode,
    steps: maxSteps + 1,
  };
}

function taskImpliesAutonomousCreation(task) {
  return /(from scratch|create|build|generate|scaffold|new project|full site)/i.test(task || "");
}

function looksLikePermissionQuestion(text) {
  return /(do you want|would you like|should i|let me know if you want|can you confirm|were you expecting)/i.test(
    text || ""
  );
}

function looksIncompleteFinal(text) {
  return /(let'?s\s+(create|add|build|start|do)|starting\s+(with|by)|next\s+(step|i('| )?ll|we('| )?ll)|we still need|remaining work|not done yet|i can continue)/i.test(
    text || ""
  );
}

function parseCandidateJson(candidate) {
  const queue = [String(candidate ?? "").trim()];
  const seen = new Set();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);

    const parsed = tryParseJsonCandidate(current);
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
    if (typeof parsed === "string" && parsed.trim()) {
      queue.push(parsed.trim());
    }

    const strippedLeadingSlash = current.replace(/^\\+/, "");
    if (strippedLeadingSlash !== current) {
      queue.push(strippedLeadingSlash);
    }

    const unescapedCommon = strippedLeadingSlash
      .replace(/\\"/g, '"')
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\r/g, "\r");
    if (unescapedCommon !== strippedLeadingSlash) {
      queue.push(unescapedCommon);
    }
  }

  return null;
}

function tryParseJsonCandidate(candidate) {
  try {
    return JSON.parse(candidate);
  } catch {
    // continue
  }

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  const slice = candidate.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

function coerceParsedDirective(parsed) {
  if (parsed?.type === "tool_call" && typeof parsed?.name === "string") {
    return {
      type: "tool_call",
      name: parsed.name,
      arguments: parsed.arguments ?? {},
      thought: typeof parsed.thought === "string" ? parsed.thought.trim() : "",
    };
  }

  if (typeof parsed?.name === "string" && parsed.arguments && typeof parsed.arguments === "object") {
    return {
      type: "tool_call",
      name: parsed.name,
      arguments: parsed.arguments,
      thought: typeof parsed.thought === "string" ? parsed.thought.trim() : "",
    };
  }

  const finalText = extractFinalTextFromParsed(parsed);
  if (parsed?.type === "final" && typeof finalText === "string") {
    return {
      type: "final",
      content: unwrapNestedFinalText(finalText),
    };
  }

  if (typeof finalText === "string") {
    const normalized = unwrapNestedFinalText(finalText);
    const nested = parseCandidateJson(normalized);
    if (nested) {
      const nestedDirective = coerceParsedDirective(nested);
      if (nestedDirective?.type === "final") {
        return nestedDirective;
      }
    }
    return {
      type: "final",
      content: normalized,
    };
  }

  return null;
}

function extractFinalTextFromParsed(parsed) {
  if (!parsed || typeof parsed !== "object") return null;

  const direct =
    (typeof parsed.content === "string" && parsed.content) ||
    (typeof parsed.value === "string" && parsed.value) ||
    (typeof parsed.text === "string" && parsed.text) ||
    (typeof parsed.response === "string" && parsed.response) ||
    (typeof parsed.message === "string" && parsed.message) ||
    (typeof parsed.answer === "string" && parsed.answer) ||
    (typeof parsed.output === "string" && parsed.output);

  if (direct) return direct;

  if (parsed.final && typeof parsed.final === "object") {
    const nested = extractFinalTextFromParsed(parsed.final);
    if (nested) return nested;
  }
  if (parsed.data && typeof parsed.data === "object") {
    const nested = extractFinalTextFromParsed(parsed.data);
    if (nested) return nested;
  }

  return null;
}

function unwrapNestedFinalText(value, depth = 0) {
  if (typeof value !== "string" || depth >= 4) return value;
  const trimmed = value.trim();
  const nested = parseCandidateJson(trimmed);
  if (!nested) return value;

  const nestedText = extractFinalTextFromParsed(nested);
  if (!nestedText || nestedText === value) return value;
  return unwrapNestedFinalText(nestedText, depth + 1);
}

function collectTouchedFiles(touchedFiles, directive, toolOutcome) {
  const args = directive.arguments ?? {};
  const result = toolOutcome.result ?? {};
  const writeLikeTools = new Set(["write_file", "append_file", "edit_file", "move_path", "mkdir"]);

  if (writeLikeTools.has(directive.name)) {
    if (typeof args.path === "string") touchedFiles.add(args.path);
    if (typeof result.path === "string") touchedFiles.add(result.path);
    if (typeof args.to === "string") touchedFiles.add(args.to);
  }
}

async function validateFinalResponse({
  task,
  content,
  toolCallsExecuted,
  touchedFiles,
  workspaceRoot,
}) {
  if (looksIncompleteFinal(content)) {
    return { ok: false, reason: "incomplete-language", missingFiles: [] };
  }

  const fileRequirements = await checkExplicitFiles(task, workspaceRoot);
  if (fileRequirements.missingFiles.length > 0) {
    return {
      ok: false,
      reason: "missing-explicit-files",
      missingFiles: fileRequirements.missingFiles,
    };
  }

  if (taskImpliesAutonomousCreation(task) && toolCallsExecuted > 0 && touchedFiles.size === 0) {
    return { ok: false, reason: "no-file-changes", missingFiles: [] };
  }

  return { ok: true, missingFiles: [] };
}

async function checkExplicitFiles(task, workspaceRoot) {
  const explicitFiles = extractExplicitFilesFromTask(task);
  if (explicitFiles.length === 0) {
    return { missingFiles: [] };
  }

  const missingFiles = [];
  for (const relativeFile of explicitFiles) {
    const absolute = path.resolve(workspaceRoot, relativeFile);
    if (!isInsideRoot(absolute, workspaceRoot)) continue;
    try {
      const stat = await fs.stat(absolute);
      if (!stat.isFile()) {
        missingFiles.push(relativeFile);
      }
    } catch {
      missingFiles.push(relativeFile);
    }
  }

  return { missingFiles };
}

function extractExplicitFilesFromTask(task) {
  const text = String(task || "");
  const pattern = /\b([A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,8})\b/g;
  const files = new Set();

  for (const match of text.matchAll(pattern)) {
    const candidate = match[1];
    if (!candidate) continue;
    if (candidate.includes("://")) continue;
    if (candidate.startsWith(".")) continue;
    files.add(candidate);
  }
  return [...files];
}

function isInsideRoot(absolutePath, workspaceRoot) {
  const normalizedRoot = path.resolve(workspaceRoot);
  const normalized = path.resolve(absolutePath);
  return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}${path.sep}`);
}
