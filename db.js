// Shared chat-history store. SQLite + FTS5 for ranked full-text search.
// Lives at ~/.pokemon-center/arena.db so it persists across projects/runs.

import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DB_DIR = path.join(os.homedir(), ".pokemon-center");
const DB_PATH = process.env.ARENA_DB || path.join(DB_DIR, "arena.db");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         INTEGER NOT NULL,
    project    TEXT NOT NULL,
    session_id TEXT,
    kind       TEXT NOT NULL,
    who        TEXT,
    accent     TEXT,
    pokemon_id TEXT,
    text       TEXT NOT NULL,
    quote      TEXT,
    has_more   INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_messages_ts            ON messages(ts);
  CREATE INDEX IF NOT EXISTS idx_messages_project_ts    ON messages(project, ts);
  CREATE INDEX IF NOT EXISTS idx_messages_pokemon_ts    ON messages(pokemon_id, ts);

  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    text, quote, who,
    content='messages',
    content_rowid='id',
    tokenize='porter unicode61'
  );

  CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, text, quote, who)
    VALUES (new.id, new.text, COALESCE(new.quote,''), COALESCE(new.who,''));
  END;
  CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text, quote, who)
    VALUES ('delete', old.id, old.text, COALESCE(old.quote,''), COALESCE(old.who,''));
  END;
  CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text, quote, who)
    VALUES ('delete', old.id, old.text, COALESCE(old.quote,''), COALESCE(old.who,''));
    INSERT INTO messages_fts(rowid, text, quote, who)
    VALUES (new.id, new.text, COALESCE(new.quote,''), COALESCE(new.who,''));
  END;
`);

const insertStmt = db.prepare(`
  INSERT INTO messages (ts, project, session_id, kind, who, accent, pokemon_id, text, quote, has_more)
  VALUES (@ts, @project, @session_id, @kind, @who, @accent, @pokemon_id, @text, @quote, @has_more)
`);

// Convert a DB row back into the entry shape the client renders.
function rowToEntry(r) {
  return {
    accent:    r.accent || undefined,
    at:        r.ts,
    hasMore:   !!r.has_more,
    id:        r.id,
    kind:      r.kind,
    pokemonId: r.pokemon_id || undefined,
    project:   r.project,
    quote:     r.quote || undefined,
    text:      r.text,
    who:       r.who || undefined,
  };
}

export function appendMessage(entry) {
  const info = insertStmt.run({
    accent:     entry.accent || null,
    has_more:   entry.hasMore ? 1 : 0,
    kind:       entry.kind,
    pokemon_id: entry.pokemonId || null,
    project:    entry.project,
    quote:      entry.quote || null,
    session_id: entry.sessionId || null,
    text:       entry.text || "",
    ts:         entry.at || Date.now(),
    who:        entry.who || null,
  });
  return info.lastInsertRowid;
}

// Most-recent N entries, returned in chronological order so the client can replay top→bottom.
export function getHistory({ project, before, limit = 200 } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 200, 1), 2000);
  const where = [];
  const params = {};
  if (project) { where.push("project = @project"); params.project = project; }
  if (before)  { where.push("ts < @before");       params.before  = Number(before); }
  const sql = `
    SELECT * FROM messages
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY ts DESC, id DESC
    LIMIT ${cap}
  `;
  const rows = db.prepare(sql).all(params).reverse();
  return rows.map(rowToEntry);
}

// FTS5 ranked search. Returns rows newest-first within rank, with a snippet.
export function search({ q, project, limit = 50 } = {}) {
  if (!q || !q.trim()) return [];
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 500);
  const where = ["messages_fts MATCH @q"];
  const params = { q: q.trim() };
  if (project) { where.push("m.project = @project"); params.project = project; }
  const sql = `
    SELECT m.*,
           snippet(messages_fts, 0, '<mark>', '</mark>', '…', 12) AS snippet,
           bm25(messages_fts) AS rank
    FROM messages_fts
    JOIN messages m ON m.id = messages_fts.rowid
    WHERE ${where.join(" AND ")}
    ORDER BY rank ASC, m.ts DESC
    LIMIT ${cap}
  `;
  return db.prepare(sql).all(params).map((r) => ({
    ...rowToEntry(r),
    rank:    r.rank,
    snippet: r.snippet,
  }));
}

export function close() { db.close(); }
