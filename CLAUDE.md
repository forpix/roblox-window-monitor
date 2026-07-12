# CLAUDE.md — roblox-window-monitor

**Purpose (1 line):** cron-able Node script that, for a watchlist of Roblox games, pulls CCU → volume gate → RDAP domain "window gate" → emits GREEN/YELLOW/RED/CHECK telling me whether the EMD land-grab window is still open. Free on GitHub Actions, no keys.

## Hard scope / non-goals (do NOT do these)
- **Roblox only.** Do not add non-Roblox sources. **Carve-out (2026-07-13, Part A of
  `indie-builder-brain/briefs/2026-07-12-sitemap-discovery-radar.md`):** `guide-sitemap-monitor.mjs`
  deliberately watches three third-party Roblox-codes sites (TryHardGuides/Beebom/Dexerto) — allowed
  because it's a pure side-channel reference signal, wired into nothing (`monitor.mjs`'s gate
  computation and `state/alerts.json` are untouched), same discipline as S6's `sitemap-monitor.mjs`
  being a separate exploratory collector. `monitor.mjs` itself still adds zero non-Roblox sources —
  that constraint stands for the core gate script. See "Guide-sites codes/wiki radar" below.
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
- **File lock (2026-07-13, added alongside guide-sitemap-monitor.mjs):** `run-monitor.sh` now acquires
  an mkdir-based lock (`/tmp/roblox-window-monitor.runlock`, stale after 600s, gives up after 30×2s
  tries and skips the run rather than hanging) before touching `state/` — `run-guide-monitor.sh` uses
  the identical `LOCK_DIR`, so the two local runners never race on the same `state/` commit. No
  `flock` dependency (macOS doesn't ship it); mkdir is atomic on all POSIX filesystems.

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

## Sitemap discovery radar (BUILT, 2026-07-12 — exploratory, not wired into gates yet)
**Purpose:** test whether Roblox's own SEO sitemap surfaces new games earlier than the
explore-api charts do (which have a known blind spot: youngest charted ≈ 24d, nothing
under 7d — see v2 discovery above). This is a **hypothesis under test**, not a confirmed
signal — needs several weeks of accumulated history before drawing conclusions.

- **Source:** `https://www.roblox.com/sitemap-games.xml` (declared in `robots.txt`, Roblox's
  own resource — still "Roblox only", no third-party site added). It's a sitemap **index**
  with 10 shards (`sitemap-games-N.xml`), ~1000 URLs each, ~10,000 games total. **No `lastmod`
  field** — can't tell when an entry was added, only whether it's currently present. Sampled
  ordering mixes very-old and very-new placeIds — this looks like Roblox's own internal
  "worth indexing" quality/relevance score, **not** a chronological or full dump (Roblox has
  tens of millions of games; this sitemap is a curated ~10k).
- **`sitemap-monitor.mjs`:** fetch all 10 shards → parse `{placeId, slug}` from each `<loc>`
  → diff against `state/sitemap-known.json`'s previous placeId set → newly-appeared placeIds
  get enriched (universeId → CCU/age via the same Roblox games API `monitor.mjs` uses) and
  appended to `state/sitemap-newly-seen.jsonl` (append-only, one JSON object per line: `seenAt,
  placeId, slug, universeId, name, playing, createdAt, ageDaysAtDiscovery`). **Cold start
  (no prior `sitemap-known.json`) only establishes the baseline and reports 0 new** — "the
  first run says everything is new" carries no information, so it's suppressed by design.
- **Known open question / risk:** since the sitemap looks rank-cutoff-based rather than a
  stable membership list, games may churn in/out of the top-~10k across polls even when the
  underlying "genuinely new game" rate is low — expect some noise in the newly-seen log,
  especially in the first weeks. Don't treat every "new" entry as a fresh game without
  checking `ageDaysAtDiscovery`.
- **Not yet done:** cross-referencing `sitemap-newly-seen.jsonl` timestamps against
  `monitor-state.json`'s own discovery/gate timestamps to actually answer "did sitemap beat
  explore-api on any of these" — needs enough accumulated history first. Not wired into
  gate A–D or `alert.py`; this is a pure data-collection component for now.
- **Deployment:** `.github/workflows/sitemap-monitor.yml`, real `schedule: cron` (every 6h,
  offset from `monitor.yml`'s :15/:45) — unlike gate D, this is a day-scale question, so
  GitHub's cron throttling (which forced `monitor.yml` back to local launchd) is a non-issue
  here; no need to run this on the Mac mini.
- **Test:** `test-sitemap-regression.mjs` — offline, stubbed `fetch`, asserts cold-start
  suppression + diff/enrichment correctness + the three Part 0.2 fixes below.
  `node test-sitemap-regression.mjs`.

**Part 0.2 fixes (2026-07-13, indie-builder-brain/briefs/2026-07-12-sitemap-discovery-radar.md):**
- **A partial shard failure no longer overwrites the baseline.** `fetchAllGameEntries()` now
  reports `{entries, expectedShards, succeededShards}`; unless every shard succeeded this run,
  `sitemap-known.json` is left untouched and the process sets `process.exitCode = 1` (not
  `process.exit()`, so it stays test-harness-safe) — otherwise a shard that failed one run and
  recovered the next would have its placeIds misread as "newly launched". A health record is
  still appended to `state/sitemap-source-runs.jsonl` either way (`ok`/`partial`/`error`,
  `sourceKey: "roblox-sitemap"`, same schema as Part 0.1's `discovery-source-runs.jsonl` and
  A.6's `guide-source-runs.jsonl`), so the failure itself is traceable to Part C even when
  nothing else got persisted.
- **`first_seen` vs `reentered` are now tracked separately.** `sitemap-known.json` used to hold
  one `placeIds` array that got wholesale-replaced every run, so a placeId that dropped off and
  came back looked "new" again. It now holds `currentPlaceIds` (last run's snapshot, used for the
  removed/reentered diff) and `everSeenPlaceIds` (accumulates forever, used for the first_seen
  check) — old files with only `placeIds` migrate automatically (both fields seed from it on
  first read). `state/sitemap-newly-seen.jsonl` entries now carry `eventType: 'first_seen' |
  'reentered'`.
- **The GitHub Actions workflow** (`sitemap-monitor.yml`) no longer does a bare
  `git add state/sitemap-known.json state/sitemap-newly-seen.jsonl` — that fails atomically
  (exit 128, nothing staged at all) whenever `newly-seen.jsonl` doesn't exist yet (no new pages
  this run), silently dropping the `known.json` update too. It now only adds paths that exist,
  runs with `if: always()` (so the health record still gets committed even when the fetch step
  above exited non-zero), and retries `git pull --rebase && git push` up to 3 times with jittered
  backoff — the local Mac mini runner (`monitor.mjs`) and this GH-Actions-only job can both touch
  `state/` around the same time, and unlike `monitor.mjs`/A-class (same-machine file lock),
  nothing local can coordinate with a job running on a GitHub-hosted runner.

## Discovery/gate event log (BUILT, 2026-07-13 — Part 0.1 of indie-builder-brain/briefs/2026-07-12-sitemap-discovery-radar.md)
**Purpose:** `state[key]` only has `lastSeen`/`lastVerdict` — discovered (non-pinned) games older than
`DISCOVERY_TTL_HOURS` get deleted outright, so there was no durable "explore-api first saw this at
HH:MM" / "gate D first fired at HH:MM" record. That cross-project "who found it first" comparison
(sitemap vs A-class guide sites vs explore-api vs gate thresholds) needs one. This layer is purely
additive — it does not read back into gate/verdict computation, only decides what to log.

- **Files:** `state/discovery-events.jsonl` (`source_first_seen`, written the instant a sortId's own
  `get-sort-content` call succeeds — does not wait on the games-batch call), `state/gate-events.jsonl`
  (`gate_first_seen`, written after the games-batch call + gate computation succeeds), both dedup'd
  forever (`source_first_seen` by `(universeId,sortId)`, `gate_first_seen` by `(universeId,gate letter)`
  — independent of the unrelated `DISCOVERY_TTL_HOURS` prune of `state`, so a TTL'd-then-reappearing
  game does NOT get a second first_seen). `state/discovery-source-runs.jsonl` — per-run health
  (`ok`/`partial`/`error`) for `explore-sort:{sortId}` and `games-batch` separately (games-batch is
  `partial` when some but not all 100-id chunks failed, `error` when all did).
- **Cold-start baseline:** first-ever pre-existing games must not read as "discovered today". Each
  sortId writes `source_baseline` (`leftCensored:true`) instead of `source_first_seen` on its own
  first successful call (whatever round that turns out to be); the gate layer likewise writes
  `gate_baseline` on the first games-batch run where **every** chunk succeeds (a partial run must not
  complete gate bootstrap, even for the targets that did come back clean — see brief for the "why").
  Bootstrap completion is tracked in `state/discovery-bootstrap.json`, one flag per sortId + one for
  the whole gate layer — **not** inferred from whether any baseline event exists in the log, because a
  sortId's first successful call can legitimately return zero eligible games (nothing to baseline),
  which would otherwise leave no trace to mark it bootstrapped and re-trigger bogus rebootstrapping
  forever. `everSeenSourceKeys`/`everGatedKeys` (the actual dedup sets) are rebuilt fresh from the
  event log every run instead of trusted from a snapshot, so a mid-write crash can't desync them.
- **Pool completeness (2026-07-13 fix):** completing gate-layer bootstrap additionally requires the
  target pool itself to have been complete that run — every sort call AND every watchlist resolution
  succeeded — not just a fully-ok games-batch. A failed sort's exclusive games aren't in the pool at
  all, so a gate baseline built without them would misread them as `gate_first_seen` once the sort
  recovers (same left-censoring class the per-sortId bootstrap prevents, one failure domain upstream).
  Post-bootstrap runs skip this check: an incomplete pool only delays events, it can't fabricate them.
- **Test isolation (2026-07-13 lesson):** ANY test that imports `monitor.mjs` MUST override all four
  Part 0.1 env vars (`DISCOVERY_EVENTS_FILE`/`GATE_EVENTS_FILE`/`DISCOVERY_RUNS_FILE`/
  `DISCOVERY_BOOTSTRAP_FILE`), not just `STATE_FILE`/`ALERTS_FILE`. `test-regression.mjs` originally
  missed these: its fixtures wrote into production `state/`, falsely completed bootstrap, and the
  next real cron run recorded ~34 pre-existing charted games as `source_first_seen` (+15
  `gate_first_seen`) — exactly the left-censor pollution this design exists to prevent, caused by
  test leakage rather than API failure. The four production event/state files were reset once on
  2026-07-13 to re-bootstrap cleanly; event history before that reset is void.
- **Test:** `test-discovery-events-regression.mjs` — offline, stubbed `fetch`, covers cold-start
  baseline suppression, a combined-failure bootstrap (one sortId ok / one down / games-batch partial,
  recovering next round), TTL-delete-then-reappear (one `source_first_seen`, not two), cross-sort
  first-seen (same game, two sortIds, two independent events), a total games-batch outage
  (`source_first_seen` unaffected, `gate_first_seen` deferred to the recovery run), and
  pool-incomplete bootstrap deferral (sort down while games-batch is ok → gate bootstrap waits;
  the recovered sort's exclusive games get `gate_baseline`, not `gate_first_seen`).
  `test-regression.mjs` (gate/verdict logic) continues to pass unchanged — this layer never altered
  `alerts.json`/`monitor-state.json` output.

## Guide-sites codes/wiki radar (BUILT, 2026-07-13 — Part A of indie-builder-brain/briefs/2026-07-12-sitemap-discovery-radar.md)
**Purpose:** watch whether third-party codes/wiki sites have already started publishing "codes for
Game X" articles — that's evidence a competitor noticed the game, and it's a much stronger signal
than any Roblox-internal chart (a real editor spent real time writing a page). Pure reference signal
for a later cross-project "who found it first" comparison (Part C, a separate `builder-tools` script)
— **not wired into gate A-D or `alerts.json`**, same discipline as the sitemap discovery radar above.

- **Script:** `guide-sitemap-monitor.mjs`, self-contained (zero shared imports with `monitor.mjs`/
  `sitemap-monitor.mjs` by design — duplication across the three `.mjs` files is intentional per this
  project's zero-npm-deps convention). Reuses `monitor.mjs`'s exact `httpFetch`/jittered-backoff/
  `BlockedError`/browser-ish `HEADERS` pattern.
- **Sites (07-13 live-verified — brief's 07-12 numbers had already drifted by one day; don't trust
  either set blindly, re-verify before relying on shard counts):**
  - **TryHardGuides** (`tryhardguides.com/sitemap_index.xml`) — weekly shards
    (`post-sitemap-YYYY-W.xml`), 266 of them live (not spot-checked against brief, just confirmed the
    pattern + index-level lastmod still hold), plus 6 non-post shards (`page-sitemap1.xml`,
    `web-story-sitemap1.xml`, `fortnite-db-sitemap1.xml`, `author-sitemap.xml`, `category-sitemap.xml`,
    `news-sitemap.xml`) filtered out by URL pattern.
  - **Beebom** (`beebom.com/sitemap_index.xml`) — **real count is 50 numbered `post-sitemapN.xml`
    shards (+ unnumbered `post-sitemap.xml` = shard "1"), not the 55 the brief cited** — the index
    also lists 4 non-post shards (`page-sitemap.xml`, `category-sitemap.xml`, `post_tag-sitemap.xml`,
    `author-sitemap.xml`) that must be filtered out (`/post-sitemap\d*\.xml$`, which does NOT match
    `post_tag-sitemap.xml` since the literal substring differs). Confirmed live: shard number ≠
    chronological order (`post-sitemap.xml`, i.e. "shard 1", contains 2016-era tech articles, not the
    newest content) — every run reads all shards' index-level lastmod and refetches whichever changed,
    picking by lastmod-diff only; a log-only warning fires if the shard with the latest lastmod isn't
    the highest-numbered one. **Live surprise (07-13):** the index-level lastmod for `post-sitemap.xml`
    and `post-sitemap50.xml` were identical to the second despite `post-sitemap.xml`'s actual entries
    being untouched since 2016 — looks like a whole-index regeneration event stamps every currently
    active shard's lastmod, not just the ones whose content changed. Harmless for correctness (new-vs-
    not is decided by the URL ever-seen set, never by lastmod — see below) but means Beebom may cause
    more redundant refetches than TryHardGuides/Dexerto; worth watching if it turns out to happen every
    run rather than as a one-off.
  - **Dexerto** (`dexerto.com`) — monthly shards via `?year=YYYY&month=M` (149 months back to 2018-04
    at index level, confirmed live). **The top-level index carries no lastmod at all** (07-13 finding,
    brief didn't mention this) — Dexerto's collector never fetches the index for shard-selection at
    all, it constructs current-month + previous-month URLs directly from the clock and always refetches
    both every run (index-level lastmod isn't in the decision path for this site). Entry-level lastmod
    inside each month shard does exist and is used for `updated` detection like the other two sites.
    **Live finding on the A.3 "articles link the game directly" assumption:** true for TryHardGuides and
    Beebom (both commonly embed a `roblox.com/games/{placeId}` link), but spot-checked 4 Dexerto codes
    articles and only 1 of 4 had the link — Dexerto codes pages more often just don't link the game
    page, so expect a much higher `name_only`/`failed` rate from Dexerto than from the other two.
- **Article filter:** URL must match `/roblox/i` AND `/(codes|wiki)/i` — all three sites mix in large
  amounts of unrelated content (TryHardGuides has wordle/crossword pages, Beebom is a general tech
  site, Dexerto is a general gaming/entertainment news site); this narrows to actual "codes for a
  specific game" articles and excludes generic Roblox news (e.g. a Dexerto "Roblox × Rolling Stones
  collab" story, which mentions Roblox but isn't a codes page for one game).
- **Universal principle (brief Part 0.3, same rule S6 already follows):** `lastmod` only decides
  *which shard to refetch this round* — it NEVER decides "is this a new page". "New" is always: is
  this URL in the site's permanent ever-seen set or not. A URL whose lastmod changed but is already in
  ever-seen produces an `updated` event (informational), not `first_seen` — an editor swapping a
  redeem code in an old article must never look like a new page.
- **Cold-start baseline suppression is per-shard, not per-site** (`bootstrappedShards` inside each
  site's known-state file) — identical reasoning to `monitor.mjs`'s `discovery-bootstrap.json`: if
  shard N fails on a site's very first run while every other shard succeeds, shard N's bootstrap stays
  pending — its `childLastmods`/`bootstrappedShards` entries are simply never written on a failed
  fetch — until whichever later run actually fetches it successfully; THAT run baselines shard N's
  URLs (`eventType: 'baseline'`, `leftCensored: true`), even if the site has been running for weeks by
  then. Never inferred from "does a baseline event exist for this shard" — explicitly persisted, same
  bug class this project already hit once in `monitor.mjs`.
- **Data model:**
  - `state/guide-newly-seen.jsonl` — one line per `baseline | first_seen | updated` event: `eventType`,
    `leftCensored`, `observedAt`, `runId`, `site` (`tryhardguides|beebom|dexerto`), `url`,
    `articleTitle`, `rawSlug`, `extractedGameName` (nullable), `extracted` (bool), `placeId` (nullable),
    `universeId` (nullable), `extractionStatus` (`exact_id|name_only|failed`), `lastmod` (if provided),
    `sourceLastmodTrusted` (bool).
  - `state/guide-known-{site}.json` per site — `everSeenUrls`, `lastmodByUrl` (detects `updated`),
    `childLastmods` (per-shard, decides what to refetch — absent/undefined for Dexerto, which doesn't
    use lastmod for shard selection), `bootstrappedShards` (per-shard bootstrap flag), `enrichmentByUrl`
    (`{status: pending|done|failed, attempts, placeId, universeId}` — the retryable placeId→universeId
    resolution state), `updatedAt`.
  - `state/guide-source-runs.jsonl` — one line per site per run, same unified schema as
    `discovery-source-runs.jsonl`/S6's manifest: `runId, sourceKey, scheduledAt, startedAt, finishedAt,
    status, fetchedCount, eligibleCount, error`. `sourceKey` = site name; `fetchedCount`/`eligibleCount`
    here mean "shards successfully fetched"/"shards attempted this round" (shard-based, like S6 — not
    item-based like `discovery-source-runs.jsonl`'s `games-batch` row). `status`: `ok` only if every
    shard attempted this round succeeded (or zero shards needed checking — vacuously healthy); `partial`
    if some but not all succeeded; `error` if none did (including "the site's index itself was
    unreachable", which for TryHardGuides/Beebom means no shard list could even be produced this round).
- **Game-name extraction (A.3):** last URL path segment, strip `roblox-` prefix, strip `-codes`/
  `-codes-<suffix>`/trailing numeric ID (Dexerto slugs end in `-<articleId>`), hyphens→spaces,
  title-case. Extraction failure is allowed and expected — `rawSlug` is always kept regardless;
  `extracted`/`extractedGameName` just describe whether the heuristic produced something clean (flagged
  failed if the residual string still contains "codes"/"wiki" or is purely numeric, meaning the
  prefix/suffix rule didn't actually match this slug's shape — confirmed live on a real TryHardGuides
  slug like `roblox-peroxide-codes-for-product-essence`, where "codes" sits mid-slug rather than as a
  clean suffix).
- **placeId/universeId enrichment:** only for `first_seen`/`updated` events, never for `baseline` —
  fetching+parsing HTML for a cold-start batch of (potentially hundreds of) historical URLs would be
  expensive and pointless (S6 skips cold-start enrichment for the same reason). Fetches the article
  HTML, greps for `roblox.com/games/(\d+)` and the `<title>`. universeId resolution
  (`apis.roblox.com/universes/v1/places/{placeId}/universe`, same contract as `monitor.mjs`) retries up
  to `ENRICH_RETRY_MAX` (default 5) attempts across runs, tracked in `enrichmentByUrl`. Because
  `guide-newly-seen.jsonl` is append-only, a `universeId` that resolves on a *later* retry is NOT
  back-filled into the original event line — the event line's `universeId` is a point-in-time snapshot;
  a consumer wanting the latest resolved value should cross-reference `guide-known-{site}.json`'s
  `enrichmentByUrl`, which always holds the current status.
- **Failure semantics:** a shard fetch failure only skips that one shard (its `childLastmods`/
  `bootstrappedShards` entries are left untouched, everything else in that site's known-state still
  gets saved); a site's index itself being unreachable skips the whole site for this round without
  touching its known-state at all; either way the other two sites run normally. A bug in one site's
  processing (uncaught exception) is also caught at the top level so it can't take down the other two.
- **Deployment:** `run-guide-monitor.sh` (git pull --rebase → `node guide-sitemap-monitor.mjs` →
  commit+push `state/`, with a 3-attempt jittered-backoff push retry — unlike `run-monitor.sh`, which
  just warns and waits for the next run on push failure) + `com.yy.roblox-window-monitor.guide.plist`,
  every 2h (`StartCalendarInterval` at Hour=0,2,4,...,22, Minute=0) — local Mac mini only, not GitHub
  Actions (media sites are more sensitive to datacenter IPs than Roblox's own API, and TryHardGuides has
  already 429'd once). Shares `run-monitor.sh`'s file lock. **The plist is a template only — not
  installed/activated by this change.** Manual install:
  ```sh
  cp com.yy.roblox-window-monitor.guide.plist ~/Library/LaunchAgents/
  launchctl load ~/Library/LaunchAgents/com.yy.roblox-window-monitor.guide.plist
  ```
- **Test:** `test-guide-sitemap-regression.mjs` — offline, stubbed `fetch`, covers cold-start baseline
  suppression (300 historical URLs → 0 `first_seen`), a genuinely new URL → exactly one `first_seen`
  with successful placeId/universeId enrichment, an already-seen URL's lastmod changing → `updated`
  (not a second `first_seen`), a two-shard site where one shard fails on round 1 and only succeeds on
  round 2 (that shard's URLs baseline on round 2, not miscounted as `first_seen` or against the other
  shard's already-completed bootstrap), a Beebom-specific case with shard lastmods read out of numeric
  order (confirms shard selection is lastmod-diff-driven, not number-driven, plus the order-mismatch
  warning), and a light Dexerto cold-start + next-month-boundary-agnostic new-article check.
  `node test-guide-sitemap-regression.mjs`.

## v3 ideas (NOT built)
Smarter slug/brand extraction; per-source gate thresholds; instant alerting (current email latency = up to 4h, bounded by the local cron; would need cloud email + a GitHub Secret); gate C extensions — `{slug}.wiki` freshness as a forward scout (VD case: .wiki registered 6d before .com, would turn gate C into a first-mover signal; costs +1 rdap.org call/game) and promoting the print-only free-.com list to email once its noise level is known.
