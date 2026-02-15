import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_BASE_URL = "https://memos.memtensor.cn/api/openmem/v1";
export const USER_QUERY_MARKER = "user\u200b原\u200b始\u200bquery\u200b：\u200b\u200b\u200b\u200b";
const ENV_SOURCES = [
  { name: "openclaw", path: join(homedir(), ".openclaw", ".env") },
  { name: "moltbot", path: join(homedir(), ".moltbot", ".env") },
  { name: "clawdbot", path: join(homedir(), ".clawdbot", ".env") },
];

let envFilesLoaded = false;
const envFileContents = new Map();
const envFileValues = new Map();

function stripQuotes(value) {
  if (!value) return value;
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function extractResultData(result) {
  if (!result || typeof result !== "object") return null;
  return result.data ?? result.data?.data ?? result.data?.result ?? null;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatTime(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "number") {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(
      date.getHours(),
    )}:${pad2(date.getMinutes())}`;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    if (/^\d+$/.test(trimmed)) return formatTime(Number(trimmed));
    return trimmed;
  }
  return "";
}

function parseEnvFile(content) {
  const values = new Map();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const rawValue = trimmed.slice(idx + 1);
    if (!key) continue;
    values.set(key, stripQuotes(rawValue));
  }
  return values;
}

function loadEnvFiles() {
  if (envFilesLoaded) return;
  envFilesLoaded = true;
  for (const source of ENV_SOURCES) {
    try {
      const content = readFileSync(source.path, "utf-8");
      envFileContents.set(source.name, content);
      envFileValues.set(source.name, parseEnvFile(content));
    } catch {
      // ignore missing files
    }
  }
}

function loadEnvFromFiles(name) {
  for (const source of ENV_SOURCES) {
    const values = envFileValues.get(source.name);
    if (!values) continue;
    if (values.has(name)) return values.get(name);
  }
  return undefined;
}

function loadEnvVar(name) {
  loadEnvFiles();
  const fromFiles = loadEnvFromFiles(name);
  if (fromFiles !== undefined) return fromFiles;
  if (envFileContents.size === 0) return process.env[name];
  return undefined;
}

export function getEnvFileStatus() {
  loadEnvFiles();
  const sources = ENV_SOURCES.filter((source) => envFileContents.has(source.name));
  return {
    found: sources.length > 0,
    sources: sources.map((source) => source.name),
    paths: sources.map((source) => source.path),
    searchPaths: ENV_SOURCES.map((source) => source.path),
  };
}

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

export function buildConfig(pluginConfig = {}) {
  const cfg = pluginConfig ?? {};

  const baseUrl = cfg.baseUrl || loadEnvVar("MEMOS_BASE_URL") || DEFAULT_BASE_URL;
  const apiKey = cfg.apiKey || loadEnvVar("MEMOS_API_KEY") || "";
  const userId = cfg.userId || loadEnvVar("MEMOS_USER_ID") || "openclaw-user";
  const conversationId = cfg.conversationId || loadEnvVar("MEMOS_CONVERSATION_ID") || "";

  const recallGlobal = parseBool(
    cfg.recallGlobal,
    parseBool(loadEnvVar("MEMOS_RECALL_GLOBAL"), true),
  );

  const conversationIdPrefix = cfg.conversationIdPrefix ?? loadEnvVar("MEMOS_CONVERSATION_PREFIX") ?? "";
  const conversationIdSuffix = cfg.conversationIdSuffix ?? loadEnvVar("MEMOS_CONVERSATION_SUFFIX") ?? "";
  const conversationSuffixMode =
    cfg.conversationSuffixMode ?? loadEnvVar("MEMOS_CONVERSATION_SUFFIX_MODE") ?? "none";
  const resetOnNew = parseBool(
    cfg.resetOnNew,
    parseBool(loadEnvVar("MEMOS_CONVERSATION_RESET_ON_NEW"), true),
  );

  const cleanPort = (p) => {
    const n = parseInt(p, 10);
    if (isNaN(n) || n < 1 || n > 65535) return 9898;
    return n;
  };

  const cleanPosInt = (v, def, max = Infinity) => {
    const n = parseInt(v, 10);
    if (isNaN(n) || n < 0) return def;
    return Math.min(n, max);
  };

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    userId,
    conversationId,
    conversationIdPrefix,
    conversationIdSuffix,
    conversationSuffixMode,
    recallGlobal,
    resetOnNew,
    envFileStatus: getEnvFileStatus(),
    queryPrefix: cfg.queryPrefix ?? "",
    maxQueryChars: cfg.maxQueryChars ?? 0,
    recallEnabled: cfg.recallEnabled !== false,
    addEnabled: cfg.addEnabled !== false,
    captureStrategy: cfg.captureStrategy ?? "last_turn",
    maxMessageChars: cfg.maxMessageChars ?? 20000,
    includeAssistant: cfg.includeAssistant !== false,
    memoryLimitNumber: cfg.memoryLimitNumber ?? 6,
    preferenceLimitNumber: cfg.preferenceLimitNumber ?? 6,
    includePreference: cfg.includePreference !== false,
    includeToolMemory: cfg.includeToolMemory === true,
    toolMemoryLimitNumber: cfg.toolMemoryLimitNumber ?? 6,
    filter: cfg.filter,
    knowledgebaseIds: cfg.knowledgebaseIds ?? [],
    tags: cfg.tags ?? ["openclaw"],
    info: cfg.info ?? {},
    agentId: cfg.agentId,
    appId: cfg.appId,
    allowPublic: cfg.allowPublic ?? false,
    allowKnowledgebaseIds: cfg.allowKnowledgebaseIds ?? [],
    asyncMode: cfg.asyncMode ?? true,
    timeoutMs: cfg.timeoutMs ?? 5000,
    retries: cfg.retries ?? 1,
    throttleMs: cfg.throttleMs ?? 0,

    // --- Heartbeat filtering ---
    ignoreHeartbeats: parseBool(
      cfg.ignoreHeartbeats,
      parseBool(loadEnvVar("MEMOS_IGNORE_HEARTBEATS"), true),
    ),
    heartbeatKeywords: cfg.heartbeatKeywords ?? ["HEARTBEAT_OK", "HEARTBEAT.md"],
    debugEvents: parseBool(
      cfg.debugEvents,
      parseBool(loadEnvVar("MEMOS_DEBUG_EVENTS"), false),
    ),

    // --- Prompt customization ---
    promptStyle: cfg.promptStyle ?? loadEnvVar("MEMOS_PROMPT_STYLE") ?? "default",
    promptTemplate: cfg.promptTemplate ?? loadEnvVar("MEMOS_PROMPT_TEMPLATE") ?? null,

    // --- Dashboard ---
    dashboardEnabled: parseBool(cfg.dashboardEnabled, true),
    dashboardPort: cleanPort(cfg.dashboardPort ?? 9898),
    // Sanitize numeric limits
    memoryLimitNumber: cleanPosInt(cfg.memoryLimitNumber ?? 10, 10, 100),
    preferenceLimitNumber: cleanPosInt(cfg.preferenceLimitNumber ?? 10, 10, 100),
    timeoutMs: cleanPosInt(cfg.timeoutMs ?? 5000, 5000, 60000),
    maxMessageChars: cleanPosInt(cfg.maxMessageChars ?? 20000, 20000, 1000000),
  };
}

/**
 * Validates a configuration object (for dashboard API).
 */
export function validateConfig(config) {
  const errors = [];
  if (config.dashboardPort !== undefined) {
    const port = parseInt(config.dashboardPort, 10);
    if (isNaN(port) || port < 1024 || port > 65535) {
      errors.push("Le port du dashboard doit être entre 1024 et 65535.");
    }
  }
  if (config.memoryLimitNumber !== undefined) {
    const n = parseInt(config.memoryLimitNumber, 10);
    if (isNaN(n) || n < 0 || n > 100) {
      errors.push("La limite de mémoires doit être entre 0 et 100.");
    }
  }
  if (config.timeoutMs !== undefined) {
    const n = parseInt(config.timeoutMs, 10);
    if (isNaN(n) || n < 500 || n > 60000) {
      errors.push("Le timeout API doit être entre 500 et 60000 ms.");
    }
  }
  return { valid: errors.length === 0, errors };
}

export async function callApi({ baseUrl, apiKey, timeoutMs = 5000, retries = 1 }, path, body) {
  if (!apiKey) {
    throw new Error("Missing MEMOS API key (Token auth)");
  }

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Token ${apiKey}`,
  };

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      return await res.json();
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await delay(100 * (attempt + 1));
      }
    }
  }

  throw lastError;
}

