import {
  addMessage,
  buildConfig,
  extractText,
  formatPromptBlock,
  USER_QUERY_MARKER,
  searchMemory,
} from "./lib/memos-cloud-api.js";

import { isHeartbeatEvent, debugEventSnapshot } from "./lib/heartbeat-filter.js";
import { initStats, recordEvent, getConfigOverrides } from "./lib/stats.js";
import { startDashboard } from "./lib/dashboard/server.js";

/**
 * Strips MemOS boilerplate from prompt for cleaner dashboard logs.
 */
function cleanPromptPreview(prompt) {
  if (!prompt) return "";
  let p = prompt;
  // Strip "Conversation info (untrusted metadata):" and the following JSON block
  p = p.replace(/^Conversation info \(untrusted metadata\):[\s\S]*?```json[\s\S]*?```\n*/i, "");
  // Strip "Recall result (untrusted metadata):" and the following JSON block
  p = p.replace(/^Recall result \(untrusted metadata\):[\s\S]*?```json[\s\S]*?```\n*/i, "");
  // Strip common MemOS headers if they appear at the start
  p = p.replace(/^# (Role|System Context|Memory Data)[\s\S]*?(?=# (System Context|Memory Data|Instructions|Original Query)|$)/gi, "");
  // Strip markers
  p = p.replace(USER_QUERY_MARKER, "");
  return p.trim().slice(0, 100);
}

let lastCaptureTime = 0;
const conversationCounters = new Map();
const API_KEY_HELP_URL = "https://memos-dashboard.openmem.net/cn/apikeys/";
const ENV_FILE_SEARCH_HINTS = ["~/.openclaw/.env", "~/.moltbot/.env", "~/.clawdbot/.env"];
const MEMOS_SOURCE = "openclaw";

function warnMissingApiKey(log, context) {
  const heading = "[memos-cloud] Missing MEMOS_API_KEY (Token auth)";
  const header = `${heading}${context ? `; ${context} skipped` : ""}. Configure it with:`;
  log.warn?.(
    [
      header,
      "echo 'export MEMOS_API_KEY=\"mpg-...\"' >> ~/.zshrc",
      "source ~/.zshrc",
      "or",
      "echo 'export MEMOS_API_KEY=\"mpg-...\"' >> ~/.bashrc",
      "source ~/.bashrc",
      "or",
      "[System.Environment]::SetEnvironmentVariable(\"MEMOS_API_KEY\", \"mpg-...\", \"User\")",
      `Get API key: ${API_KEY_HELP_URL}`,
    ].join("\n"),
  );
}

function stripPrependedPrompt(content) {
  if (!content) return content;
  const idx = content.lastIndexOf(USER_QUERY_MARKER);
  if (idx === -1) return content;
  return content.slice(idx + USER_QUERY_MARKER.length).trimStart();
}

function getCounterSuffix(sessionKey) {
  if (!sessionKey) return "";
  const current = conversationCounters.get(sessionKey) ?? 0;
  return current > 0 ? `#${current}` : "";
}

function bumpConversationCounter(sessionKey) {
  if (!sessionKey) return;
  const current = conversationCounters.get(sessionKey) ?? 0;
  conversationCounters.set(sessionKey, current + 1);
}

function resolveConversationId(cfg, ctx) {
  if (cfg.conversationId) return cfg.conversationId;
  // TODO: consider binding conversation_id directly to OpenClaw sessionId (prefer ctx.sessionId).
  const base = ctx?.sessionKey || ctx?.sessionId || (ctx?.agentId ? `openclaw:${ctx.agentId}` : "");
  const dynamicSuffix = cfg.conversationSuffixMode === "counter" ? getCounterSuffix(ctx?.sessionKey) : "";
  const prefix = cfg.conversationIdPrefix || "";
  const suffix = cfg.conversationIdSuffix || "";
  if (base) return `${prefix}${base}${dynamicSuffix}${suffix}`;
  return `${prefix}openclaw-${Date.now()}${dynamicSuffix}${suffix}`;
}

function buildSearchPayload(cfg, prompt, ctx) {
  const queryRaw = `${cfg.queryPrefix || ""}${prompt}`;
  const query =
    Number.isFinite(cfg.maxQueryChars) && cfg.maxQueryChars > 0
      ? queryRaw.slice(0, cfg.maxQueryChars)
      : queryRaw;

  const payload = {
    user_id: cfg.userId,
    query,
    source: MEMOS_SOURCE,
  };

  if (!cfg.recallGlobal) {
    const conversationId = resolveConversationId(cfg, ctx);
    if (conversationId) payload.conversation_id = conversationId;
  }

  if (cfg.filter) payload.filter = cfg.filter;
  if (cfg.knowledgebaseIds?.length) payload.knowledgebase_ids = cfg.knowledgebaseIds;

  payload.memory_limit_number = cfg.memoryLimitNumber;
  payload.include_preference = cfg.includePreference;
  payload.preference_limit_number = cfg.preferenceLimitNumber;
  payload.include_tool_memory = cfg.includeToolMemory;
  payload.tool_memory_limit_number = cfg.toolMemoryLimitNumber;

  return payload;
}

function buildAddMessagePayload(cfg, messages, ctx) {
  const payload = {
    user_id: cfg.userId,
    conversation_id: resolveConversationId(cfg, ctx),
    messages,
    source: MEMOS_SOURCE,
  };

  if (cfg.agentId) payload.agent_id = cfg.agentId;
  if (cfg.appId) payload.app_id = cfg.appId;
  if (cfg.tags?.length) payload.tags = cfg.tags;

  const info = {
    source: "openclaw",
    sessionKey: ctx?.sessionKey,
    agentId: ctx?.agentId,
    ...(cfg.info || {}),
  };
  if (Object.keys(info).length > 0) payload.info = info;

  payload.allow_public = cfg.allowPublic;
  if (cfg.allowKnowledgebaseIds?.length) payload.allow_knowledgebase_ids = cfg.allowKnowledgebaseIds;
  payload.async_mode = cfg.asyncMode;

  return payload;
}

function pickLastTurnMessages(messages, cfg) {
  const lastUserIndex = messages
    .map((m, idx) => ({ m, idx }))
    .filter(({ m }) => m?.role === "user")
    .map(({ idx }) => idx)
    .pop();

  if (lastUserIndex === undefined) return [];

  const slice = messages.slice(lastUserIndex);
  const results = [];

  for (const msg of slice) {
    if (!msg || !msg.role) continue;
    if (msg.role === "user") {
      const content = stripPrependedPrompt(extractText(msg.content));
      if (content) results.push({ role: "user", content: truncate(content, cfg.maxMessageChars) });
      continue;
    }
    if (msg.role === "assistant" && cfg.includeAssistant) {
      const content = extractText(msg.content);
      if (content) results.push({ role: "assistant", content: truncate(content, cfg.maxMessageChars) });
    }
  }

  return results;
}

function pickFullSessionMessages(messages, cfg) {
  const results = [];
  for (const msg of messages) {
    if (!msg || !msg.role) continue;
    if (msg.role === "user") {
      const content = stripPrependedPrompt(extractText(msg.content));
      if (content) results.push({ role: "user", content: truncate(content, cfg.maxMessageChars) });
    }
    if (msg.role === "assistant" && cfg.includeAssistant) {
      const content = extractText(msg.content);
      if (content) results.push({ role: "assistant", content: truncate(content, cfg.maxMessageChars) });
    }
  }
  return results;
}

function truncate(text, maxLen) {
  if (!text) return "";
  if (!maxLen) return text;
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

export default {
  id: "memos-cloud-openclaw-plugin",
  name: "MemOS Cloud OpenClaw Plugin",
  description: "MemOS Cloud recall + add memory via lifecycle hooks",
  kind: "lifecycle",

  register(api) {
    const baseCfg = buildConfig(api.pluginConfig);
    const log = api.logger ?? console;

    // --- Init stats & merge config overrides from dashboard ---
    initStats();
    const overrides = getConfigOverrides();
    const cfg = { ...baseCfg, ...overrides };

    if (!cfg.envFileStatus?.found) {
      const searchPaths = cfg.envFileStatus?.searchPaths?.join(", ") ?? ENV_FILE_SEARCH_HINTS.join(", ");
      log.warn?.(`[memos-cloud] No .env found in ${searchPaths}; falling back to process env or plugin config.`);
    }

    // --- Start dashboard ---
    if (cfg.dashboardEnabled) {
      try {
        startDashboard({ port: cfg.dashboardPort, runtimeConfig: cfg, log });
      } catch (err) {
        log.warn?.(`[memos-cloud] Dashboard start failed: ${err.message}`);
      }
    }

    if (cfg.conversationSuffixMode === "counter" && cfg.resetOnNew) {
      if (api.config?.hooks?.internal?.enabled !== true) {
        log.warn?.("[memos-cloud] command:new hook requires hooks.internal.enabled = true");
      }
      api.registerHook(
        ["command:new"],
        (event) => {
          if (event?.type === "command" && event?.action === "new") {
            bumpConversationCounter(event.sessionKey);
          }
        },
        {
          name: "memos-cloud-conversation-new",
          description: "Increment MemOS conversation suffix on /new",
        },
      );
    }

    api.on("before_agent_start", async (event, ctx) => {
      // --- Heartbeat filter ---
      if (isHeartbeatEvent(event, ctx, cfg)) {
        recordEvent("heartbeat_filtered", {
          promptPreview: (event?.prompt ?? "").slice(0, 60),
          debug: cfg.debugEvents ? debugEventSnapshot(event, ctx) : undefined,
        });
        if (cfg.debugEvents) {
          log.info?.(`[memos-cloud] Heartbeat filtered: ${JSON.stringify(debugEventSnapshot(event, ctx))}`);
        }
        return;
      }

      if (!cfg.recallEnabled) return;
      if (!event?.prompt || event.prompt.length < 3) return;
      if (!cfg.apiKey) {
        warnMissingApiKey(log, "recall");
        return;
      }

      const t0 = Date.now();
      try {
        const payload = buildSearchPayload(cfg, event.prompt, ctx);
        const result = await searchMemory(cfg, payload);
        const promptBlock = formatPromptBlock(result, {
          wrapTagBlocks: true,
          promptStyle: cfg.promptStyle,
          promptTemplate: cfg.promptTemplate,
        });

        recordEvent("search", {
          promptPreview: cleanPromptPreview(event.prompt),
          durationMs: Date.now() - t0,
        });

        if (!promptBlock) return;

        return {
          prependContext: promptBlock,
        };
      } catch (err) {
        recordEvent("search_error", {
          promptPreview: (event?.prompt ?? "").slice(0, 60),
          error: String(err),
          durationMs: Date.now() - t0,
        });
        log.warn?.(`[memos-cloud] recall failed: ${String(err)}`);
      }
    });

    api.on("agent_end", async (event, ctx) => {
      // --- Heartbeat filter ---
      if (isHeartbeatEvent(event, ctx, cfg)) {
        recordEvent("heartbeat_filtered", {
          promptPreview: "(agent_end)",
          debug: cfg.debugEvents ? debugEventSnapshot(event, ctx) : undefined,
        });
        return;
      }

      if (!cfg.addEnabled) return;
      if (!event?.success || !event?.messages?.length) return;
      if (!cfg.apiKey) {
        warnMissingApiKey(log, "add");
        return;
      }

      const now = Date.now();
      if (cfg.throttleMs && now - lastCaptureTime < cfg.throttleMs) {
        return;
      }
      lastCaptureTime = now;

      const t0 = Date.now();
      try {
        const messages =
          cfg.captureStrategy === "full_session"
            ? pickFullSessionMessages(event.messages, cfg)
            : pickLastTurnMessages(event.messages, cfg);

        if (!messages.length) return;

        const payload = buildAddMessagePayload(cfg, messages, ctx);
        await addMessage(cfg, payload);

        recordEvent("add", {
          promptPreview: `${messages.length} messages`,
          durationMs: Date.now() - t0,
        });
      } catch (err) {
        recordEvent("add_error", {
          error: String(err),
          durationMs: Date.now() - t0,
        });
        log.warn?.(`[memos-cloud] add failed: ${String(err)}`);
      }
    });
  },
};
