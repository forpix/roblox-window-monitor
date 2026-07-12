#!/usr/bin/env node
// 离线回归：Part 0.1 事件日志（discovery-events.jsonl / gate-events.jsonl / discovery-source-runs.jsonl）
// + 按 sourceKey 独立持久化的 bootstrap 状态（discovery-bootstrap.json）。
// 不碰真实网络、不碰真实 state；跟 test-regression.mjs（①：闸门/判定输出不变，见该文件）互补。
//
// 覆盖 indie-builder-brain/briefs/2026-07-12-sitemap-discovery-radar.md v7 Part 0.1 的六个回归点
// 中的 ②-⑥（①已经由 test-regression.mjs 的既有断言持续验证 — 本次改动前后它的期望值未变，
// 就是"alerts.json 输出不变"的证据）：
//   ② 冷启动测试：已有游戏只产生 baseline，不产生 first_seen
//   ③ 组合故障冷启动：某 sortId 成功/某 sortId 失败/games API 部分失败，第二轮全部恢复
//   ④ 三轮 TTL 测试：上榜→掉榜→重新上榜，只产生一条 source_first_seen
//   ⑤ 跨榜测试：同游戏先中一个 sort、后中另一个 sort，产生两条独立 source_first_seen
//   ⑥ games 批量 API 整体故障：source_first_seen 不受影响，gate_first_seen 延后到恢复才产生
//
// 跑法：node test-discovery-events-regression.mjs；断言失败即非零退出。

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DAY = 86400000;
const baseNow = Date.now();
const iso = daysAgo => new Date(baseNow - daysAgo * DAY).toISOString();

const json = obj => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
const notFound = () => new Response('', { status: 404 });
const serverError = () => new Response('', { status: 500 });
const dnsFail = () => { const e = new TypeError('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; };

function readJsonl(file) {
  try { return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); }
  catch { return []; }
}

let failed = 0;
const expect = (label, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failed += 1; };

function setupEnv(dir) {
  process.env.STATE_FILE = join(dir, 'state.json');
  process.env.ALERTS_FILE = join(dir, 'alerts.json');
  process.env.DISCOVERY_EVENTS_FILE = join(dir, 'discovery-events.jsonl');
  process.env.GATE_EVENTS_FILE = join(dir, 'gate-events.jsonl');
  process.env.DISCOVERY_RUNS_FILE = join(dir, 'discovery-source-runs.jsonl');
  process.env.DISCOVERY_BOOTSTRAP_FILE = join(dir, 'discovery-bootstrap.json');
  process.env.RETRIES = '0';
  process.env.TIMEOUT_MS = '2000';
  delete process.env.DISCOVERY_TTL_HOURS;
  delete process.env.DISCOVERY_SORTS;
}

let importSeq = 0;
const freshImport = () => import(`./monitor.mjs?t=${++importSeq}`);

// ============================================================
// 场景②：冷启动只建基线，不产生 first_seen
// ============================================================
console.log('\n=== 场景②: 冷启动只建基线 ===');
{
  const dir = mkdtempSync(join(tmpdir(), 'events-coldstart-'));
  setupEnv(dir);

  const A = { universeId: 501, rootPlaceId: 601, name: 'Historical Game A', playerCount: 25000 };
  const A_GAME = { id: 501, rootPlaceId: 601, name: 'Historical Game A', playing: 25000, created: iso(30) };
  const WATCH_GAME = { id: 9001, rootPlaceId: 97598239454123, name: 'Grow a Garden 2', playing: 500, created: iso(400) };

  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.hostname === 'apis.roblox.com' && u.pathname.includes('/universes/v1/places/')) return json({ universeId: 9001 });
    if (u.hostname === 'apis.roblox.com' && u.pathname.includes('get-sort-content')) {
      const sort = u.searchParams.get('sortId');
      return json({ games: sort === 'up-and-coming' ? [A] : [] });
    }
    if (u.hostname === 'games.roblox.com') {
      const ids = (u.searchParams.get('universeIds') || '').split(',').map(Number);
      return json({ data: [WATCH_GAME, A_GAME].filter(g => ids.includes(g.id)) });
    }
    if (u.hostname.startsWith('rdap.')) return notFound();
    return dnsFail();
  };

  await freshImport();

  const discEvents = readJsonl(process.env.DISCOVERY_EVENTS_FILE);
  const gateEvents = readJsonl(process.env.GATE_EVENTS_FILE);
  expect('冷启动产生 source_baseline（up-and-coming 命中 A）',
    discEvents.some(e => e.eventType === 'source_baseline' && e.universeId === 501 && e.sortId === 'up-and-coming' && e.leftCensored === true));
  expect('冷启动不产生 source_first_seen', !discEvents.some(e => e.eventType === 'source_first_seen'));
  expect('冷启动 gate 层产生 gate_baseline（A 满足 gate D）',
    gateEvents.some(e => e.eventType === 'gate_baseline' && e.universeId === 501 && e.gate === 'D' && e.leftCensored === true));
  expect('冷启动不产生 gate_first_seen', !gateEvents.some(e => e.eventType === 'gate_first_seen'));
}

