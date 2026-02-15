/**
 * Lightweight HTTP dashboard server for the MemOS plugin.
 *
 * Uses Node.js built-in `http` module — zero external dependencies.
 * Serves a single-page dashboard UI and a small JSON REST API.
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  getStats,
  getLogs,
  getConfigOverrides,
  setConfigOverrides,
  clearConfigOverrides,
  flushStats,
} from "../stats.js";

import { getPromptPreview, validateConfig } from "../memos-cloud-api.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
let uiHtml = null;

function loadUiHtml() {
  if (!uiHtml) {
    uiHtml = readFileSync(join(__dirname, "ui.html"), "utf-8");
  }
  return uiHtml;
}

function jsonResponse(res, data, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data));
}

function htmlResponse(res, html) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

/**
 * Start the dashboard HTTP server.
 *
 * @param {object} opts
 * @param {number} opts.port
 * @param {object} opts.runtimeConfig – reference to the live merged config
 * @param {object} opts.log           – logger (api.logger)
 * @returns {import("http").Server}
 */
export function startDashboard({ port = 9898, runtimeConfig = {}, log = console } = {}) {
  const server = createServer(async (req, res) => {
    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    try {
      // --- UI ---
      if (path === "/" && req.method === "GET") {
        htmlResponse(res, loadUiHtml());
        return;
      }

      // --- Stats ---
      if (path === "/api/stats" && req.method === "GET") {
        jsonResponse(res, { stats: getStats(), logs: getLogs("all", 20) });
        return;
      }

      // --- Logs ---
      if (path === "/api/logs" && req.method === "GET") {
        const type = url.searchParams.get("type") || "all";
        const limit = parseInt(url.searchParams.get("limit") || "50", 10);
        jsonResponse(res, { logs: getLogs(type, limit) });
        return;
      }

      // --- Config GET ---
      if (path === "/api/config" && req.method === "GET") {
        jsonResponse(res, {
          runtime: runtimeConfig,
          overrides: getConfigOverrides(),
        });
        return;
      }

      // --- Config POST ---
      if (path === "/api/config" && req.method === "POST") {
        const body = await readBody(req);
        if (body && typeof body === "object") {
          const { valid, errors } = validateConfig(body);
          if (!valid) {
            jsonResponse(res, { error: errors.join(" ") }, 400);
            return;
          }
          setConfigOverrides(body);
          jsonResponse(res, { saved: true });
        } else {
          jsonResponse(res, { error: "Invalid body" }, 400);
        }
        return;
      }

      // --- Config DELETE (reset) ---
      if (path === "/api/config" && req.method === "DELETE") {
        clearConfigOverrides();
        jsonResponse(res, { cleared: true });
        return;
      }

      // --- Prompt preview ---
      if (path === "/api/prompt/preview" && req.method === "POST") {
        const body = await readBody(req);
        const style = body?.style ?? "default";
        const template = body?.template ?? null;
        const preview = getPromptPreview(style, template);
        jsonResponse(res, { preview });
        return;
      }

      // --- Flush stats ---
      if (path === "/api/stats/flush" && req.method === "POST") {
        flushStats();
        jsonResponse(res, { flushed: true });
        return;
      }

      // 404
      jsonResponse(res, { error: "Not found" }, 404);
    } catch (err) {
      log.warn?.(`[memos-dashboard] Error handling ${req.method} ${path}: ${err.message}`);
      jsonResponse(res, { error: String(err.message) }, 500);
    }
  });

  server.listen(port, "0.0.0.0", () => {
    log.info?.(`[memos-cloud] Dashboard running at http://0.0.0.0:${port}`);
  });

  server.on("error", (err) => {
    log.warn?.(`[memos-cloud] Dashboard failed to start on port ${port}: ${err.message}`);
  });

  // Don't prevent process exit
  server.unref();

  return server;
}
