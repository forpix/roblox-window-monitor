#!/usr/bin/env node
// 离线回归:闸门与判定逻辑的安全网。不碰网络、不碰真实 state。
// 三道必过题:
//   1. painttohide 型(gate D 年轻上榜 + 域名全空 + sweep 干净) 必须 GREEN
//   2. drainthelake 型(.com 新注册且已建站 = 模板厂签名) 必须 RED
//   3. 双域名陈旧注册 必须 RED
// 跑法:node test-regression.mjs;断言失败即非零退出。

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DAY = 86400000;
const now = Date.now();
const iso = daysAgo => new Date(now - daysAgo * DAY).toISOString();

const tmp = mkdtempSync(join(tmpdir(), 'roblox-regression-'));
process.env.STATE_FILE = join(tmp, 'state.json');
process.env.ALERTS_FILE = join(tmp, 'alerts.json');
// Part 0.1 的四个事件/状态文件也必须隔离——2026-07-13 教训：漏了这四个，fixture 事件写进生产
// state/ 并抢先完成了假 bootstrap，当晚真实 cron 首轮把全部在榜老游戏误记成 first_seen。
// 任何 import monitor.mjs 的测试都要带上这一组覆盖。
process.env.DISCOVERY_EVENTS_FILE = join(tmp, 'discovery-events.jsonl');
process.env.GATE_EVENTS_FILE = join(tmp, 'gate-events.jsonl');
process.env.DISCOVERY_RUNS_FILE = join(tmp, 'discovery-source-runs.jsonl');
process.env.DISCOVERY_BOOTSTRAP_FILE = join(tmp, 'discovery-bootstrap.json');
process.env.RETRIES = '0';
process.env.TIMEOUT_MS = '2000';

// ---- fixtures ----
const GAMES = {
  101: { id: 101, rootPlaceId: 97598239454123, name: 'Grow a Garden 2', playing: 500, created: iso(400) },
  201: { id: 201, rootPlaceId: 301, name: 'Paint To Hide!', playing: 25000, created: iso(30) },
  202: { id: 202, rootPlaceId: 302, name: 'Drain The Lake', playing: 30000, created: iso(10) },
  203: { id: 203, rootPlaceId: 303, name: 'Steal A Lab', playing: 22000, created: iso(20) },
};
const CHART = [201, 202, 203].map(id => ({
  universeId: id, rootPlaceId: GAMES[id].rootPlaceId, name: GAMES[id].name, playerCount: GAMES[id].playing,
}));
// RDAP:未列出的域名一律 404(未注册)
const RDAP_TAKEN = {
  'growagarden2.com': iso(300),
  'drainthelake.com': iso(1),   // 新注册 → gate C
  'stealalab.com': iso(30),
  'stealalab.net': iso(40),     // 双taken且最老40d ≥ STALE_DAYS → RED
};
// 已建站的面(siteProbe 返回真实 title)
const BUILT = {
  'drainthelake.com': 'Drain The Lake Wiki, Codes, Tier List and Tools',
};

const json = obj => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
const notFound = () => new Response('', { status: 404 });
const dnsFail = () => {
  const e = new TypeError('fetch failed');
  e.cause = { code: 'ENOTFOUND' };
  throw e;
};

globalThis.fetch = async url => {
  const u = new URL(String(url));
  if (u.hostname === 'apis.roblox.com' && u.pathname.includes('/universes/v1/places/'))
    return json({ universeId: 101 });
  if (u.hostname === 'games.roblox.com') {
    const ids = (u.searchParams.get('universeIds') || '').split(',').map(Number);
    return json({ data: ids.map(id => GAMES[id]).filter(Boolean) });
  }
  if (u.hostname === 'apis.roblox.com' && u.pathname.includes('get-sort-content')) {
    const sort = u.searchParams.get('sortId');
    return json({ games: sort === 'up-and-coming' ? CHART : [] });
  }
  if (u.hostname.startsWith('rdap.')) {
    const domain = u.pathname.split('/').pop();
    if (RDAP_TAKEN[domain])
      return json({ events: [{ eventAction: 'registration', eventDate: RDAP_TAKEN[domain] }] });
    return notFound();
  }
  // siteProbe / competitorSweep 面:只有 BUILT 里的存在,其余 DNS 不存在
  if (BUILT[u.hostname])
    return new Response(`<html><head><title>${BUILT[u.hostname]}</title></head></html>`, { status: 200 });
  return dnsFail();
};

// ---- run production script against fixtures ----
await import('./monitor.mjs');

// ---- assertions ----
const alerts = JSON.parse(readFileSync(process.env.ALERTS_FILE, 'utf8'));
const byName = Object.fromEntries(alerts.candidates.map(c => [c.name, c]));
let failed = 0;
const expect = (label, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed += 1;
};

const paint = byName['Paint To Hide!'];
expect('painttohide 型进入候选', Boolean(paint));
expect('painttohide 型走 gate D', paint?.gate === 'D:young-chart');
expect('painttohide 型判 GREEN', paint?.verdict === 'GREEN');
expect('painttohide 型 sweep 干净', /sweep clean/.test(paint?.detail || ''));

const drain = byName['Drain The Lake'];
expect('模板厂签名进入候选(gate C)', drain?.gate === 'C:fresh-com');
expect('模板厂签名必须 RED', drain?.verdict === 'RED');
expect('RED 原因 = .com 已建站', /\.com BUILT/.test(drain?.detail || ''));

const stale = byName['Steal A Lab'];
expect('双域名陈旧注册进入候选', Boolean(stale));
expect('双域名陈旧注册必须 RED', stale?.verdict === 'RED');

expect('低 CCU 老游戏不进候选', !byName['Grow a Garden 2']);

console.log(failed ? `\n${failed} 条回归失败` : '\n回归全过');
process.exit(failed ? 1 : 0);
