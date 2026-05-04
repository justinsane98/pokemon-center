// Pokémon Center, Node bridge between the static web UI (public/) and the
// `claude` CLI. Runs `claude --print --output-format=stream-json --agent <id>`
// per turn, streams stdout as Server-Sent Events to the browser.
//
// Auth: uses your local `claude` CLI's keychain credentials (Claude Max OAuth).
// No API keys live in this codebase. To install/authenticate the CLI, see README.

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { appendMessage, getHistory, search } from "./db.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATIC_ROOT = path.join(HERE, "public");
const CONFIG_PATH = path.join(STATIC_ROOT, "config.json");
const PORT = Number(process.env.PORT) || 8765;
// Tag every persisted entry with a project name so the shared DB can be
// scoped/aggregated later. Defaults to the basename of the directory the
// server was started from. Override with ARENA_PROJECT.
const PROJECT = process.env.ARENA_PROJECT || path.basename(process.cwd()) || "arena";
// Each spawned `claude` runs with $HOME as cwd so agents can read/grep across
// any project under your home directory. Override with ARENA_CWD if you'd rather
// scope the session somewhere narrower.
const CLAUDE_CWD = process.env.ARENA_CWD || os.homedir();

// Roster of allowed agent ids comes from config.json, the source of truth shared with the browser.
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const AGENTS = (config.roster || []).map((r) => r.id);

const MIME = {
  ".css":  "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js":   "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png":  "image/png",
  ".svg":  "image/svg+xml",
  ".txt":  "text/plain; charset=utf-8",
  ".webp": "image/webp",
};

const FORMAT_RULES =
  `Use plain text or markdown only (lists, **bold**, *italic*, \`code\`, links). \
Do NOT emit raw HTML tags — they will not render and will appear as literal markup in the group chat.`;

const BROADCAST_WRAPPER = (msg) =>
  `[@team broadcast]
${msg}

If this is not in your lane, respond with exactly: PASS

Otherwise: line 1 must be "SUMMARY: <one short line in your dialect>", then a blank line, then your full response in character.

${FORMAT_RULES}`;

// Force-respond variant: used when this agent was @-mentioned (or @team).
// They MUST respond, no PASS allowed.
const FORCE_WRAPPER = (msg) =>
  `[@team broadcast, you were @-mentioned]
${msg}

You were explicitly tagged. You MUST respond, do not output PASS even if it's outside your usual lane.

Format: line 1 must be "SUMMARY: <one short line in your dialect>", then a blank line, then your full response in character.

${FORMAT_RULES}`;

// Stub seam for future ambient checks (Linear, Gmail, GitHub PRs, deploys, etc).
// Returns array of { summary, body, at } per agent since lastReadAt.
function laneCheck(_agentId) {
  return [];
}