// ============================================================
// 场景③：组合故障冷启动（up-and-coming 成功 / top-trending 失败 / games API 部分失败），
// 第二轮全部恢复
// ============================================================
console.log('\n=== 场景③: 组合故障冷启动，第二轮全部恢复 ===');
{
  const dir = mkdtempSync(join(tmpdir(), 'events-combofail-'));
  setupEnv(dir);

  const A = { universeId: 701, rootPlaceId: 801, name: 'Combo Game A', playerCount: 25000 };
  const A_GAME = { id: 701, rootPlaceId: 801, name: 'Combo Game A', playing: 25000, created: iso(30) }; // young+high CCU -> gate D
  const WATCH_GAME = { id: 9001, rootPlaceId: 97598239454123, name: 'Grow a Garden 2', playing: 500, created: iso(400) };
  const FILLER_COUNT = 104; // + watch(1) + A(1) = 106 targets -> 2 games-batch chunks (100 + 6)
  const fillers = Array.from({ length: FILLER_COUNT }, (_, i) => ({
    chart: { universeId: 1000 + i, rootPlaceId: 2000 + i, name: `Filler Game ${i}`, playerCount: 20000 },
    game: { id: 1000 + i, rootPlaceId: 2000 + i, name: `Filler Game ${i}`, playing: 20000, created: iso(400) }, // old: never gates
  }));
  const allChart = [A, ...fillers.map(f => f.chart)];
  const gamesPool = new Map([[WATCH_GAME.id, WATCH_GAME], [A_GAME.id, A_GAME], ...fillers.map(f => [f.game.id, f.game])]);

  let round = 1;
  let gamesCallCount = 0;
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.hostname === 'apis.roblox.com' && u.pathname.includes('/universes/v1/places/')) return json({ universeId: 9001 });
    if (u.hostname === 'apis.roblox.com' && u.pathname.includes('get-sort-content')) {
      const sort = u.searchParams.get('sortId');
      if (sort === 'up-and-coming') return json({ games: allChart });
      if (round === 1) return serverError(); // top-trending down in round 1
      return json({ games: [A] }); // top-trending's first-ever success, round 2
    }
    if (u.hostname === 'games.roblox.com') {
      gamesCallCount++;
      if (round === 1 && gamesCallCount === 2) return serverError(); // 2nd chunk fails round 1 only
      const ids = (u.searchParams.get('universeIds') || '').split(',').map(Number);
      return json({ data: ids.map(id => gamesPool.get(id)).filter(Boolean) });
    }
    if (u.hostname.startsWith('rdap.')) return notFound();
    return dnsFail();
  };

  await freshImport(); // round 1
  let runs = readJsonl(process.env.DISCOVERY_RUNS_FILE);
  let discEvents = readJsonl(process.env.DISCOVERY_EVENTS_FILE);
  let gateEvents = readJsonl(process.env.GATE_EVENTS_FILE);

  expect('round1: up-and-coming 健康记录 ok', runs.find(r => r.sourceKey === 'explore-sort:up-and-coming')?.status === 'ok');
  expect('round1: top-trending 健康记录 error', runs.find(r => r.sourceKey === 'explore-sort:top-trending')?.status === 'error');
  expect('round1: games-batch 健康记录 partial', runs.find(r => r.sourceKey === 'games-batch')?.status === 'partial');
  expect('round1: up-and-coming 完成 bootstrap（写满 source_baseline，数量=105）',
    discEvents.filter(e => e.eventType === 'source_baseline' && e.sortId === 'up-and-coming').length === 1 + FILLER_COUNT);
  expect('round1: top-trending 未写任何 discovery 事件（调用本身失败）', !discEvents.some(e => e.sortId === 'top-trending'));
  expect('round1: 不产生任何 source_first_seen', !discEvents.some(e => e.eventType === 'source_first_seen'));
  expect('round1: gate 层因 games 部分失败，不完成 bootstrap、不产生任何 gate 事件', gateEvents.length === 0);

  round = 2;
  gamesCallCount = 0;
  await freshImport(); // round 2
  runs = readJsonl(process.env.DISCOVERY_RUNS_FILE);
  discEvents = readJsonl(process.env.DISCOVERY_EVENTS_FILE);
  gateEvents = readJsonl(process.env.GATE_EVENTS_FILE);

  expect('round2: top-trending 健康记录恢复 ok', runs.filter(r => r.sourceKey === 'explore-sort:top-trending').pop()?.status === 'ok');
  expect('round2: games-batch 健康记录恢复 ok', runs.filter(r => r.sourceKey === 'games-batch').pop()?.status === 'ok');
  expect('round2: top-trending 这一轮才完成 bootstrap（只对 A 写 baseline，不是部署轮）',
    discEvents.filter(e => e.eventType === 'source_baseline' && e.sortId === 'top-trending').length === 1);
  expect('round2: up-and-coming 不重复写 baseline（历史对象数量不变）',
    discEvents.filter(e => e.eventType === 'source_baseline' && e.sortId === 'up-and-coming').length === 1 + FILLER_COUNT);
  expect('round2: 全程（含这轮）不产生任何 source_first_seen', !discEvents.some(e => e.eventType === 'source_first_seen'));
  expect('round2: gate 层这一轮才完成 bootstrap（写 gate_baseline，不是 first_seen）',
    gateEvents.some(e => e.eventType === 'gate_baseline' && e.universeId === 701 && e.gate === 'D'));
  expect('round2: 不产生任何 gate_first_seen', !gateEvents.some(e => e.eventType === 'gate_first_seen'));
}

