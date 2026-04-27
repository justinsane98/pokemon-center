# Pokémon Center

A 9-agent themed Claude Code team with a top-down web UI. Click a sprite to chat with one agent. Type in the bottom panel to broadcast to the whole team. `@-mention` someone to force a response.

Each agent is a `claude --print --agent <id>` session with its own persona, accent color, and (optional) sprite. Conversations stream live, persist locally, and survive page refresh.

![](docs/screenshot.png)

## What this is

A web-app frontend on top of the [Claude Code CLI](https://claude.com/claude-code), shipping an example team of 9 personas (PM, Frontend, Backend, Security, QA, DevOps, Devil's Advocate, Designer, Researcher). The example is themed as Pokémon, but the architecture is generic, you can ship any team you want by editing `config.json` and dropping persona files into `~/.claude/agents/`.

**Auth model**: uses your local `claude` CLI's keychain credentials (Claude Max or Pro plan, OAuth-based). **No API keys are stored in this repo.** If you don't have a Max/Pro subscription, you can swap the auth model to use `ANTHROPIC_API_KEY`, but that's not the default and isn't recommended (different billing).

## Quick start (5 minutes)

1. **Install the Claude Code CLI**, if you don't already have it:
   ```sh
   npm install -g @anthropic-ai/claude-code
   ```
   Or follow the [official install guide](https://docs.claude.com/en/docs/claude-code/quickstart).

2. **Authenticate** with your Claude Max or Pro account (one-time):
   ```sh
   claude
   ```
   This opens a browser window for OAuth. Once you see a working `claude` REPL, you're good. `Ctrl+C` to exit; we don't need the REPL itself.

3. **Clone this repo and install** the example personas into your global agents directory:
   ```sh
   git clone https://github.com/justinsane98/pokemon-center.git
   cd pokemon-center
   mkdir -p ~/.claude/agents
   cp agents/*.md ~/.claude/agents/
   ```

4. **Run the server** (no npm install needed, stdlib-only Node):
   ```sh
   node server.js
   ```

5. **Open** [http://localhost:8765/](http://localhost:8765/). Click any sprite, type a message, watch the agent respond in their voice.

## Customizing the team

The single source of truth is `public/config.json`. To swap teams:

1. **Edit `public/config.json`**, change the `roster` array. Each entry needs:
   - `id`, must match a file at `~/.claude/agents/<id>.md`
   - `name`, `role`, `accent` (hex color), `greet`
   - `pos`, `{x, y}` as percentages of the building image (where on the floor plan they stand)
   - `avatar`, `{scale, originX, originY}` to frame their face in the modal's circular avatar
   - optional `size`, sprite size as % of building width (default 7%)

2. **Drop sprite PNGs** at `public/sprites/<id>.png` (one per agent in your roster). 96×96 is what the example uses, but anything pixel-art-ish works.

3. **Drop persona files** at `~/.claude/agents/<id>.md`. Use `agents/_template.md` as a starting point. The persona's `description` line and identity/voice rules drive how the agent talks; the `Lane expertise` section defines what they're good at.

4. **(Optional) replace the building image and grass tile** at `public/building.png` and `public/varied_grass.png`. The current building is a 1501×1047 ChatGPT-generated 9-room office floor plan. If you change dimensions, the agent positions in `config.json` are still relative percentages so they'll still land in roughly the right spots.

5. **Restart** the server. That's it.

## How agents respond

- **Direct chat** (click a sprite): the agent gets your message verbatim and replies in full, streamed live.
- **Broadcast** (type in bottom chat panel): every agent gets the message wrapped with a relevance check, "If this isn't in your lane, respond with `PASS`. Otherwise, line 1 must be `SUMMARY: <one short line>`, blank line, full response." Agents that PASS go silent; agents that respond send a summary (used for the bubble + chat log) plus a full body (visible in their modal).
- **`@mention`**: typing `@bulbasaur` (or whatever id) forces that agent to respond, no PASS allowed. `@team` forces all of them.

## How conversations persist

- Each agent has its own Claude session ID (returned on first turn, reused on subsequent turns via `--resume`). Stored in `localStorage["arena.sessions"]`.
- Full transcripts per agent in `localStorage["arena.transcripts"]`.
- Group chat log in `localStorage["arena.log"]` (capped at last 200 entries).
- Last-read timestamp per agent in `localStorage["arena.lastRead"]` (drives unread-bubble counts).
- Chat panel height in `localStorage["arena.chatHeight"]`.

To wipe everything: open devtools → `localStorage.clear()`. The Claude session histories on Anthropic's side are NOT deleted by this; only the local pointers.

## Configuration knobs

Environment variables for `server.js`:

| Var | Default | Effect |
|---|---|---|
| `PORT` | `8765` | HTTP port |
| `ARENA_CWD` | `$HOME` | Working directory each spawned `claude` runs in. Default lets agents read/grep across any project under `~/`. Set to a specific path to scope tighter. |

`public/config.json` keys:

| Key | Effect |
|---|---|
| `roster` | List of agents, see "Customizing the team" |
| `decor` | Outdoor decoration sprites positioned around the building |
| `padMult` | Stage size as a multiple of the building image (3 = lots of grass to pan into) |
| `decorScale` | Scale factor for decoration sprites |
| `spriteDir` | URL prefix for agent sprite PNGs (default `/sprites`) |
| `buildingSrc` | Path to the floor plan image |

## Browser support

Modern Chromium / Safari / Firefox. Uses CSS `color-mix()`, `subgrid`, `1lh` units, fetch streams, and `localStorage`. Tested on macOS Safari and Chrome.

## Limitations

- Cold-start latency: each turn pays ~1-3s of `claude` CLI startup. Broadcasts pay this cost in parallel across all 9 agents.
- The agent's full conversation tree (tool calls, sub-agent invocations) doesn't render here, only the final text response per turn. The full session is still readable via `claude --resume <session-id>` in your terminal if you want it.
- Pokémon sprites in `public/sprites/` are property of Nintendo / Game Freak / The Pokémon Company. They're included as a fan-project example; if you fork to host this anywhere serious, swap them with your own art.

## License

MIT, see [LICENSE](./LICENSE).

The included personas, building image, and code are MIT-licensed. The Pokémon sprite images are not, see "Limitations" above.
