export const DEFAULT_AGENT_STEPS = 24;
export const MIN_AGENT_STEPS = 4;
export const MAX_AGENT_STEPS = 80;

export function normalizeAgentSteps(value, fallback = DEFAULT_AGENT_STEPS) {
  if (value === undefined || value === null || value === "") {
    return normalizeAgentSteps(fallback, DEFAULT_AGENT_STEPS);
  }

  const parsed =
    typeof value === "number" ? value : Number.parseInt(String(value).trim(), 10);
  if (!Number.isInteger(parsed)) {
    throw new Error(
      `max steps must be an integer between ${MIN_AGENT_STEPS} and ${MAX_AGENT_STEPS}.`
    );
  }
  if (parsed < MIN_AGENT_STEPS || parsed > MAX_AGENT_STEPS) {
    throw new Error(
      `max steps must be between ${MIN_AGENT_STEPS} and ${MAX_AGENT_STEPS}.`
    );
  }
  return parsed;
}
