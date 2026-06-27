#!/usr/bin/env node
// Roblox EMD land-grab window monitor. Watchlist-only, zero-dep, Node 20+, ESM.
// For each watched game: pull CCU -> volume gate -> RDAP domain window gate -> verdict.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

// ---- thresholds (every one overridable by env var of the same name) ----
const num = (name, def) => {
  const v = process.env[name];
  return v === undefined || v === '' ? def : Number(v);
};
const NEW_GAME_MAX_AGE_DAYS = num('NEW_GAME_MAX_AGE_DAYS', 7);
const NEW_GAME_CCU_MIN      = num('NEW_GAME_CCU_MIN', 50000);
const ESTABLISHED_CCU_MIN   = num('ESTABLISHED_CCU_MIN', 20000);
const SPIKE_PCT             = num('SPIKE_PCT', 200);
const FRESH_DAYS            = num('FRESH_DAYS', 3);
const STALE_DAYS            = num('STALE_DAYS', 10);
const HISTORY_MAX           = num('HISTORY_MAX', 36);
const TIMEOUT_MS            = num('TIMEOUT_MS', 15000);
const RETRIES              = num('RETRIES', 2);

const STATE_FILE  = process.env.STATE_FILE  || 'state/monitor-state.json';
const ALERTS_FILE = process.env.ALERTS_FILE || 'state/alerts.json';

const DAY = 86400000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const backoff = a => 500 * 2 ** a + Math.floor(Math.random() * 250); // jittered

// browser-ish headers reduce naive datacenter-IP bot-blocking (Actions runs on Azure IPs)
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
};

// flips when Roblox returns a block-shaped response (403/429 or bot-challenge HTML)
let apiBlocked = false;
class BlockedError extends Error {}

// ---- watchlist ----
const WATCHLIST = [
  { placeId: 97598239454123, slug: 'growagarden2' }, // Grow a Garden 2
];

// ---- http (retry on 403/429/5xx with jittered backoff) ----
async function httpFetch(url, attempt = 0) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: ctrl.signal });
    if ((res.status === 429 || res.status === 403 || res.status >= 500) && attempt < RETRIES) {
      clearTimeout(t);
      await sleep(backoff(attempt));
      return httpFetch(url, attempt + 1);
    }
    return res;
  } catch (e) {
    clearTimeout(t);
    if (attempt < RETRIES) { await sleep(backoff(attempt)); return httpFetch(url, attempt + 1); }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

async function getJson(url) {
  const res = await httpFetch(url);
  if (res.status === 403 || res.status === 429) throw new BlockedError(`HTTP ${res.status} ${url}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const text = await res.text();
  try { return JSON.parse(text); }
  catch { throw new BlockedError(`non-JSON body, likely bot challenge: ${url}`); }
}

// placeId -> universeId
async function getUniverseId(placeId) {
  const j = await getJson(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`);
  return j.universeId;
}

// universeIds -> [{ id, rootPlaceId, name, playing, created, updated }]
async function getGames(universeIds) {
  const j = await getJson(`https://games.roblox.com/v1/games?universeIds=${universeIds.join(',')}`);
  return j.data || [];
}

// ---- RDAP ----
function rdapUrl(domain) {
  if (domain.endsWith('.com')) return `https://rdap.verisign.com/com/v1/domain/${domain}`;
  if (domain.endsWith('.net')) return `https://rdap.verisign.com/net/v1/domain/${domain}`;
  return `https://rdap.org/domain/${domain}`;
}

// -> { available:true } | { available:false, regDate:Date|null } | null (unresolved)
async function rdapCheck(domain) {
  try {
    const res = await httpFetch(rdapUrl(domain));
    if (res.status === 404) return { available: true };
    if (res.status === 200) {
      const j = await res.json();
      const ev = (j.events || []).find(e => e.eventAction === 'registration');
      return { available: false, regDate: ev ? new Date(ev.eventDate) : null };
    }
    return null; // anything else (429/5xx/redirect failure) = could not resolve
  } catch {
    return null; // timeout / network = could not resolve
  }
}

// window gate over {slug}.com and {slug}.net. NEVER promote uncertainty to GREEN.
async function windowGate(slug) {
  const domains = [`${slug}.com`, `${slug}.net`];
  const checks = await Promise.all(domains.map(rdapCheck));

  if (checks.some(c => c === null))
    return { verdict: 'CHECK', detail: 'RDAP could not resolve one or more domains' };

  const free = domains.filter((_, i) => checks[i].available);
  if (free.length) return { verdict: 'GREEN', detail: `available: ${free.join(', ')}` };

  // both taken
  if (checks.some(c => !c.regDate))
    return { verdict: 'CHECK', detail: 'taken but no registration date in RDAP' };

  const ages = checks.map(c => (Date.now() - c.regDate.getTime()) / DAY);
  const oldest = Math.max(...ages); // registered longest ago
  const verdict = oldest >= STALE_DAYS ? 'RED' : 'YELLOW';
  return { verdict, detail: `both taken, oldest ${oldest.toFixed(1)}d (${domains.join(', ')})` };
}

// ---- state ----
function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); }
  catch { return {}; }
}
function writeFileMkdir(file, data) {
  const dir = dirname(file);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file, data);
}

