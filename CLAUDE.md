# CLAUDE.md — roblox-window-monitor

**Purpose (1 line):** cron-able Node script that, for a watchlist of Roblox games, pulls CCU → volume gate → RDAP domain "window gate" → emits GREEN/YELLOW/RED/CHECK telling me whether the EMD land-grab window is still open. Free on GitHub Actions, no keys.

## Hard scope / non-goals (do NOT do these)
- **Roblox only.** Do not add non-Roblox sources.
- **Roblox-only sources, incl. discovery.** v1 was watchlist-only; **v2 (BUILT) adds chart discovery via Roblox explore-api** — still no third-party sources, no keys. See "v2 discovery" below.
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
- **Discovery (v2) — Roblox explore-api, no key (`sessionId` = any UUID):**
  - `GET https://apis.roblox.com/explore-api/v1/get-sorts?sessionId={uuid}` → list of sorts
  - `GET https://apis.roblox.com/explore-api/v1/get-sort-content?sessionId={uuid}&sortId={id}` → `{ games: [{ universeId, rootPlaceId, name, playerCount, ... }] }`
  - Game sortIds: `up-and-coming`, `top-trending`, `top-playing-now`, `fun-with-friends`, `top-revisited`. We use `up-and-coming` + `top-trending`.
  - Legacy `games.roblox.com/v1/games/sorts|list` are **404 (deprecated)** — do not use.
- Send a `User-Agent` header on every request. Wrap each call in an AbortController timeout (~15s).

## Gate thresholds + verdict semantics
Per game, `ageDays = now - created`:
- **量级门 A (new-viral):** `ageDays < NEW_GAME_MAX_AGE_DAYS (7)` AND `playing >= NEW_GAME_CCU_MIN (50000)`. Must fire on the first run (no history).
- **量级门 B (spike):** `playing >= ESTABLISHED_CCU_MIN (20000)` AND `(playing - rollingAvg)/rollingAvg*100 >= SPIKE_PCT (200)`; `rollingAvg` = avg of **PRIOR** stored samples only.
- **量级门 C (fresh-com, 跟随信号 — intel only, do NOT treat as entry signal):** `{slug}.com` registered AND registration age `< FRESH_REG_DAYS (14)` → someone is actively grabbing this brand → fires regardless of CCU/spike. One batched RDAP `.com` check per pooled game every run (8-concurrent). RDAP unresolved → silent non-fire + one summary warn (no CHECK spam). `.com` available → printed in a "Free .coms" list only, NOT a candidate/email (junk slugs are often free; a *paid* fresh registration self-validates the slug). Rationale: gate B structurally misses steady climbers (rolling avg chases growth) — proven by missed Violence District & Clean the Supermarket grabs, 2026-06/07. **2026-07-04 demotion:** a template pipeline operator (title pattern "X Wiki, Codes, Tier List and Tools") registers AND deploys same-day (reg→first TLS cert 0-1d, verified via crt.sh), so by the time gate C fires the window is already closed for head-on entry.
- **量级门 D (young-chart, 前置主信号):** `ageDays <= GATE_D_MAX_AGE_DAYS (60)` AND `playing >= GATE_D_CCU_MIN (20000)` → fires every run regardless of domain state; the window gate then decides. Rationale (2026-07-04 backtest, evidence in `indie-builder-brain/keywords/paint or seek.md`): the pipeline operator works off the same charts, publish→his-registration = 13-29d on fresh games, and this monitor's first-seen beat his registration in 3 of 4 live races — the detection was in hand, only gate C waited for HIS move. Gate D runs his playbook one step ahead.
- None of A/B/C/D → **QUIET** (just record sample).
- **窗口门 (candidates only):** RDAP-check `{slug}.com` and `{slug}.net`:
  - any available (404) → **GREEN**
  - both taken, oldest registration age ≤ `FRESH_DAYS (3)` → **YELLOW**
  - both taken, oldest age ≥ `STALE_DAYS (10)` → **RED**
  - both taken, age in between → **YELLOW**
  - RDAP could not resolve → **CHECK** (NEVER promote uncertainty to GREEN)
- **GREEN post-check (site probe):** if verdict is GREEN but `{slug}.com` is registered, GET `https://{slug}.com` and classify: real `<title>` → **built** → demote to RED with the title in detail (competitor already live; net-only entry is a losing race); no title / parking-page title / NXDOMAIN → **parked** → stays GREEN (the 1mineperclick pattern: paid .com + no site = self-validated demand, net window open); 403/429/timeout → **unknown** → demote to CHECK (uncertainty never stays GREEN).
- `slug` = watchlist entry, else auto-derive = name lowercased, alphanumeric only.
- **Every threshold overridable by an env var of the same name.**

