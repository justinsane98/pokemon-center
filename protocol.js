// Wire protocol between agents and the server.
//
// Every agent reply is shaped:
//
//   SUMMARY: <one short line>
//
//   <free-form body, in character>
//
//   ---
//   STATUS: done | blocked | needs_input | working
//   TO: @flareon                # only when STATUS=needs_input
//   LINEAR: DAK-1234             # subtask id, when applicable
//
// The leading SUMMARY/body shape already exists (see server.js BROADCAST_WRAPPER).
// The trailer is new and is what lets the server route deterministically instead
// of inferring intent from prose. Trailer is OPTIONAL — agents in chat mode just
// omit it and behave as before.

const VALID_STATUSES = new Set(["done", "blocked", "needs_input", "working"]);

// Trailer is the LAST `---`-fenced block where every non-blank line is a
// KEY: value pair. If the lines after the final `---` don't all look like
// trailer fields, the agent is using `---` for prose separation and we
// leave it alone.
const SEPARATOR_RE = /\n[ \t]*-{3,}[ \t]*\n/g;
const KV_RE = /^([A-Z_]+)\s*:\s*(.*)$/;

function findTrailerStart(src) {
  let last = -1;
  let lastEnd = -1;
  for (const m of src.matchAll(SEPARATOR_RE)) {
    last = m.index;
    lastEnd = m.index + m[0].length;
  }
  return last === -1 ? null : { sepStart: last, contentStart: lastEnd };
}

// Pulls a {status, to, linear, raw} record out of an agent reply. Returns
// `null` for the trailer fields when no trailer is present so callers can
// branch on `parsed.status === null`.
export function parseTrailer(text) {
  const src = String(text || "");
  const found = findTrailerStart(src);
  if (!found) return { body: src.trimEnd(), status: null, to: null, linear: null, raw: null };

  const block = src.slice(found.contentStart).trimEnd();
  const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length || !lines.every((l) => KV_RE.test(l))) {
    // Looks like prose, not a trailer.
    return { body: src.trimEnd(), status: null, to: null, linear: null, raw: null };
  }

  const out = { body: src.slice(0, found.sepStart).trimEnd(), status: null, to: null, linear: null, raw: block };
  for (const line of lines) {
    const kv = line.match(KV_RE);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const val = kv[2].trim();
    if (key === "status") {
      const v = val.toLowerCase();
      if (VALID_STATUSES.has(v)) out.status = v;
    } else if (key === "to") {
      out.to = val.replace(/^@/, "").toLowerCase() || null;
    } else if (key === "linear") {
      out.linear = val || null;
    }
  }

  // needs_input without a TO target is meaningless; downgrade to blocked so
  // it bubbles to kyogre instead of getting silently dropped.
  if (out.status === "needs_input" && !out.to) out.status = "blocked";

  return out;
}

// Parse a full agent reply: extracts SUMMARY (first line), body, and trailer.
// SUMMARY parsing mirrors the existing logic in handleBroadcast so the two
// paths agree. Returns:
//   { summary, body, status, to, linear }
// where `body` excludes both the SUMMARY line and the trailer block.
export function parseAgentReply(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return { summary: "", body: "", status: null, to: null, linear: null };

  const trailer = parseTrailer(trimmed);
  const withoutTrailer = trailer.body;

  const m = withoutTrailer.match(/^SUMMARY:\s*(.+?)\s*\n\s*\n([\s\S]*)$/);
  if (m) {
    return {
      summary: m[1].trim(),
      body: m[2].trim(),
      status: trailer.status,
      to: trailer.to,
      linear: trailer.linear,
    };
  }
  // No blank line after SUMMARY → treat first line as summary, rest as body.
  const firstNl = withoutTrailer.indexOf("\n");
  if (firstNl === -1) {
    return {
      summary: withoutTrailer.replace(/^SUMMARY:\s*/i, "").trim(),
      body: withoutTrailer,
      status: trailer.status,
      to: trailer.to,
      linear: trailer.linear,
    };
  }
  return {
    summary: withoutTrailer.slice(0, firstNl).replace(/^SUMMARY:\s*/i, "").trim(),
    body: withoutTrailer.slice(firstNl + 1).trim(),
    status: trailer.status,
    to: trailer.to,
    linear: trailer.linear,
  };
}
