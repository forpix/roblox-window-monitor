# CLAUDE.md — roblox-window-monitor

**Purpose (1 line):** cron-able Node script that, for a watchlist of Roblox games, pulls CCU → volume gate → RDAP domain "window gate" → emits GREEN/YELLOW/RED/CHECK telling me whether the EMD land-grab window is still open. Free on GitHub Actions, no keys.

## Hard scope / non-goals (do NOT do these)
- **Roblox only.** Do not add non-Roblox sources.
- **Watchlist-based only.** Do NOT build auto-discovery / charts-scraping. That is **v2, not built — validate v1 first.**
- **Zero npm dependencies.** Node 20, global `fetch`, ESM (`.mjs`). No `package.json` required.
- **No secrets** (Roblox + RDAP need none). If a keyed source is ever added, use GitHub Secrets — but not now.
- If `monitor.mjs` exists, it is the source of truth: fix bugs verification surfaces, do not rewrite.

## API contracts (use EXACTLY these; do not guess endpoints/fields)
- **placeId → universeId:** `GET https://apis.roblox.com/universes/v1/places/{placeId}/universe` → `{ universeId }`
- **CCU batch:** `GET https://games.roblox.com/v1/games?universeIds={csv}` → `{ data: [{ id, rootPlaceId, name, playing, created, updated, ... }] }`. `playing` = concurrent players; `created` = ISO date used for age.
- **RDAP domain check:**
  - `.com` → `https://rdap.verisign.com/com/v1/domain/{domain}`
  - `.net` → `https://rdap.verisign.com/net/v1/domain/{domain}`
  - other TLD → `https://rdap.org/domain/{domain}`
  - HTTP **404 = available**; **200 = registered**. Registration date = `events[]` item where `eventAction === "registration"`, field `eventDate`.
- Send a `User-Agent` header on every request. Wrap each call in an AbortController timeout (~15s).

## Gate thresholds + verdict semantics
Per game, `ageDays = now - created`:
- **量级门 A (new-viral):** `ageDays < NEW_GAME_MAX_AGE_DAYS (7)` AND `playing >= NEW_GAME_CCU_MIN (50000)`. Must fire on the first run (no history).
- **量级门 B (spike):** `playing >= ESTABLISHED_CCU_MIN (20000)` AND `(playing - rollingAvg)/rollingAvg*100 >= SPIKE_PCT (200)`; `rollingAvg` = avg of **PRIOR** stored samples only.
- Neither → **QUIET** (just record sample).
- **窗口门 (candidates only):** RDAP-check `{slug}.com` and `{slug}.net`:
  - any available (404) → **GREEN**
  - both taken, oldest registration age ≤ `FRESH_DAYS (3)` → **YELLOW**
  - both taken, oldest age ≥ `STALE_DAYS (10)` → **RED**
  - both taken, age in between → **YELLOW**
  - RDAP could not resolve → **CHECK** (NEVER promote uncertainty to GREEN)
- `slug` = watchlist entry, else auto-derive = name lowercased, alphanumeric only.
- **Every threshold overridable by an env var of the same name.**

## Robustness
- Per-game failures caught + logged (warn), never crash the whole run.
- Keep only the last `HISTORY_MAX (36)` samples per game.
- Write `state/monitor-state.json` (history + lastVerdict per game) and `state/alerts.json` (this run's candidates). Print `console.table` + actionable-candidates block.
- **Datacenter-IP hardening (decided risk, not in original spec):** Roblox can throttle/challenge Azure IPs (GitHub Actions). Mitigations baked in: browser-ish `User-Agent`/`Accept`, retry on 403/429/5xx with jittered backoff (`RETRIES`, default 2), and an explicit **`API_BLOCKED`** banner so a block never reads as "all clear" (`getJson` treats 403/429 and non-JSON bot-challenge bodies as `BlockedError`). RDAP nulls stay → CHECK (safe).

## Plan of record (how this was deployed)
- **Primary = GitHub Actions** (this repo's `monitor.yml`). Strategy: ship → manual `workflow_dispatch` once → read logs to see if datacenter IP is actually blocked (it's a *risk*, not confirmed; can't be tested from a local residential IP).
- **Fallback if Actions is persistently blocked = local cron/launchd** on macOS, running the *same* `monitor.mjs` from a residential IP. Use **launchd `StartCalendarInterval`** (not crontab — it re-runs missed jobs on wake; multi-day window tolerates the gap) and add a delivery path (macOS notification + logfile) since stdout otherwise vanishes. Not built yet — only if Actions fails the test.

## Workflow (.github/workflows/monitor.yml)
- `on: schedule: cron "0 */2 * * *"` + `workflow_dispatch`.
- `permissions: contents: write`. `concurrency: { group: monitor, cancel-in-progress: false }`.
- checkout → setup-node@v4 (node 20) → `node monitor.mjs` → commit `state/` back as `github-actions[bot]` only if changed (`[skip ci]` in message).
- `state/` MUST be committed back, not gitignored (it's the CCU history).

## Verification command (must actually run + show output)
```sh
NEW_GAME_CCU_MIN=1000 NEW_GAME_MAX_AGE_DAYS=9999 \
  STATE_FILE=/tmp/s.json ALERTS_FILE=/tmp/a.json node monitor.mjs
```
Expect: row for "Grow a Garden 2", real CCU (hundreds of thousands), verdict **RED** (.com/.net registered well over 10 days ago). CHECK/GREEN there = RDAP parsing wrong → fix. Then run with defaults → confirm **QUIET** (no false alarm).

## Watchlist seed
`[{ placeId: 97598239454123, slug: "growagarden2" }]` (Grow a Garden 2).

## v2 (NOT built — validate v1 first)
Auto-discovery / charts-scraping to populate the watchlist automatically. Explicitly out of scope until v1 is proven.
