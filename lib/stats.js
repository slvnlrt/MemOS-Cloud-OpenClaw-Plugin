/**
 * Stats collector & ring-buffer event log for the MemOS plugin.
 *
 * - Ring buffer keeps the last N events in memory (default 200).
 * - Counters are persisted periodically to ~/.openclaw/memos-cloud-state.json.
 * - Stored OUTSIDE the plugin directory so data survives plugin reinstalls.
 * - getLogs() / getStats() are consumed by the dashboard API.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OPENCLAW_DIR = join(homedir(), ".openclaw");
const STATE_FILE = join(OPENCLAW_DIR, "memos-cloud-state.json");
const MAX_LOG_ENTRIES = 200;
const PERSIST_INTERVAL_MS = 60_000;

let counters = {
  totalEvents: 0,
  heartbeatsFiltered: 0,
  searchCalls: 0,
  addCalls: 0,
  errors: 0,
  startedAt: null,
};

/** @type {Array<object>} */
const logBuffer = [];

let nextId = 1;
let persistTimer = null;
let configOverrides = {};

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function readState() {
  try {
    const raw = readFileSync(STATE_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeState() {
  const state = {
    configOverrides,
    stats: { ...counters },
  };
  const json = JSON.stringify(state, null, 2);
  try {
    const tmp = STATE_FILE + ".tmp";
    writeFileSync(tmp, json, "utf-8");
    renameSync(tmp, STATE_FILE);
  } catch {
    try {
      writeFileSync(STATE_FILE, json, "utf-8");
    } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialise stats from persisted state (call once at plugin register).
 */
export function initStats() {
  // Ensure ~/.openclaw/ directory exists
  try {
    if (!existsSync(OPENCLAW_DIR)) {
      mkdirSync(OPENCLAW_DIR, { recursive: true });
    }
  } catch { /* best effort */ }

  const saved = readState();
  if (saved?.stats) {
    // Restore counters but keep startedAt as now
    const { startedAt: _ignored, ...rest } = saved.stats;
    Object.assign(counters, rest);
  }
  if (saved?.configOverrides) {
    configOverrides = saved.configOverrides;
  }
  counters.startedAt = new Date().toISOString();

  // Periodic persistence
  persistTimer = setInterval(() => writeState(), PERSIST_INTERVAL_MS);
  if (persistTimer.unref) persistTimer.unref();

  // Graceful shutdown
  const flush = () => {
    writeState();
    if (persistTimer) clearInterval(persistTimer);
  };
  process.on("SIGTERM", flush);
  process.on("SIGINT", flush);
}

/**
 * Record an event.
 * @param {"search"|"add"|"heartbeat_filtered"|"error"|"search_error"|"add_error"} type
 * @param {object} [details]
 */
export function recordEvent(type, details = {}) {
  counters.totalEvents += 1;

  switch (type) {
    case "heartbeat_filtered":
      counters.heartbeatsFiltered += 1;
      break;
    case "search":
      counters.searchCalls += 1;
      break;
    case "add":
      counters.addCalls += 1;
      break;
    case "error":
    case "search_error":
    case "add_error":
      counters.errors += 1;
      break;
  }

  const entry = {
    id: nextId++,
    timestamp: new Date().toISOString(),
    type,
    promptPreview: details.promptPreview ?? "",
    action: details.action ?? type,
    durationMs: details.durationMs ?? null,
    error: details.error ?? null,
    debug: details.debug ?? null,
  };

  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG_ENTRIES) {
    logBuffer.shift();
  }
}

/**
 * @returns {object} aggregated counters
 */
export function getStats() {
  return { ...counters };
}

/**
 * @param {string} [typeFilter] – "all" | "heartbeat" | "error" | "normal"
 * @param {number} [limit]
 * @returns {Array<object>}
 */
export function getLogs(typeFilter = "all", limit = 50) {
  let logs = logBuffer;

  if (typeFilter && typeFilter !== "all") {
    switch (typeFilter) {
      case "heartbeat":
        logs = logs.filter((e) => e.type === "heartbeat_filtered");
        break;
      case "error":
        logs = logs.filter((e) => e.type.includes("error"));
        break;
      case "normal":
        logs = logs.filter(
          (e) => e.type !== "heartbeat_filtered" && !e.type.includes("error"),
        );
        break;
    }
  }

  return logs.slice(-limit).reverse();
}

// ---------------------------------------------------------------------------
// Config overrides (managed by dashboard)
// ---------------------------------------------------------------------------

export function getConfigOverrides() {
  return { ...configOverrides };
}

export function setConfigOverrides(overrides) {
  configOverrides = { ...overrides };
  writeState();
}

export function clearConfigOverrides() {
  configOverrides = {};
  writeState();
}

export function flushStats() {
  writeState();
}