// ---- main ----
const state = loadState();
const now = Date.now();

// resolve universeIds (per-game failures warn, never crash)
const entries = [];
for (const w of WATCHLIST) {
  try {
    entries.push({ ...w, universeId: await getUniverseId(w.placeId) });
  } catch (e) {
    if (e instanceof BlockedError) apiBlocked = true;
    console.warn(`[warn] resolve universe failed placeId=${w.placeId}: ${e.message}`);
  }
}

let games = [];
if (entries.length) {
  try { games = await getGames(entries.map(e => e.universeId)); }
  catch (e) {
    if (e instanceof BlockedError) apiBlocked = true;
    console.warn(`[warn] CCU batch failed: ${e.message}`);
  }
}
const byUniverse = new Map(games.map(g => [g.id, g]));

const rows = [];
const candidates = [];

for (const e of entries) {
  try {
    const g = byUniverse.get(e.universeId);
    if (!g) { console.warn(`[warn] no game data for universe=${e.universeId} (placeId=${e.placeId})`); continue; }

    const playing = g.playing ?? 0;
    const ageDays = (now - new Date(g.created).getTime()) / DAY;
    const slug = e.slug || g.name.toLowerCase().replace(/[^a-z0-9]/g, '');

    const key = String(e.placeId);
    const prev = state[key] || { history: [] };
    const prior = prev.history.map(h => h.playing); // PRIOR samples only
    const rollingAvg = prior.length ? prior.reduce((a, b) => a + b, 0) / prior.length : 0;

    // 量级门 A (new-viral) — fires even on first run (no history needed)
    const gateA = ageDays < NEW_GAME_MAX_AGE_DAYS && playing >= NEW_GAME_CCU_MIN;
    // 量级门 B (spike) — needs prior history
    const spikePct = rollingAvg > 0 ? (playing - rollingAvg) / rollingAvg * 100 : 0;
    const gateB = playing >= ESTABLISHED_CCU_MIN && rollingAvg > 0 && spikePct >= SPIKE_PCT;

    let verdict = 'QUIET';
    let detail = '';
    if (gateA || gateB) ({ verdict, detail } = await windowGate(slug));

    const history = [...prev.history, { t: now, playing }].slice(-HISTORY_MAX);
    state[key] = { name: g.name, slug, history, lastVerdict: verdict };

    const row = {
      name: g.name,
      ccu: playing,
      ageDays: Number(ageDays.toFixed(1)),
      rollingAvg: Math.round(rollingAvg),
      gate: gateA ? 'A:new-viral' : gateB ? 'B:spike' : '-',
      verdict,
      detail,
    };
    rows.push(row);
    if (gateA || gateB) candidates.push(row);
  } catch (err) {
    console.warn(`[warn] game failed placeId=${e.placeId}: ${err.message}`);
  }
}

writeFileMkdir(STATE_FILE, JSON.stringify(state, null, 2));
writeFileMkdir(ALERTS_FILE, JSON.stringify({ generatedAt: new Date(now).toISOString(), candidates }, null, 2));

console.table(rows.map(r => ({ name: r.name, ccu: r.ccu, age: r.ageDays, avg: r.rollingAvg, gate: r.gate, verdict: r.verdict })));

console.log('\nActionable candidates:');
if (!candidates.length) {
  console.log('  (none) — all QUIET');
} else {
  for (const c of candidates) console.log(`  [${c.verdict}] ${c.name} — CCU ${c.ccu}, ${c.gate}, ${c.detail}`);
}

if (apiBlocked) {
  console.log('\n⚠️  API_BLOCKED — Roblox returned 403/429/bot-challenge (likely datacenter-IP block).');
  console.log('   Results are INCOMPLETE. Do NOT read "no candidates" as "window closed / all clear".');
}
