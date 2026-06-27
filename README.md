# roblox-window-monitor

Tiny, zero-cost, zero-dependency monitor that watches a hand-picked list of Roblox games and tells me whether the **EMD (exact-match domain) land-grab window is still open** for each one.

For every watched game it: pulls current CCU → applies a volume gate → applies a domain "window gate" via RDAP → emits a **GREEN / YELLOW / RED / CHECK** (or QUIET) verdict. Runs free on GitHub Actions every 2 hours. No API keys, no secrets.

## How to read the verdict

| verdict | meaning | action |
|---|---|---|
| **GREEN** | `{slug}.com` or `{slug}.net` is still **available** | register it now |
| **YELLOW** | both taken, but oldest registration is recent (< STALE_DAYS) | window closing — move fast or look at variants |
| **RED** | both taken, oldest registration is old (≥ STALE_DAYS) | window closed, you're late |
| **CHECK** | RDAP could not resolve | uncertain — verify by hand (never auto-promoted to GREEN) |
| **QUIET** | game didn't clear the volume gate | nothing to do, just recorded a sample |

## Gate logic

A game becomes a **candidate** (and gets an RDAP window check) when **either** volume gate fires:

- **量级门 A — new-viral:** `ageDays < NEW_GAME_MAX_AGE_DAYS` **and** `playing >= NEW_GAME_CCU_MIN`. Fires on the very first run (no history needed).
- **量级门 B — spike:** `playing >= ESTABLISHED_CCU_MIN` **and** `(playing - rollingAvg) / rollingAvg * 100 >= SPIKE_PCT`, where `rollingAvg` is the average of **prior** stored samples only.

Neither fires → **QUIET** (just store the sample).

`slug` comes from the watchlist entry, else auto-derived = game name lowercased, alphanumeric only.

### Thresholds (all overridable by env var of the same name)

| env | default | meaning |
|---|---|---|
| `NEW_GAME_MAX_AGE_DAYS` | 7 | gate A: max age in days |
| `NEW_GAME_CCU_MIN` | 50000 | gate A: min concurrent players |
| `ESTABLISHED_CCU_MIN` | 20000 | gate B: min concurrent players |
| `SPIKE_PCT` | 200 | gate B: % jump over rolling avg |
| `FRESH_DAYS` | 3 | window: "just grabbed" boundary |
| `STALE_DAYS` | 10 | window: RED boundary |
| `HISTORY_MAX` | 36 | samples kept per game |
| `TIMEOUT_MS` | 15000 | per-request timeout |
| `RETRIES` | 2 | retries on 403/429/5xx |
| `STATE_FILE` | `state/monitor-state.json` | state path |
| `ALERTS_FILE` | `state/alerts.json` | this-run candidates path |

## Watchlist

Edit the `WATCHLIST` array at the top of `monitor.mjs`:

```js
const WATCHLIST = [
  { placeId: 97598239454123, slug: 'growagarden2' }, // Grow a Garden 2
];
```

`placeId` is the number in a game's Roblox URL (`roblox.com/games/<placeId>/...`). `slug` is optional (auto-derived from the name if omitted).

## Run it

```sh
node monitor.mjs                 # uses defaults, writes state/
```

GitHub Actions (`.github/workflows/monitor.yml`) runs it on `cron "0 */2 * * *"` + `workflow_dispatch`, then commits `state/` back. `state/` is committed on purpose (it's the CCU history) — do **not** gitignore it.

### Verification

Force the volume gate open so the watched game becomes a candidate and the RDAP path runs:

```sh
NEW_GAME_CCU_MIN=1000 NEW_GAME_MAX_AGE_DAYS=9999 \
  STATE_FILE=/tmp/s.json ALERTS_FILE=/tmp/a.json node monitor.mjs
```

Expect a row for **Grow a Garden 2** with a real CCU and verdict **RED** (its `.com`/`.net` were registered well over `STALE_DAYS` ago). CHECK or GREEN there means RDAP parsing is broken. Then run once with defaults and confirm **QUIET** (no false alarm).

## Datacenter-IP note

Roblox's public endpoints can throttle/challenge datacenter IPs (GitHub Actions runs on Azure). The script sends browser-ish headers, retries on 403/429/5xx, and prints a loud **`API_BLOCKED`** banner when it sees a block — so a block never masquerades as "all clear". If Actions gets persistently blocked, the fallback is to run the same `monitor.mjs` from a local cron / launchd job (residential IP). See `CLAUDE.md`.

## Scope

Roblox only, watchlist only. No auto-discovery / charts-scraping (that's v2, not built — validate v1 first).