// ============================================================
// 场景④：三轮 TTL 测试 — 上榜 -> 掉榜(TTL 删除) -> 重新上榜，只产生一条 source_first_seen
// ============================================================
console.log('\n=== 场景④: TTL 删除后重新上榜 ===');
{
  const dir = mkdtempSync(join(tmpdir(), 'events-ttl-'));
  setupEnv(dir);
  process.env.DISCOVERY_TTL_HOURS = '0'; // 一旦掉榜，下一轮就该被 state 层 TTL 清掉
  process.env.DISCOVERY_SORTS = 'up-and-coming';

  const X = { universeId: 801, rootPlaceId: 901, name: 'TTL Game X', playerCount: 22000 };
  const X_GAME = { id: 801, rootPlaceId: 901, name: 'TTL Game X', playing: 22000, created: iso(200) }; // 老游戏，不触发 gate
  const WATCH_GAME = { id: 9001, rootPlaceId: 97598239454123, name: 'Grow a Garden 2', playing: 500, created: iso(400) };

  let onChart = false;
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.hostname === 'apis.roblox.com' && u.pathname.includes('/universes/v1/places/')) return json({ universeId: 9001 });
    if (u.hostname === 'apis.roblox.com' && u.pathname.includes('get-sort-content')) return json({ games: onChart ? [X] : [] });
    if (u.hostname === 'games.roblox.com') {
      const ids = (u.searchParams.get('universeIds') || '').split(',').map(Number);
      return json({ data: [WATCH_GAME, X_GAME].filter(g => ids.includes(g.id)) });
    }
    if (u.hostname.startsWith('rdap.')) return notFound();
    return dnsFail();
  };

  await freshImport();               // round0: bootstrap only, X 还不在榜
  onChart = true;
  await freshImport();               // round1: X 首次上榜 -> source_first_seen
  onChart = false;
  await freshImport();               // round2: X 掉榜；TTL=0 -> state 里的 X 被清掉
  onChart = true;
  await freshImport();               // round3: X 重新上榜

  const discEvents = readJsonl(process.env.DISCOVERY_EVENTS_FILE);
  const xFirstSeens = discEvents.filter(e => e.eventType === 'source_first_seen' && e.universeId === 801);
  const xBaselines = discEvents.filter(e => e.eventType === 'source_baseline' && e.universeId === 801);
  expect('X 全程只产生一条 source_first_seen（TTL 掉榜重新上榜不重复计）', xFirstSeens.length === 1);
  expect('X 没有产生 source_baseline（round0 时它还不在榜）', xBaselines.length === 0);
}