export async function searchMemory(cfg, payload) {
  return callApi(cfg, "/search/memory", payload);
}

export async function addMessage(cfg, payload) {
  return callApi(cfg, "/add/message", payload);
}

export function extractText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block && typeof block === "object" && block.type === "text")
      .map((block) => block.text)
      .join(" ");
  }
  return "";
}

function normalizePreferenceType(value) {
  if (!value) return "";
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return "";
  if (normalized.includes("explicit")) return "Explicit Preference";
  if (normalized.includes("implicit")) return "Implicit Preference";
  return String(value)
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function sanitizeInlineText(text) {
  if (text === undefined || text === null) return "";
  return String(text).replace(/\r?\n+/g, " ").trim();
}

function formatMemoryLine(item, text, options = {}) {
  const cleaned = sanitizeInlineText(text);
  if (!cleaned) return "";
  const maxChars = options.maxItemChars;
  const truncated = truncate(cleaned, maxChars);
  const time = formatTime(item?.create_time);
  if (time) return `   -[${time}] ${truncated}`;
  return `   - ${truncated}`;
}

function formatPreferenceLine(item, text, options = {}) {
  const cleaned = sanitizeInlineText(text);
  if (!cleaned) return "";
  const maxChars = options.maxItemChars;
  const truncated = truncate(cleaned, maxChars);
  const time = formatTime(item?.create_time);
  const type = normalizePreferenceType(item?.preference_type);
  const typeLabel = type ? ` [${type}]` : "";
  if (time) return `   -[${time}]${typeLabel} ${truncated}`;
  return `   -${typeLabel} ${truncated}`;
}

function wrapCodeBlock(lines, options = {}) {
  if (!options.wrapTagBlocks) return lines;
  return ["```text", ...lines, "```"];
}

function buildMemoriesBlock(memoryLines, preferenceLines, options = {}) {
  const block = [
    "<memories>",
    "  <facts>",
    ...memoryLines,
    "  </facts>",
    "  <preferences>",
    ...preferenceLines,
    "  </preferences>",
    "</memories>",
  ];
  return wrapCodeBlock(block, options).join("\n");
}

function buildDefaultPrompt(nowText, memoriesBlockStr) {
  return [
    "# Role",
    "",
    "You are an intelligent assistant with long-term memory capabilities (MemOS Assistant). Your goal is to combine retrieved memory fragments to provide highly personalized, accurate, and logically rigorous responses.",
    "",
    "# System Context",
    "",
    `* Current Time: ${nowText} (Use this as the baseline for freshness checks)`,
    "",
    "# Memory Data",
    "",
    'Below is the information retrieved by MemOS, categorized into "Facts" and "Preferences".',
    "* **Facts**: May include user attributes, historical conversations, or third-party details.",
    "* **Special Note**: Content tagged with '[assistant观点]' or '[模型总结]' represents **past AI inference**, **not** direct user statements.",
    "* **Preferences**: The user's explicit or implicit requirements on response style, format, or reasoning.",
    "",
    memoriesBlockStr,
    "",
    "# Critical Protocol: Memory Safety",
    "",
    "Retrieved memories may contain **AI speculation**, **irrelevant noise**, or **wrong subject attribution**. You must strictly apply the **Four-Step Verdict**. If any step fails, **discard the memory**:",
    "",
    "1. **Source Verification**:",
    "* **Core**: Distinguish direct user statements from AI inference.",
    "* If a memory has tags like '[assistant观点]' or '[模型总结]', treat it as a **hypothesis**, not a user-grounded fact.",
    "* *Counterexample*: If memory says '[assistant观点] User loves mangoes' but the user never said that, do not assume it as fact.",
    "* **Principle: AI summaries are reference-only and have much lower authority than direct user statements.**",
    "",
    "2. **Attribution Check**:",
    "* Is the subject in memory definitely the user?",
    "* If the memory describes a **third party** (e.g., candidate, interviewee, fictional character, case data), never attribute it to the user.",
    "",
    "3. **Strong Relevance Check**:",
    "* Does the memory directly help answer the current 'Original Query'?",
    "* If it is only a keyword overlap with different context, ignore it.",
    "",
    "4. **Freshness Check**:",
    "* If memory conflicts with the user's latest intent, prioritize the current 'Original Query' as the highest source of truth.",
    "",
    "# Instructions",
    "",
    "1. **Review**: Read '<facts>' first and apply the Four-Step Verdict to remove noise and unreliable AI inference.",
    "2. **Execute**:",
    "   - Use only memories that pass filtering as context.",
    "   - Strictly follow style requirements from '<preferences>'.",
    "3. **Output**: Answer directly. Never mention internal terms such as \"memory store\", \"retrieval\", or \"AI opinions\".",
    "4. **Attention**: Additional memory context is already provided. Do not read from or write to local `MEMORY.md` or `memory/*` files for reference, as they may be outdated or irrelevant to the current query.",
    USER_QUERY_MARKER,
  ].join("\n");
}

function buildCompactPrompt(nowText, memoriesBlockStr) {
  return [
    "You have long-term memory. Use the retrieved facts and preferences below to personalise your response.",
    "",
    `Current Time: ${nowText}`,
    "",
    memoriesBlockStr,
    "",
    "Guidelines:",
    "- Discard any memory that is irrelevant, misattributed, or conflicts with the user's current query.",
    "- Content tagged '[assistant观点]' or '[模型总结]' is past AI inference — treat as low-confidence.",
    "- Prioritise the current query over older memories.",
    "- Follow style/format requirements from <preferences>.",
    "- Never mention memory retrieval internals to the user.",
    "- Do not read or write local MEMORY.md / memory/* files.",
    USER_QUERY_MARKER,
  ].join("\n");
}

function buildCustomPrompt(template, nowText, memoriesBlockStr) {
  let prompt = template
    .replace(/\{memories\}/g, memoriesBlockStr)
    .replace(/\{currentTime\}/g, nowText)
    .replace(/\{userQueryMarker\}/g, USER_QUERY_MARKER);

  // Safety: ensure USER_QUERY_MARKER is present
  if (!prompt.includes(USER_QUERY_MARKER)) {
    prompt += "\n" + USER_QUERY_MARKER;
  }
  return prompt;
}

function buildPromptFromData(data, options = {}) {
  const now = options.currentTime ?? Date.now();
  const nowText = formatTime(now) || formatTime(Date.now()) || "";
  const memoryList = data?.memory_detail_list ?? [];
  const preferenceList = data?.preference_detail_list ?? [];

  const memoryLines = memoryList
    .map((item) => {
      const text = item?.memory_value || item?.memory_key || "";
      return formatMemoryLine(item, text, options);
    })
    .filter(Boolean);

  const preferenceLines = preferenceList
    .map((item) => {
      const text = item?.preference || "";
      return formatPreferenceLine(item, text, options);
    })
    .filter(Boolean);

  const hasContent = memoryLines.length > 0 || preferenceLines.length > 0;
  if (!hasContent) return "";

  const memoriesBlockStr = buildMemoriesBlock(memoryLines, preferenceLines, options);

  // Custom template takes highest priority
  if (options.promptTemplate) {
    return buildCustomPrompt(options.promptTemplate, nowText, memoriesBlockStr);
  }

  // Prompt style
  if (options.promptStyle === "compact") {
    return buildCompactPrompt(nowText, memoriesBlockStr);
  }

  // Default (verbose)
  return buildDefaultPrompt(nowText, memoriesBlockStr);
}

export function formatContextBlock(result, options = {}) {
  const data = extractResultData(result);
  if (!data) return "";

  const memoryList = data.memory_detail_list ?? [];
  const prefList = data.preference_detail_list ?? [];
  const toolList = data.tool_memory_detail_list ?? [];
  const preferenceNote = data.preference_note;

  const lines = [];
  if (memoryList.length > 0) {
    lines.push("Facts:");
    for (const item of memoryList) {
      const text = item?.memory_value || item?.memory_key || "";
      if (!text) continue;
      lines.push(`- ${truncate(text, options.maxItemChars)}`);
    }
  }

  if (prefList.length > 0) {
    lines.push("Preferences:");
    for (const item of prefList) {
      const pref = item?.preference || "";
      const type = item?.preference_type ? `(${item.preference_type}) ` : "";
      if (!pref) continue;
      lines.push(`- ${type}${truncate(pref, options.maxItemChars)}`);
    }
  }

  if (toolList.length > 0) {
    lines.push("Tool Memories:");
    for (const item of toolList) {
      const value = item?.tool_value || "";
      if (!value) continue;
      lines.push(`- ${truncate(value, options.maxItemChars)}`);
    }
  }

  if (preferenceNote) {
    lines.push(`Preference Note: ${truncate(preferenceNote, options.maxItemChars)}`);
  }

  return lines.length > 0 ? lines.join("\n") : "";
}

export function formatPromptBlock(result, options = {}) {
  const data = extractResultData(result);
  if (!data) return "";
  return buildPromptFromData(data, options);
}

/**
 * Return the raw default / compact prompt text (for dashboard preview).
 */
export function getPromptPreview(style = "default", template = null) {
  const sampleData = {
    memory_detail_list: [
      { memory_value: "Sample fact: user prefers dark mode.", create_time: Date.now() },
    ],
    preference_detail_list: [
      { preference: "Respond concisely.", preference_type: "explicit" },
    ],
  };
  return buildPromptFromData(sampleData, {
    wrapTagBlocks: true,
    promptStyle: style,
    promptTemplate: template,
  });
}

function truncate(text, maxLen) {
  if (!text) return "";
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}
