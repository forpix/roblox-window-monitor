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
const FRESH_REG_DAYS        = num('FRESH_REG_DAYS', 14);
const HISTORY_MAX           = num('HISTORY_MAX', 36);
const TIMEOUT_MS            = num('TIMEOUT_MS', 15000);
const RETRIES              = num('RETRIES', 2);

const STATE_FILE  = process.env.STATE_FILE  || 'state/monitor-state.json';
const ALERTS_FILE = process.env.ALERTS_FILE || 'state/alerts.json';

// ---- discovery (v2): pull candidate games from Roblox charts, no watchlist needed ----
const DISCOVER            = process.env.DISCOVER !== '0'; // set DISCOVER=0 for watchlist-only
const DISCOVERY_SORTS     = (process.env.DISCOVERY_SORTS || 'up-and-coming,top-trending').split(',').map(s => s.trim()).filter(Boolean);
const DISCOVERY_CCU_MIN   = num('DISCOVERY_CCU_MIN', ESTABLISHED_CCU_MIN); // prefilter to bound the age lookup
const DISCOVERY_TTL_HOURS = num('DISCOVERY_TTL_HOURS', 24); // drop discovered games gone from charts this long
const SESSION_ID          = process.env.SESSION_ID || '11111111-1111-1111-1111-111111111111';

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

// same, chunked at 100 (the batch endpoint caps the id list)
async function getGamesChunked(universeIds) {
  const out = [];
  for (let i = 0; i < universeIds.length; i += 100) {
    try { out.push(...await getGames(universeIds.slice(i, i + 100))); }
    catch (e) {
      if (e instanceof BlockedError) apiBlocked = true;
      console.warn(`[warn] CCU batch chunk@${i} failed: ${e.message}`);
    }
  }
  return out;
}

// pull Roblox explore-api charts -> [{ universeId, placeId, name, ccuHint }] (Roblox-only, no key)
async function discover() {
  const out = new Map();
  for (const sortId of DISCOVERY_SORTS) {
    try {
      const j = await getJson(`https://apis.roblox.com/explore-api/v1/get-sort-content?sessionId=${SESSION_ID}&sortId=${sortId}`);
      for (const g of j.games || []) {
        if ((g.playerCount ?? 0) < DISCOVERY_CCU_MIN) continue;
        if (!out.has(g.universeId))
          out.set(g.universeId, { universeId: g.universeId, placeId: g.rootPlaceId, name: g.name, ccuHint: g.playerCount });
      }
    } catch (e) {
      if (e instanceof BlockedError) apiBlocked = true;
      console.warn(`[warn] discovery sort '${sortId}' failed: ${e.message}`);
    }
  }
  return [...out.values()];
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
async function windowGate(slug, comCheck = null) {
  const domains = [`${slug}.com`, `${slug}.net`];
  const checks = await Promise.all([comCheck ?? rdapCheck(domains[0]), rdapCheck(domains[1])]);

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

// discovered names are decorated ("Brand: subtitle", emoji, [event tags]) — extract the core-brand slug
function deriveSlug(name) {
  const core = name.replace(/[\[(\{][^\])\}]*[\])\}]/g, ' ').split(/[|:•]/)[0];
  return core.toLowerCase().replace(/[^a-z0-9]/g, '') || name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ---- main ----
const state = loadState();
const now = Date.now();

// build target set: pinned watchlist (placeId -> universeId) + discovered charts
const watchKeys = new Set(WATCHLIST.map(w => String(w.placeId)));
const targets = new Map(); // universeId -> { universeId, placeId, slug?, source }

for (const w of WATCHLIST) {
  try {
    const universeId = await getUniverseId(w.placeId);
    targets.set(universeId, { universeId, placeId: w.placeId, slug: w.slug, source: 'watch' });
  } catch (e) {
    if (e instanceof BlockedError) apiBlocked = true;
    console.warn(`[warn] resolve universe failed placeId=${w.placeId}: ${e.message}`);
  }
}

const discovered = DISCOVER ? await discover() : [];
for (const d of discovered) {
  if (!targets.has(d.universeId)) // pinned entries win over discovered
    targets.set(d.universeId, { universeId: d.universeId, placeId: d.placeId, source: 'discover' });
}

const targetList = [...targets.values()];
const pinnedCount = targetList.filter(t => t.source === 'watch').length;

// one CCU/age batch for the whole pool
const games = await getGamesChunked(targetList.map(t => t.universeId));
const byUniverse = new Map(games.map(g => [g.id, g]));

// gate C prefetch: one {slug}.com check per game, batched (serial would stall on timeouts).
// A fresh registration is the "someone is grabbing this brand right now" signal — CCU gates
// structurally miss steady climbers (rolling avg chases the growth, spike% never fires).
const slugFor = t => { const g = byUniverse.get(t.universeId); return g ? (t.slug || deriveSlug(g.name)) : null; };
const comChecks = new Map();
{
  const slugs = [...new Set(targetList.map(slugFor).filter(Boolean))];
  for (let i = 0; i < slugs.length; i += 8) {
    const batch = slugs.slice(i, i + 8);
    const res = await Promise.all(batch.map(s => rdapCheck(`${s}.com`)));
    batch.forEach((s, j) => comChecks.set(s, res[j]));
  }
  const unresolved = slugs.filter(s => comChecks.get(s) === null);
  if (unresolved.length) console.warn(`[warn] gate C: RDAP unresolved for ${unresolved.length} slug(s): ${unresolved.join(', ')}`);
}