// ============================================================
// 场景⑤：跨榜测试 — 同游戏先中一个 sort、后中另一个 sort，各自独立的 source_first_seen
// ============================================================
console.log('\n=== 场景⑤: 跨榜测试 ===');
{
  const dir = mkdtempSync(join(tmpdir(), 'events-crosssort-'));
  setupEnv(dir);
  process.env.DISCOVERY_SORTS = 'up-and-coming,top-trending';

  const Y = { universeId: 851, rootPlaceId: 951, name: 'Cross Sort Game Y', playerCount: 22000 };
  const Y_GAME = { id: 851, rootPlaceId: 951, name: 'Cross Sort Game Y', playing: 22000, created: iso(200) };
  const WATCH_GAME = { id: 9001, rootPlaceId: 97598239454123, name: 'Grow a Garden 2', playing: 500, created: iso(400) };

  let topTrendingHasY = false;
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.hostname === 'apis.roblox.com' && u.pathname.includes('/universes/v1/places/')) return json({ universeId: 9001 });
    if (u.hostname === 'apis.roblox.com' && u.pathname.includes('get-sort-content')) {
      const sort = u.searchParams.get('sortId');
      if (sort === 'up-and-coming') return json({ games: [Y] }); // Y 从一开始就在这个榜
      return json({ games: topTrendingHasY ? [Y] : [] });
    }
    if (u.hostname === 'games.roblox.com') {
      const ids = (u.searchParams.get('universeIds') || '').split(',').map(Number);
      return json({ data: [WATCH_GAME, Y_GAME].filter(g => ids.includes(g.id)) });
    }
    if (u.hostname.startsWith('rdap.')) return notFound();
    return dnsFail();
  };

  await freshImport();   // round0: up-and-coming 冷启动看到 Y(baseline)；top-trending 冷启动看到空(baseline 也完成，但 0 条)
  topTrendingHasY = true;
  await freshImport();   // round1: top-trending 已 bootstrap 过 -> Y 第一次在这个榜出现 -> 真 first_seen

  const discEvents = readJsonl(process.env.DISCOVERY_EVENTS_FILE);
  expect('Y 在 up-and-coming 下是 baseline（round0 就在榜）',
    discEvents.some(e => e.eventType === 'source_baseline' && e.universeId === 851 && e.sortId === 'up-and-coming'));
  expect('Y 在 top-trending 下是独立的 source_first_seen（不是 baseline）',
    discEvents.some(e => e.eventType === 'source_first_seen' && e.universeId === 851 && e.sortId === 'top-trending'));
  expect('Y 的两条事件对应两个不同 sortId', new Set(discEvents.filter(e => e.universeId === 851).map(e => e.sortId)).size === 2);
}