function spawnClaude({ agent, message, sessionId }) {
  // bypassPermissions: agents run non-interactively, so any permission prompt
  // (e.g. Bash(gh:*)) would stall the spawn forever. Local-trusted arena —
  // each agent's tool surface is already scoped by its frontmatter `tools:` list.
  const args = [
    "--print",
    "--output-format=stream-json",
    "--verbose",
    "--permission-mode", "bypassPermissions",
    "--agent", agent,
  ];
  if (sessionId) args.push("--resume", sessionId);
  args.push(message);
  return spawn("claude", args, {
    cwd: CLAUDE_CWD,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function streamLines(child, onEvent, onClose) {
  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try { onEvent(JSON.parse(line)); }
      catch { /* malformed line, skip */ }
    }
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
  child.on("close", (code) => onClose(code, stderr));
}

function sseInit(res) {
  res.writeHead(200, {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Content-Type": "text/event-stream",
  });
}

function sseEvent(res, event, data) {
  if (res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

async function handleChat(req, res, agent) {
  if (!AGENTS.includes(agent)) { res.writeHead(404); res.end("unknown agent"); return; }
  let body;
  try { body = await readJsonBody(req); }
  catch { res.writeHead(400); res.end("bad json"); return; }
  const message = (body.message || "").trim();
  const sessionId = body.sessionId || null;
  if (!message) { res.writeHead(400); res.end("missing message"); return; }

  sseInit(res);
  let firstSession = false;
  let firstDelta = true;
  const child = spawnClaude({ agent, message, sessionId });

  streamLines(child, (evt) => {
    if (evt.type === "system" && evt.subtype === "init" && !firstSession) {
      firstSession = true;
      sseEvent(res, "session", { sessionId: evt.session_id });
    } else if (evt.type === "assistant") {
      // Join multiple text blocks within one message with \n\n (tool_use blocks
      // between text blocks otherwise collapse paragraph boundaries). Also
      // separate consecutive assistant events with \n\n so sub-agent (Task)
      // outputs don't smash into the parent's text.
      const text = (evt.message?.content || [])
        .map((c) => c?.text || "")
        .filter(Boolean)
        .join("\n\n");
      if (text) {
        const out = firstDelta ? text : "\n\n" + text;
        firstDelta = false;
        sseEvent(res, "delta", { text: out });
      }
    } else if (evt.type === "result") {
      sseEvent(res, "done", { ok: !evt.is_error, result: evt.result || "" });
    }
  }, (code, stderr) => {
    if (code !== 0 && !res.writableEnded) {
      sseEvent(res, "delta", { text: stderr || `[claude exited ${code}]` });
      sseEvent(res, "done", { ok: false, code });
    }
    res.end();
  });

  req.on("close", () => { try { child.kill("SIGTERM"); } catch {} });
}

async function handleBroadcast(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch { res.writeHead(400); res.end("bad json"); return; }
  const message = (body.message || "").trim();
  const sessions = body.sessions || {};
  const mentions = new Set((body.mentions || []).map((s) => String(s).toLowerCase()));
  if (!message) { res.writeHead(400); res.end("missing message"); return; }

  sseInit(res);

  // Routing rules for who actually gets spawned this turn:
  //   - @team in mentions → fan out to every agent (forced response).
  //   - any other @<id> mentions → spawn ONLY those, forced response.
  //   - no mentions → fan out to every agent in PASS-allowed mode (today's default).
  // This keeps an unrelated `@sylveon` from waking up groudon/machamp/etc.
  const teamForce = mentions.has("team");
  const directMentions = [...mentions].filter((m) => m !== "team" && AGENTS.includes(m));
  const targetedRun = !teamForce && directMentions.length > 0;
  const targets = targetedRun ? directMentions : AGENTS;

  for (const a of targets) sseEvent(res, "thinking", { pokemon: a });

  const wrappedFor = (a) =>
    (teamForce || mentions.has(a)) ? FORCE_WRAPPER(message) : BROADCAST_WRAPPER(message);

  await Promise.all(targets.map((a) => new Promise((resolve) => {
    const child = spawnClaude({ agent: a, message: wrappedFor(a), sessionId: sessions[a] });
    let captured = "";
    let newSessionId = null;
    streamLines(child, (evt) => {
      if (evt.type === "system" && evt.subtype === "init") newSessionId = evt.session_id;
      else if (evt.type === "result") captured = evt.result || "";
    }, (code, stderr) => {
      const trimmed = captured.trim();
      if (!trimmed && code !== 0) {
        sseEvent(res, "response", {
          pokemon: a,
          summary: "[error]",
          body: stderr || `claude exited ${code}`,
          sessionId: newSessionId,
        });
      } else if (/^PASS\b/.test(trimmed)) {
        sseEvent(res, "pass", { pokemon: a, sessionId: newSessionId });
      } else {
        const m = trimmed.match(/^SUMMARY:\s*(.+?)\s*\n\s*\n([\s\S]*)$/);
        const summary = m ? m[1].trim() : trimmed.split("\n")[0].replace(/^SUMMARY:\s*/i, "").trim();
        const full = m ? m[2].trim() : trimmed;
        sseEvent(res, "response", { pokemon: a, summary, body: full, sessionId: newSessionId });
      }
      resolve();
    });

    req.on("close", () => { try { child.kill("SIGTERM"); } catch {} });
  })));

  sseEvent(res, "done", {});
  res.end();
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function handleLogAppend(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch { res.writeHead(400); res.end("bad json"); return; }
  const kind = String(body.kind || "").trim();
  if (!kind) { res.writeHead(400); res.end("missing kind"); return; }
  const id = appendMessage({
    accent:    body.accent,
    at:        Number(body.at) || Date.now(),
    hasMore:   !!body.hasMore,
    kind,
    pokemonId: body.pokemonId,
    project:   body.project || PROJECT,
    quote:     body.quote,
    sessionId: body.sessionId,
    text:      String(body.text || ""),
    who:       body.who,
  });
  sendJson(res, 200, { id: Number(id), ok: true });
}

function handleHistory(req, res, query) {
  const project = query.project ?? PROJECT;
  const before  = query.before ? Number(query.before) : undefined;
  const limit   = query.limit  ? Number(query.limit)  : 200;
  sendJson(res, 200, { entries: getHistory({ project: project || undefined, before, limit }) });
}

function handleSearch(req, res, query) {
  const q       = String(query.q || "");
  const project = query.project ?? PROJECT;
  const limit   = query.limit ? Number(query.limit) : 50;
  if (!q.trim()) return sendJson(res, 200, { results: [] });
  try {
    const results = search({ q, project: project || undefined, limit });
    sendJson(res, 200, { results });
  } catch (e) {
    // FTS5 throws on malformed match expressions ("foo:" etc) — surface as 400.
    sendJson(res, 400, { error: String(e.message || e) });
  }
}

function serveStatic(req, res) {
  let p = decodeURIComponent(url.parse(req.url).pathname);
  if (p === "/") p = "/index.html";
  if (p.endsWith("/")) p += "index.html";
  const abs = path.normalize(path.join(STATIC_ROOT, p));
  if (!abs.startsWith(STATIC_ROOT)) { res.writeHead(403); res.end("nope"); return; }
  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end("not found"); return; }
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, {
      "Cache-Control": "no-cache",
      "Content-Type": MIME[ext] || "application/octet-stream",
    });
    fs.createReadStream(abs).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const u = url.parse(req.url, true);
  if (req.method === "POST" && u.pathname.startsWith("/chat/")) {
    return handleChat(req, res, u.pathname.slice("/chat/".length));
  }
  if (req.method === "POST" && u.pathname === "/broadcast") {
    return handleBroadcast(req, res);
  }
  if (req.method === "POST" && u.pathname === "/log") {
    return handleLogAppend(req, res);
  }
  if (req.method === "GET" && u.pathname === "/history") {
    return handleHistory(req, res, u.query);
  }
  if (req.method === "GET" && u.pathname === "/search") {
    return handleSearch(req, res, u.query);
  }
  if (req.method === "GET") return serveStatic(req, res);
  res.writeHead(405); res.end("method not allowed");
});

server.listen(PORT, () => {
  console.log(`pokemon-center: http://localhost:${PORT}/   (project: ${PROJECT}, agents: ${AGENTS.join(", ")})`);
});
