import { executeFileToolCall, formatToolDefinitionsForPrompt } from "./file-tools.js";
import path from "node:path";
import { promises as fs } from "node:fs";
import { loadWorkspaceMemory } from "./workspace-memory.js";
import { DEFAULT_AGENT_STEPS } from "./max-steps.js";

const MAX_TOOL_RESULT_CHARS = 18_000;
const MAX_REPEAT_TOOL_CALLS = 3;
const MAX_FOLLOW_UP_QUESTIONS = 1;
const MIN_FOLLOW_UP_STEP = 3;
const MIN_FOLLOW_UP_TOOL_CALLS = 2;
const MAX_INVALID_FINAL_REPEATS = 4;
const MAX_REFUSAL_RECOVERY_ATTEMPTS = 2;

function safeJsonStringify(value) {
  return JSON.stringify(value, null, 2);
}

function truncateText(value, maxChars = MAX_TOOL_RESULT_CHARS) {
  if (!value || value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated]`;
}

function normalizeFinalDeltaText({ rawDeltaText, finalContent }) {
  if (typeof finalContent !== "string") return "";
  const parsedRaw = parseCandidateJson(rawDeltaText ?? "");
  const parsedDirective = parsedRaw ? coerceParsedDirective(parsedRaw) : null;
  if (parsedDirective?.type === "final" && typeof parsedDirective.content === "string") {
    return parsedDirective.content;
  }
  return finalContent;
}

async function defaultExecuteToolCall(call, { workspaceRoot, onCommandApproval }) {
  return executeFileToolCall(call, {
    workspaceRoot,
    confirmCommand:
      call?.name === "run_command" && typeof onCommandApproval === "function"
        ? onCommandApproval
        : undefined,
  });
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

function buildAgentBootstrapPrompt({ task, workspaceRoot, workspaceMemory, toolDescriptions }) {
  const resolvedToolDescriptions = toolDescriptions || formatToolDefinitionsForPrompt();
  return [
    "You are Meta Code Agent running in tool mode.",
    `Workspace root: ${workspaceRoot}`,
    "You can solve tasks by calling one tool at a time.",
    "",
    "Available tools:",
    resolvedToolDescriptions,
    "",
    ...(workspaceMemory?.text
      ? [
          `Workspace instructions loaded from: ${workspaceMemory.sources.join(", ")}`,
          "Follow these instructions unless they conflict with the user task or system rules.",
          workspaceMemory.text,
          "",
        ]
      : []),
    "Output format rules (strict):",
    '1) For a tool call, respond ONLY with JSON: {"type":"tool_call","name":"...","arguments":{...},"thought":"short status"}',
    '2) For the final user answer, respond ONLY with JSON: {"type":"final","content":"..."}',
    '3) Only when truly blocked and missing required user intent, you may ask ONE follow-up using JSON: {"type":"follow_up","question":"...","choices":["..."],"allow_freeform":true,"thought":"..."}',
    "4) Do not ask follow-up questions early. First make meaningful progress with tools.",
    "5) Do not include markdown unless it is inside the JSON string fields.",
    "6) Act autonomously: do not ask the user for permission to create/edit files unless the user explicitly asks you to ask.",
    "7) If the workspace is empty and the task asks to build/create from scratch, immediately create the needed files and folders.",
    "8) Use tools when needed to inspect or change files; do not invent file contents.",
    "9) run_command can be denied by the user; if denied, continue with non-command tools when possible.",
    "10) Keep thought short (max one sentence) and action-oriented.",
    "11) Prefer minimal file edits and stay inside workspace root.",
    "12) Use glob_files to find files by pattern (e.g. **/*.ts) instead of listing and filtering manually.",
    "13) When making surgical line edits, edit_file with exact oldText is preferred over rewriting the whole file.",
    "",
    `User task: ${task}`,
  ].join("\n");
}

function buildToolFeedbackPrompt({ call, outcome }) {
  const safeArguments = sanitizeToolArgumentsForFeedback(call?.name, call?.arguments ?? {});
  const safeOutcome = sanitizeToolOutcomeForFeedback(outcome);
  const summary = safeJsonStringify({
    tool: call.name,
    arguments: safeArguments,
    outcome: safeOutcome,
  });
  const extraGuidance = buildToolOutcomeGuidance({ call, outcome });
  return [
    "TOOL_RESULT",
    truncateText(summary),
    "",
    ...(extraGuidance ? [extraGuidance, ""] : []),
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
    '{"type":"follow_up","question":"<brief question>","choices":["<option>","<option>"],"allow_freeform":true}',
    "",
    "Previous invalid response:",
    truncateText(receivedText, 4000),
  ].join("\n");
}

function buildRepetitionPrompt(call) {
  return [
    "LOOP_DETECTED",
    `You repeated tool call "${call.name}" with the same arguments multiple times.`,
    "Do not ask the user to apply manual file fixes.",
    "Choose a different next action using a different tool call and continue autonomously.",
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

function buildFollowUpDeniedPrompt({
  reason,
  step,
  toolCallsExecuted,
  question,
  maxFollowUps = MAX_FOLLOW_UP_QUESTIONS,
}) {
  const reasonLine =
    reason === "already_asked"
      ? `A follow-up question was already used in this task. Do not ask more than ${maxFollowUps}.`
      : reason === "unavailable"
        ? "Follow-up questions are unavailable in this runtime. Continue autonomously."
        : `Do not ask a follow-up yet. Current progress: step=${step}, tool_calls=${toolCallsExecuted}.`;
  return [
    "FOLLOW_UP_DENIED",
    reasonLine,
    "Continue autonomously with tools and best assumptions.",
    "Only ask follow-up when genuinely blocked after meaningful progress.",
    "",
    `Rejected follow-up: ${truncateText(question || "(none)", 500)}`,
    'Respond ONLY with {"type":"tool_call",...} or {"type":"final",...}.',
  ].join("\n");
}

function buildFollowUpAnswerPrompt({ question, answer }) {
  if (!answer) {
    return [
      "FOLLOW_UP_SKIPPED",
      `Question asked: ${question}`,
      "The user skipped clarification.",
      "Proceed with the best reasonable assumptions and finish the task.",
      'Respond ONLY with {"type":"tool_call",...} or {"type":"final",...}.',
    ].join("\n");
  }

  return [
    "USER_CLARIFICATION",
    `Question asked: ${question}`,
    `User answer: ${answer}`,
    "Use this clarification and continue solving the task.",
    'Respond ONLY with {"type":"tool_call",...} or {"type":"final",...}.',
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
    "Do not hand work back to the user as manual code edits.",
    "Continue by using tools to complete remaining work before returning final.",
    'Respond ONLY with {"type":"tool_call",...} or {"type":"final",...}.',
    "",
    "Previous final response:",
    truncateText(previousFinal, 3000),
  ].join("\n");
}

function buildRefusalReseedPrompt({
  task,
  workspaceRoot,
  workspaceMemory,
  previousFinal,
  toolDescriptions,
}) {
  return [
    buildAgentBootstrapPrompt({ task, workspaceRoot, workspaceMemory, toolDescriptions }),
    "",
    "RECOVERY_RESEED",
    "A previous attempt returned an unhelpful refusal.",
    "Start a fresh pass from current workspace state and continue autonomously.",
    "Do not refuse and do not ask the user to perform manual file edits.",
    "",
    "Previous refusal:",
    truncateText(previousFinal, 1000),
  ].join("\n");
}

function buildProviderRefusalFallback() {
  return [
    "I started this task, but the model returned repeated refusal responses instead of actionable tool JSON.",
    "I stopped retrying to avoid a loop.",
    "Re-run the same prompt (or split it into smaller steps) and I’ll continue from the files already created.",
  ].join(" ");
}

function buildInvalidFinalLoopFallback() {
  return [
    "I made partial progress, but the model kept returning non-actionable final responses.",
    "I stopped to avoid a retry loop.",
    "Run the prompt again and I’ll continue from the current workspace state.",
  ].join(" ");
}

export async function runAgentWithFileTools({
  client,
  task,
  conversationId,
  currentBranchPath,
  mode,
  workspaceRoot,
  maxSteps = DEFAULT_AGENT_STEPS,
  onStatus,
  onThinking,
  onToolCall,
  onToolResult,
  onCommandApproval,
  onFollowUpQuestion,
  onDelta,
  toolDescriptions,
  executeToolCall = defaultExecuteToolCall,
}) {
  const workspaceMemory = await loadWorkspaceMemory(workspaceRoot);
  let nextConversationId = conversationId;
  let nextBranchPath = currentBranchPath;
  let nextMode = mode;
  let turnPrompt = buildAgentBootstrapPrompt({
    task,
    workspaceRoot,
    workspaceMemory,
    toolDescriptions,
  });
  let lastToolCallSignature = "";
  let repeatToolCallCount = 0;
  let toolCallsExecuted = 0;
  let toolErrors = 0;
  let followUpsAsked = 0;
  let lastInvalidFinalFingerprint = "";
  let invalidFinalRepeatCount = 0;
  let refusalRecoveryAttempts = 0;
  const touchedFiles = new Set();

  for (let step = 1; step <= maxSteps; step += 1) {
    onStatus?.(`step ${step}/${maxSteps}`);

    // Stream deltas to the caller only for the final answer step.
    // We capture deltas from every sendMessage call and forward them only
    // when the directive turns out to be "final".
    let pendingDeltas = "";
    const captureOnDelta = onDelta
      ? (delta) => {
          pendingDeltas += delta;
        }
      : undefined;

    const assistantResponse = await client.sendMessage({
      content: turnPrompt,
      conversationId: nextConversationId,
      currentBranchPath: nextBranchPath,
      mode: nextMode,
      onDelta: captureOnDelta,
    });

    nextConversationId = assistantResponse.conversationId;
    nextBranchPath = assistantResponse.currentBranchPath;
    nextMode = assistantResponse.mode;

    const directive = extractAgentDirective(assistantResponse.content);

    if (directive.type === "final") {
      // Forward only user-facing final text, not protocol wrapper JSON.
      if (onDelta) {
        onDelta(
          normalizeFinalDeltaText({
            rawDeltaText: pendingDeltas,
            finalContent: directive.content,
          }),
          { final: true }
        );
      }
      const finalCheck = await validateFinalResponse({
        task,
        content: directive.content,
        toolCallsExecuted,
        toolErrors,
        touchedFiles,
        workspaceRoot,
      });
      if (!finalCheck.ok) {
        const fingerprint = createFinalFingerprint(directive.content);
        if (fingerprint === lastInvalidFinalFingerprint) {
          invalidFinalRepeatCount += 1;
        } else {
          lastInvalidFinalFingerprint = fingerprint;
          invalidFinalRepeatCount = 1;
        }

        if (finalCheck.reason === "provider-refusal") {
          if (refusalRecoveryAttempts < MAX_REFUSAL_RECOVERY_ATTEMPTS) {
            refusalRecoveryAttempts += 1;
            onStatus?.("reseeding conversation");
            nextConversationId = undefined;
            nextBranchPath = undefined;
            turnPrompt = buildRefusalReseedPrompt({
              task,
              workspaceRoot,
              workspaceMemory,
              toolDescriptions,
              previousFinal: directive.content,
            });
            continue;
          }
          onStatus?.("stopping refusal loop");
          return {
            content: buildProviderRefusalFallback(),
            conversationId: nextConversationId,
            currentBranchPath: nextBranchPath,
            mode: nextMode,
            steps: step,
            touchedFiles: [...touchedFiles],
          };
        }

        if (invalidFinalRepeatCount >= MAX_INVALID_FINAL_REPEATS) {
          onStatus?.("stopping invalid loop");
          return {
            content: buildInvalidFinalLoopFallback(),
            conversationId: nextConversationId,
            currentBranchPath: nextBranchPath,
            mode: nextMode,
            steps: step,
            touchedFiles: [...touchedFiles],
          };
        }

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
        touchedFiles: [...touchedFiles],
      };
    }

    if (directive.type === "follow_up") {
      if (directive.thought) {
        onThinking?.(directive.thought);
      }
      if (
        !shouldAllowFollowUpRequest({
          step,
          toolCallsExecuted,
          followUpsAsked,
        })
      ) {
        onStatus?.("continuing without follow-up");
        turnPrompt = buildFollowUpDeniedPrompt({
          reason: followUpsAsked >= MAX_FOLLOW_UP_QUESTIONS ? "already_asked" : "too_early",
          step,
          toolCallsExecuted,
          question: directive.question,
        });
        continue;
      }

      if (typeof onFollowUpQuestion !== "function") {
        onStatus?.("continuing without follow-up");
        turnPrompt = buildFollowUpDeniedPrompt({
          reason: "unavailable",
          step,
          toolCallsExecuted,
          question: directive.question,
        });
        continue;
      }

      onStatus?.("awaiting user follow-up");
      const answer = await onFollowUpQuestion({
        question: directive.question,
        choices: directive.choices,
        allowFreeform: directive.allowFreeform,
      });
      followUpsAsked += 1;
      turnPrompt = buildFollowUpAnswerPrompt({
        question: directive.question,
        answer: typeof answer === "string" ? answer.trim() : "",
      });
      continue;
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
    await onToolCall?.(directive);
    const toolOutcome = await executeToolCall(directive, {
      workspaceRoot,
      onCommandApproval,
    });
    toolCallsExecuted += 1;
    if (toolOutcome.ok) {
      collectTouchedFiles(touchedFiles, directive, toolOutcome);
    } else {
      toolErrors += 1;
    }
    lastInvalidFinalFingerprint = "";
    invalidFinalRepeatCount = 0;
    onToolResult?.(toolOutcome);
    turnPrompt = buildToolFeedbackPrompt({
      call: directive,
      outcome: toolOutcome,
    });
  }

  onStatus?.("finalizing");
  let forceFinalDeltas = "";
  const forceFinalOnDelta = onDelta ? (delta) => { forceFinalDeltas += delta; } : undefined;
  const finalAttempt = await client.sendMessage({
    content: buildForceFinalizePrompt(),
    conversationId: nextConversationId,
    currentBranchPath: nextBranchPath,
    mode: nextMode,
    onDelta: forceFinalOnDelta,
  });
  const finalDirective = extractAgentDirective(finalAttempt.content);
  if (finalDirective.type === "final") {
    if (onDelta) {
      onDelta(
        normalizeFinalDeltaText({
          rawDeltaText: forceFinalDeltas,
          finalContent: finalDirective.content,
        }),
        { final: true }
      );
    }
    return {
      content: finalDirective.content,
      conversationId: finalAttempt.conversationId,
      currentBranchPath: finalAttempt.currentBranchPath,
      mode: finalAttempt.mode,
      steps: maxSteps + 1,
      touchedFiles: [...touchedFiles],
    };
  }

  return {
    content:
      "I made partial progress but couldn’t complete cleanly in one pass. Re-run the prompt and I’ll continue from the current files.",
    conversationId: finalAttempt.conversationId,
    currentBranchPath: finalAttempt.currentBranchPath,
    mode: finalAttempt.mode,
    steps: maxSteps + 1,
    touchedFiles: [...touchedFiles],
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

function looksLikeManualHandoff(text) {
  return /(here are (the )?exact fixes you need to make|replace .* with|you need to (fix|edit|change)|make (these|the) changes yourself|apply these (edits|changes))/i.test(
    text || ""
  );
}

function looksLikeProviderRefusal(text) {
  return /(sorry[, ]+i can[’']?t help you with this request right now|sorry[, ]+i cannot help with this request right now|i can[’']?t help you with this request right now|i cannot help with this request right now)/i.test(
    text || ""
  );
}

function buildToolOutcomeGuidance({ call, outcome }) {
  if (outcome?.ok !== false) return "";
  if (call?.name === "edit_file" && /oldText was not found/i.test(String(outcome.error || ""))) {
    return [
      "RECOVERY_HINT",
      "The previous edit_file failed because oldText did not match current file content.",
      "Do not repeat the same edit_file arguments.",
      "Read the file first, then use exact oldText or write_file with the full corrected file.",
    ].join("\n");
  }
  return [
    "RECOVERY_HINT",
    "The tool call failed. Do not repeat identical arguments.",
    "Try a different tool call to inspect current state and continue autonomously.",
  ].join("\n");
}

function sanitizeToolArgumentsForFeedback(toolName, args) {
  if (!args || typeof args !== "object") return args;
  const next = { ...args };

  if ((toolName === "write_file" || toolName === "append_file") && typeof next.content === "string") {
    next.content = `[omitted ${next.content.length} chars]`;
  }

  if (toolName === "edit_file") {
    if (typeof next.oldText === "string") next.oldText = truncateForFeedback(next.oldText, 200);
    if (typeof next.newText === "string") next.newText = truncateForFeedback(next.newText, 200);
  }

  return clampFeedbackValue(next);
}

function sanitizeToolOutcomeForFeedback(outcome) {
  if (!outcome || typeof outcome !== "object") return outcome;
  return clampFeedbackValue(outcome);
}

function clampFeedbackValue(value, depth = 0) {
  if (depth > 5) return "[max-depth]";
  if (typeof value === "string") return truncateForFeedback(value, 1200);
  if (Array.isArray(value)) {
    const limited = value.slice(0, 50).map((entry) => clampFeedbackValue(entry, depth + 1));
    if (value.length > 50) {
      limited.push(`[truncated ${value.length - 50} more items]`);
    }
    return limited;
  }
  if (!value || typeof value !== "object") return value;

  const next = {};
  for (const [key, nested] of Object.entries(value)) {
    next[key] = clampFeedbackValue(nested, depth + 1);
  }
  return next;
}

function truncateForFeedback(text, maxChars) {
  if (typeof text !== "string") return text;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...[truncated]`;
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

  const followUpDirective = extractFollowUpDirective(parsed);
  if (followUpDirective) {
    return followUpDirective;
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

function extractFollowUpDirective(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.ask_user && typeof parsed.ask_user === "object") {
    const nested = extractFollowUpDirective({
      ...parsed.ask_user,
      type: parsed.ask_user.type ?? "follow_up",
      thought:
        typeof parsed.ask_user.thought === "string" ? parsed.ask_user.thought : parsed.thought,
    });
    if (nested) return nested;
  }

  const type = String(parsed.type || "").trim().toLowerCase();
  if (!["follow_up", "followup", "ask_user"].includes(type)) return null;

  const question =
    (typeof parsed.question === "string" && parsed.question.trim()) ||
    (typeof parsed.prompt === "string" && parsed.prompt.trim());
  if (!question) return null;

  return {
    type: "follow_up",
    question,
    choices: normalizeFollowUpChoices(parsed.choices ?? parsed.options ?? parsed.responses),
    allowFreeform:
      parsed.allow_freeform !== false &&
      parsed.allowFreeform !== false &&
      parsed.allowCustom !== false,
    thought: typeof parsed.thought === "string" ? parsed.thought.trim() : "",
  };
}

function normalizeFollowUpChoices(rawChoices) {
  if (!Array.isArray(rawChoices)) return [];
  return rawChoices
    .map((choice) => String(choice ?? "").trim())
    .filter(Boolean)
    .slice(0, 8);
}

function shouldAllowFollowUpRequest({ step, toolCallsExecuted, followUpsAsked }) {
  if (followUpsAsked >= MAX_FOLLOW_UP_QUESTIONS) return false;
  if (step < MIN_FOLLOW_UP_STEP) return false;
  if (toolCallsExecuted < MIN_FOLLOW_UP_TOOL_CALLS) return false;
  return true;
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
  toolErrors,
  touchedFiles,
  workspaceRoot,
}) {
  if (looksLikeProviderRefusal(content)) {
    return { ok: false, reason: "provider-refusal", missingFiles: [] };
  }

  if (looksIncompleteFinal(content)) {
    return { ok: false, reason: "incomplete-language", missingFiles: [] };
  }

  if (toolErrors > 0 && looksLikeManualHandoff(content)) {
    return { ok: false, reason: "manual-handoff", missingFiles: [] };
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
    if (isKnownNonFileToken(candidate)) continue;
    files.add(candidate);
  }
  return [...files];
}

function isKnownNonFileToken(token) {
  const normalized = String(token || "").trim().toLowerCase();
  if (!normalized) return false;
  return /^(node|react|next|vue|nuxt|express|angular|svelte|remix|gatsby|nestjs)\.js$/i.test(
    normalized
  );
}

function createFinalFingerprint(content) {
  return String(content || "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 240);
}

function isInsideRoot(absolutePath, workspaceRoot) {
  const normalizedRoot = path.resolve(workspaceRoot);
  const normalized = path.resolve(absolutePath);
  return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}${path.sep}`);
}