// ============================================================
// 场景⑥：games 批量 API 整体故障 — source_first_seen 不受影响，gate_first_seen 延后到恢复才产生
// （gate 层此前已经 bootstrap 过，所以恢复后写的是 first_seen，不是 baseline —— 跟场景③的
//  "bootstrap 阶段被部分失败推迟" 是两回事，这里测的是 "已 bootstrap 后，稳态下的单次故障"）
// ============================================================
console.log('\n=== 场景⑥: games 批量 API 整体故障 ===');
{
  const dir = mkdtempSync(join(tmpdir(), 'events-gamesfail-'));
  setupEnv(dir);
  process.env.DISCOVERY_SORTS = 'up-and-coming';

  const Z = { universeId: 901, rootPlaceId: 1001, name: 'Games Fail Game Z', playerCount: 30000 };
  const Z_GAME = { id: 901, rootPlaceId: 1001, name: 'Games Fail Game Z', playing: 30000, created: iso(10) }; // young+high CCU -> gate D
  const WATCH_GAME = { id: 9001, rootPlaceId: 97598239454123, name: 'Grow a Garden 2', playing: 500, created: iso(400) };

  let round = 0; // 0: bootstrap（Z 不在榜，games API 正常，完成 source+gate 两层 bootstrap）
                 // 1: Z 上榜 + games API 整体故障
                 // 2: games API 恢复
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.hostname === 'apis.roblox.com' && u.pathname.includes('/universes/v1/places/')) return json({ universeId: 9001 });
    if (u.hostname === 'apis.roblox.com' && u.pathname.includes('get-sort-content')) return json({ games: round >= 1 ? [Z] : [] });
    if (u.hostname === 'games.roblox.com') {
      if (round === 1) return serverError(); // 唯一一个 chunk 整体失败
      const ids = (u.searchParams.get('universeIds') || '').split(',').map(Number);
      return json({ data: [WATCH_GAME, Z_GAME].filter(g => ids.includes(g.id)) });
    }
    if (u.hostname.startsWith('rdap.')) return notFound();
    return dnsFail();
  };

  await freshImport(); // round0
  round = 1;
  await freshImport(); // round1
  let runs = readJsonl(process.env.DISCOVERY_RUNS_FILE);
  let discEvents = readJsonl(process.env.DISCOVERY_EVENTS_FILE);
  let gateEvents = readJsonl(process.env.GATE_EVENTS_FILE);

  expect('round1: games-batch 健康记录 error', runs.filter(r => r.sourceKey === 'games-batch').pop()?.status === 'error');
  expect('round1: Z 的 source_first_seen 正常产生（不受 games API 故障影响）',
    discEvents.some(e => e.eventType === 'source_first_seen' && e.universeId === 901));
  expect('round1: 不产生任何 gate 事件（games API 全挂，Z 这轮压根没有 playing/age 数据）', gateEvents.length === 0);

  round = 2;
  await freshImport(); // round2
  runs = readJsonl(process.env.DISCOVERY_RUNS_FILE);
  gateEvents = readJsonl(process.env.GATE_EVENTS_FILE);
  discEvents = readJsonl(process.env.DISCOVERY_EVENTS_FILE);

  expect('round2: games-batch 健康记录恢复 ok', runs.filter(r => r.sourceKey === 'games-batch').pop()?.status === 'ok');
  expect('round2: Z 不再产生第二条 source_first_seen',
    discEvents.filter(e => e.eventType === 'source_first_seen' && e.universeId === 901).length === 1);
  expect('round2: gate 层已在 round0 bootstrap 过 -> 恢复后写的是 gate_first_seen（不是 baseline）',
    gateEvents.some(e => e.eventType === 'gate_first_seen' && e.universeId === 901 && e.gate === 'D'));
  expect('round2: 不产生 gate_baseline（gate 层不是这一轮才 bootstrap 的）',
    !gateEvents.some(e => e.eventType === 'gate_baseline' && e.universeId === 901));
}

console.log(failed ? `\n${failed} 条回归失败` : '\n回归全过');
process.exit(failed ? 1 : 0);
