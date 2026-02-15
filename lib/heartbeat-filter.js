/**
 * Heartbeat detection for OpenClaw lifecycle events.
 *
 * Determines whether an incoming event is a periodic heartbeat so that
 * memory operations can be skipped (saving MemOS API tokens).
 *
 * Detection is multi-layered:
 *  1. Explicit event/context properties (if OpenClaw exposes them)
 *  2. Prompt content matching against configurable keywords
 */

const DEFAULT_KEYWORDS = ["HEARTBEAT_OK", "HEARTBEAT.md"];

/**
 * @param {object}  event  – lifecycle event (before_agent_start / agent_end)
 * @param {object}  ctx    – context object supplied by OpenClaw
 * @param {object}  cfg    – merged plugin config
 * @returns {boolean}
 */
export function isHeartbeatEvent(event, ctx, cfg) {
  if (!cfg.ignoreHeartbeats) return false;

  // --- Layer 1: explicit properties (best-case) ---
  if (event?.isHeartbeat === true) return true;
  if (ctx?.isHeartbeat === true) return true;
  if (event?.type === "heartbeat" || event?.type === "system_heartbeat")
    return true;
  if (event?.source === "heartbeat" || event?.source === "system_heartbeat")
    return true;
  if (ctx?.source === "heartbeat") return true;
  if (ctx?.messageProvider === "heartbeat") return true;
  if (event?.metadata?.isHeartbeat === true) return true;

  // --- Layer 2: keyword matching on prompt ---
  const keywords = cfg.heartbeatKeywords?.length
    ? cfg.heartbeatKeywords
    : DEFAULT_KEYWORDS;

  const prompt = event?.prompt ?? "";
  if (prompt && keywords.some((kw) => prompt.includes(kw))) return true;

  // --- Layer 3: keyword matching on LAST USER message only (for agent_end) ---
  // IMPORTANT: do NOT scan the full messages array — it contains session
  // history and a previous heartbeat turn would cause false positives.
  if (Array.isArray(event?.messages) && event.messages.length > 0) {
    const lastUserMsg = [...event.messages]
      .reverse()
      .find((m) => m?.role === "user");
    if (lastUserMsg?.content) {
      const text =
        typeof lastUserMsg.content === "string"
          ? lastUserMsg.content
          : Array.isArray(lastUserMsg.content)
            ? lastUserMsg.content
                .filter((b) => b?.type === "text")
                .map((b) => b.text)
                .join(" ")
            : "";
      if (text && keywords.some((kw) => text.includes(kw))) return true;
    }
  }

  return false;
}

/**
 * Build a debug snapshot of all properties checked, useful for
 * identifying which flag OpenClaw actually sets.
 */
export function debugEventSnapshot(event, ctx) {
  return {
    "event.isHeartbeat": event?.isHeartbeat,
    "event.type": event?.type,
    "event.source": event?.source,
    "event.metadata": event?.metadata,
    "ctx.isHeartbeat": ctx?.isHeartbeat,
    "ctx.source": ctx?.source,
    "ctx.messageProvider": ctx?.messageProvider,
    "ctx.sessionType": ctx?.sessionType,
    promptPreview: (event?.prompt ?? "").slice(0, 120),
    eventKeys: event ? Object.keys(event) : [],
    ctxKeys: ctx ? Object.keys(ctx) : [],
  };
}