const rows = [];
const candidates = [];
const freeComs = [];

for (const t of targetList) {
  try {
    const g = byUniverse.get(t.universeId);
    if (!g) { console.warn(`[warn] no game data for universe=${t.universeId} (placeId=${t.placeId})`); continue; }

    const playing = g.playing ?? 0;
    const ageDays = (now - new Date(g.created).getTime()) / DAY;
    const slug = t.slug || deriveSlug(g.name);

    const key = String(t.placeId);
    const prev = state[key] || { history: [] };
    const prior = prev.history.map(h => h.playing); // PRIOR samples only
    const rollingAvg = prior.length ? prior.reduce((a, b) => a + b, 0) / prior.length : 0;

    // 量级门 A (new-viral) — fires even on first sighting (no history needed)
    const gateA = ageDays < NEW_GAME_MAX_AGE_DAYS && playing >= NEW_GAME_CCU_MIN;
    // 量级门 B (spike) — needs prior history
    const spikePct = rollingAvg > 0 ? (playing - rollingAvg) / rollingAvg * 100 : 0;
    const gateB = playing >= ESTABLISHED_CCU_MIN && rollingAvg > 0 && spikePct >= SPIKE_PCT;
    // 量级门 C (fresh-com) — {slug}.com registered days ago = active land-grab, regardless of spike.
    // RDAP unresolved -> silent non-fire (warned above), never CHECK spam across the whole pool.
    const com = comChecks.get(slug);
    const comRegDays = com && !com.available && com.regDate ? (now - com.regDate.getTime()) / DAY : null;
    const gateC = comRegDays !== null && comRegDays < FRESH_REG_DAYS;
    if (com?.available) freeComs.push({ slug, name: g.name, ccu: playing, ageDays });

    let verdict = 'QUIET';
    let detail = '';
    if (gateA || gateB || gateC) {
      ({ verdict, detail } = await windowGate(slug, com));
      if (gateC) detail += `; .com registered ${comRegDays.toFixed(1)}d ago`;
    }

    const history = [...prev.history, { t: now, playing }].slice(-HISTORY_MAX);
    state[key] = { name: g.name, slug, source: t.source, lastSeen: now, history, lastVerdict: verdict };

    const row = {
      source: t.source,
      name: g.name,
      ccu: playing,
      ageDays: Number(ageDays.toFixed(1)),
      rollingAvg: Math.round(rollingAvg),
      spikePct: rollingAvg > 0 ? Math.round(spikePct) : null, // null = no baseline yet
      gate: gateA ? 'A:new-viral' : gateB ? 'B:spike' : gateC ? 'C:fresh-com' : '-',
      verdict,
      detail,
    };
    rows.push(row);
    if (gateA || gateB || gateC) candidates.push(row);
  } catch (err) {
    console.warn(`[warn] game failed placeId=${t.placeId}: ${err.message}`);
  }
}

// prune discovered games gone from charts > TTL; pinned games are kept forever
const ttlMs = DISCOVERY_TTL_HOURS * 3600000;
for (const key of Object.keys(state)) {
  if (watchKeys.has(key)) continue;
  if (now - (state[key].lastSeen || 0) > ttlMs) delete state[key];
}

writeFileMkdir(STATE_FILE, JSON.stringify(state, null, 2));
writeFileMkdir(ALERTS_FILE, JSON.stringify({ generatedAt: new Date(now).toISOString(), candidates }, null, 2));

// spike radar: always show pinned + candidates + the 5 hottest movers (to tune SPIKE_PCT against live data)
const hottest = rows.filter(r => r.spikePct != null).sort((a, b) => b.spikePct - a.spikePct).slice(0, 5);
const showSet = new Set([...rows.filter(r => r.source === 'watch' || r.gate !== '-'), ...hottest]);
const shown = [...showSet].sort((a, b) => b.ccu - a.ccu);
console.log(`Scanned ${targetList.length} games (pinned ${pinnedCount} + discovered ${discovered.length}) → ${candidates.length} candidate(s), ${rows.length - shown.length} other QUIET.`);
console.table(shown.map(r => ({ src: r.source, name: r.name, ccu: r.ccu, age: r.ageDays, avg: r.rollingAvg, 'spike%': r.spikePct ?? '—', gate: r.gate, verdict: r.verdict })));

const order = { GREEN: 0, YELLOW: 1, RED: 2, CHECK: 3 };
console.log('\nActionable candidates:');
if (!candidates.length) {
  console.log('  (none)');
} else {
  for (const c of [...candidates].sort((a, b) => (order[a.verdict] ?? 9) - (order[b.verdict] ?? 9)))
    console.log(`  [${c.verdict}] ${c.name} — CCU ${c.ccu}, ${c.gate}, ${c.detail}`);
}

// first-mover visibility, print-only: junk slugs are often free, so this stays out of alerts/email
if (freeComs.length) {
  console.log('\nFree .coms on charted games (not emailed — eyeball the slug before acting):');
  for (const f of [...freeComs].sort((a, b) => b.ccu - a.ccu))
    console.log(`  ${f.slug}.com — ${f.name} (CCU ${f.ccu}, age ${f.ageDays.toFixed(1)}d)`);
}

if (apiBlocked) {
  console.log('\n⚠️  API_BLOCKED — Roblox returned 403/429/bot-challenge (likely datacenter-IP block).');
  console.log('   Results are INCOMPLETE. Do NOT read "no candidates" as "window closed / all clear".');
}