## Robustness
- Per-game failures caught + logged (warn), never crash the whole run.
- Keep only the last `HISTORY_MAX (36)` samples per game.
- Write `state/monitor-state.json` (history + lastVerdict per game) and `state/alerts.json` (this run's candidates). Print `console.table` + actionable-candidates block.
- **Datacenter-IP hardening (decided risk, not in original spec):** Roblox can throttle/challenge Azure IPs (GitHub Actions). Mitigations baked in: browser-ish `User-Agent`/`Accept`, retry on 403/429/5xx with jittered backoff (`RETRIES`, default 2), and an explicit **`API_BLOCKED`** banner so a block never reads as "all clear" (`getJson` treats 403/429 and non-JSON bot-challenge bodies as `BlockedError`). RDAP nulls stay → CHECK (safe).

## Plan of record (how this was deployed)
- **Primary = local launchd on the Mac mini** (since 2026-07-06). GitHub Actions wasn't IP-blocked, but GitHub throttled the `15,45 * * * *` cron to ~5h gaps — unusable for hour-scale gate D races. `run-monitor.sh` (git pull --rebase → `SPIKE_PCT=100 node monitor.mjs` → commit+push `state/`) driven by `com.yy.roblox-window-monitor.monitor.plist` at :15/:45, `StartCalendarInterval` (missed runs coalesce into one catch-up on wake; Mac mini is `pmset sleep 0` anyway) + `RunAtLoad` (covers reboots). Logs → `~/Library/Logs/roblox-window-monitor.monitor.log`. Push auth = local git creds (user forpix-mini). Install: `cp` plist to `~/Library/LaunchAgents/` + `launchctl load` (no secrets in it).
- **Fallback = manual `workflow_dispatch`** of `monitor.yml` (schedule removed, job kept intact) if the mini is down.

## Workflow (.github/workflows/monitor.yml)
- `on: workflow_dispatch:` only (schedule removed 2026-07-06, see plan of record).
- `permissions: contents: write`. `concurrency: { group: monitor, cancel-in-progress: false }`.
- checkout → setup-node@v4 (node 20) → `node monitor.mjs` → commit `state/` back as `github-actions[bot]` only if changed (`[skip ci]` in message).
- `state/` MUST be committed back, not gitignored (it's the CCU history — local runs commit it the same way).

## Verification command (must actually run + show output)
```sh
NEW_GAME_CCU_MIN=1000 NEW_GAME_MAX_AGE_DAYS=9999 \
  STATE_FILE=/tmp/s.json ALERTS_FILE=/tmp/a.json node monitor.mjs
```
Expect: row for "Grow a Garden 2", real CCU (hundreds of thousands), verdict **RED** (.com/.net registered well over 10 days ago). CHECK/GREEN there = RDAP parsing wrong → fix. Then run with defaults → confirm **QUIET** (no false alarm).

## Watchlist seed
`[{ placeId: 97598239454123, slug: "growagarden2" }]` (Grow a Garden 2).

## v2 discovery — spike radar (BUILT)
Key empirical finding that shaped the design: **Roblox charts don't surface <7-day games** (youngest charted ≈ 24d; 0 under 7d in a live sample). So discovery can't serve the original "first-grab a brand-new game's EMD" use case directly. Decision (①+③):
- **Discovery feeds gate B (spike), age-agnostic** — flags charted games whose CCU jumps ≥ `SPIKE_PCT` vs their rolling avg. Needs a few cron runs to build a baseline before it can fire (first sighting → no history → QUIET, expected).
- **gate A (age<7 & CCU≥50k) stays for the pinned WATCHLIST** — true first-grab GREENs you add by hand (games found via social, not charts).
- Pool = `up-and-coming` + `top-trending`, prefiltered `playerCount ≥ DISCOVERY_CCU_MIN`, merged with WATCHLIST (pinned wins), deduped by universeId, age/CCU via the existing `games?universeIds=` batch (chunked at 100).
- Discovered games auto-pruned from state after `DISCOVERY_TTL_HOURS` (24h) absent from charts; pinned kept forever.
- `deriveSlug()` extracts core brand from decorated names (strip `[..]/(..)/{..}`, cut at `: | •`): "Fisch 🏖️ [FISCHFEST]" → `fisch`, "BedWars [SUMMER WARS]" → `bedwars`. Still imperfect — **GREEN on a junk slug = noise, not opportunity**; eyeball the slug before acting.
- New env: `DISCOVER` (0 = watchlist-only), `DISCOVERY_SORTS`, `DISCOVERY_CCU_MIN` (default = `ESTABLISHED_CCU_MIN`), `DISCOVERY_TTL_HOURS`, `SESSION_ID`.
- **Main tuning knob = `SPIKE_PCT`** (default 200 = 3×). Watch the `spike%` table column over the first days; lower it if the radar is too quiet.
- Output: prints pinned + candidates + the 5 hottest movers (by spike%) so the threshold is tunable against live data.

## Alerting — local email (BUILT, `alert.py` + launchd)
Detection (cloud Actions) and notification (local) are separate, so the cloud repo stays secret-free.
- **`alert.py`** (Python stdlib, no deps): `git pull` → find NEW GREEN/YELLOW → email via the **same Gmail-SMTP setup as game-monitor** (`GM_SMTP_USER`/`GM_SMTP_PASS` app password/`GM_MAIL_TO`, missing creds → silently skip). `--print` mode pulls + prints recent actionable candidates, no email.
- **Transient-candidate handling**: gate B candidates only appear in the run their spike fires, so `alert.py` scans the **git history** of `state/alerts.json` since the last processed commit (tracked in gitignored `.alert-seen.json`), not just the latest file → never misses one between polls. Dedups by name+verdict so a standing GREEN isn't re-mailed; first run = latest commit only (no historical flood).
- **`com.yy.roblox-window-monitor.plist`**: launchd LaunchAgent, runs `alert.py` hourly (StartCalendarInterval Minute=0; was 4h — gate D races are hour-scale) on the always-on Mac mini. Committed with placeholder `GM_SMTP_*`; real creds live only in the installed copy under `~/Library/LaunchAgents` (mirror them from `com.yy.game-monitor.plist`). Activate: `cp` to `~/Library/LaunchAgents/` + `launchctl load`.
- Emails GREEN+YELLOW only; RED/CHECK are not sent.

## v3 ideas (NOT built)
Smarter slug/brand extraction; per-source gate thresholds; instant alerting (current email latency = up to 4h, bounded by the local cron; would need cloud email + a GitHub Secret); gate C extensions — `{slug}.wiki` freshness as a forward scout (VD case: .wiki registered 6d before .com, would turn gate C into a first-mover signal; costs +1 rdap.org call/game) and promoting the print-only free-.com list to email once its noise level is known.
