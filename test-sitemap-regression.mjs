#!/usr/bin/env node
// 离线回归：sitemap-monitor 的冷启动/diff/富化逻辑安全网 + Part 0.2 的三个修复 + 富化回填队列/基线。
// 不碰真实网络、不碰真实 state。
//   1. 冷启动只建基线，不产出 newly-seen 文件（"全部都是新的"没有信息量）
//   2. 第二轮出现新 placeId 时，被正确识别为 first_seen，CCU/age 富化成功，健康记录 ok
//   3. 分片部分失败：非零退出码，known.json 不被残缺集合覆盖，健康记录 partial
//   4. 掉榜后重新上榜：产生 reentered（不是第二条 first_seen），everSeenPlaceIds 不重复计
//   5. 冷启动写出 sitemap-baseline.json（leftCensored、placeIds 齐全），后续轮次不改写
//   6. 发现时富化失败：事件 universeId null、placeId 进队列（seenAt 与事件一致）、enrich 健康非 ok
//   7. 下一轮 API 恢复：追加 enriched 事件（原始 seenAt、ageDaysAtDiscovery 按原始 seenAt 算）、
//      队列清除、enrich 健康 ok
//   8. ENRICH_ONLY=1：不抓 sitemap、不写 roblox-sitemap 健康记录；队列种子扫描正确
//      （universeId null 且无后续 enriched 的才进 pending）
//   9. attempts 到 8 移入 failed 留审计
// 跑法：node test-sitemap-regression.mjs；断言失败即非零退出。

import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'sitemap-regression-'));
process.env.KNOWN_FILE = join(tmp, 'known.json');
process.env.NEWSEEN_FILE = join(tmp, 'newlyseen.jsonl');
process.env.RUNS_FILE = join(tmp, 'runs.jsonl');
process.env.QUEUE_FILE = join(tmp, 'enrich-queue.json');
process.env.BASELINE_FILE = join(tmp, 'baseline.json');
process.env.RETRIES = '0';
process.env.TIMEOUT_MS = '2000';

const DAY = 86400000;
const INDEX_XML = `<?xml version="1.0"?><sitemapindex><sitemap><loc>https://fake/shard1.xml</loc></sitemap><sitemap><loc>https://fake/shard2.xml</loc></sitemap></sitemapindex>`;
const SHARD1 = `<?xml version="1.0"?><urlset><url><loc>https://www.roblox.com/games/111/Old-Game</loc></url><url><loc>https://www.roblox.com/games/222/Another-Game</loc></url></urlset>`;
const SHARD2_V1 = `<?xml version="1.0"?><urlset><url><loc>https://www.roblox.com/games/333/Third-Game</loc></url></urlset>`;
// 第二轮：333 还在，新增 444
const SHARD2_V2 = `<?xml version="1.0"?><urlset><url><loc>https://www.roblox.com/games/333/Third-Game</loc></url><url><loc>https://www.roblox.com/games/444/New-Hot-Game</loc></url></urlset>`;
// 第六轮：新增 555（universe 解析在 round 6 被 403）
const SHARD2_V3 = `<?xml version="1.0"?><urlset><url><loc>https://www.roblox.com/games/333/Third-Game</loc></url><url><loc>https://www.roblox.com/games/444/New-Hot-Game</loc></url><url><loc>https://www.roblox.com/games/555/Fail-Then-Recover</loc></url></urlset>`;

let round = 1;
const NEW_GAME = { id: 999, rootPlaceId: 444, name: 'New Hot Game', playing: 12345, created: new Date(Date.now() - 3 * DAY).toISOString() };
const GAME_555 = { id: 1555, rootPlaceId: 555, name: 'Fail Then Recover', playing: 777, created: new Date(Date.now() - 5 * DAY).toISOString() };
const GAME_666 = { id: 1666, rootPlaceId: 666, name: 'Seeded Backfill', playing: 42, created: new Date(Date.now() - 30 * DAY).toISOString() };
const GAMES_BY_UNIVERSE = { 999: NEW_GAME, 1555: GAME_555, 1666: GAME_666 };

const text = s => new Response(s, { status: 200 });
const json = obj => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('sitemap-games.xml')) {
    if (round >= 8) return new Response('', { status: 500 }); // round8+ 是 ENRICH_ONLY——抓了 sitemap 就是 bug
    return text(INDEX_XML);
  }
  if (u.includes('shard1.xml')) return text(SHARD1);
  if (u.includes('shard2.xml')) {
    if (round === 3) return new Response('', { status: 500 }); // round3: 分片故障
    if (round >= 6) return text(SHARD2_V3);
    return text((round === 1 || round === 4) ? SHARD2_V1 : SHARD2_V2); // round4: 444 掉榜；round2/5: 444 在榜
  }
  if (u.includes('/universes/v1/places/444/universe')) return json({ universeId: 999 });
  if (u.includes('/universes/v1/places/555/universe')) {
    if (round === 6) return new Response('', { status: 403 }); // 发现当轮富化失败
    return json({ universeId: 1555 });
  }
  if (u.includes('/universes/v1/places/666/universe')) return json({ universeId: 1666 });
  if (u.includes('/universes/v1/places/777/universe')) return new Response('', { status: 403 }); // 永远失败
  if (u.includes('games.roblox.com')) {
    const ids = new URL(u).searchParams.get('universeIds').split(',').map(Number);
    return json({ data: ids.map(id => GAMES_BY_UNIVERSE[id]).filter(Boolean) });
  }
  throw new Error('unexpected fetch in test: ' + u);
};

let failed = 0;
const expect = (label, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failed += 1; };
const readRuns = () => readFileSync(process.env.RUNS_FILE, 'utf8').trim().split('\n').map(l => JSON.parse(l));
const readEvents = () => readFileSync(process.env.NEWSEEN_FILE, 'utf8').trim().split('\n').map(l => JSON.parse(l));
const readQueue = () => JSON.parse(readFileSync(process.env.QUEUE_FILE, 'utf8'));

// ---- round 1: 冷启动 ----
await import(`./sitemap-monitor.mjs?round=1`);
const known1 = JSON.parse(readFileSync(process.env.KNOWN_FILE, 'utf8'));
expect('冷启动记录 3 个已知游戏（currentPlaceIds）', known1.currentPlaceIds.length === 3);
expect('冷启动记录 3 个已知游戏（everSeenPlaceIds）', known1.everSeenPlaceIds.length === 3);
let newlySeenExistsAfterRound1 = true;
try { readFileSync(process.env.NEWSEEN_FILE, 'utf8'); } catch { newlySeenExistsAfterRound1 = false; }
expect('冷启动不产出 newly-seen 文件', !newlySeenExistsAfterRound1);
const baseline1 = JSON.parse(readFileSync(process.env.BASELINE_FILE, 'utf8'));
expect('冷启动写出 baseline（leftCensored true）', baseline1.leftCensored === true);
expect('baseline placeIds 齐全', baseline1.placeIds.length === 3 && [111, 222, 333].every(id => baseline1.placeIds.includes(id)));
expect('baseline 带 generatedAt', typeof baseline1.generatedAt === 'string' && !Number.isNaN(Date.parse(baseline1.generatedAt)));
const baselineRaw = readFileSync(process.env.BASELINE_FILE, 'utf8');

// ---- round 2: sitemap 出现新游戏 444 ----
round = 2;
await import(`./sitemap-monitor.mjs?round=2`);
const lines = readEvents();
expect('第二轮识别出 1 个新增', lines.length === 1);
expect('新增事件类型是 first_seen', lines[0]?.eventType === 'first_seen');
expect('新增游戏 placeId 正确', lines[0]?.placeId === 444);
expect('新增游戏 CCU 富化成功', lines[0]?.playing === 12345);
expect('新增游戏 age 富化成功（约 3 天）', Math.abs((lines[0]?.ageDaysAtDiscovery ?? -99) - 3) < 0.5);
const known2 = JSON.parse(readFileSync(process.env.KNOWN_FILE, 'utf8'));
expect('第二轮 currentPlaceIds 更新为 4 个', known2.currentPlaceIds.length === 4);
expect('第二轮 everSeenPlaceIds 累加为 4 个', known2.everSeenPlaceIds.length === 4);
expect('totalRuns 累加到 2', known2.totalRuns === 2);

const shardRuns2 = readRuns().filter(r => r.sourceKey === 'roblox-sitemap');
expect('两轮都产生 ok 健康记录', shardRuns2.length === 2 && shardRuns2.every(r => r.status === 'ok'));
expect('健康记录分片数正确（2 个分片，2 个成功）', shardRuns2.every(r => r.fetchedCount === 2 && r.eligibleCount === 2));
const enrichRuns2 = readRuns().filter(r => r.sourceKey === 'roblox-sitemap-enrich');
expect('两轮都产生 enrich 健康记录（独立轨迹）', enrichRuns2.length === 2 && enrichRuns2.every(r => r.status === 'ok'));
expect('第二轮 enrich 记录计数正确（1 尝试 1 成功）', enrichRuns2[1]?.eligibleCount === 1 && enrichRuns2[1]?.fetchedCount === 1);

// ---- round 3: 一个分片失败——不能用残缺集合覆盖基线，非零退出 ----
round = 3;
const priorKnown = readFileSync(process.env.KNOWN_FILE, 'utf8');
let round3ExitCode = null;
{
  const realExit = process.exit;
  // sitemap-monitor.mjs 用 process.exitCode（不调用 process.exit），這裡只是保险起见別讓意外的
  // exit 调用杀掉整个测试进程；同时读 process.exitCode 判断失败是否被正确标记。
  process.exit = (code) => { round3ExitCode = code; };
  process.exitCode = 0;
  try { await import(`./sitemap-monitor.mjs?round=3`); }
  finally { round3ExitCode = round3ExitCode ?? process.exitCode; process.exit = realExit; }
}
expect('分片部分失败：非零退出码', round3ExitCode === 1 || process.exitCode === 1);
process.exitCode = 0; // 复位，不让这次的失败测试污染最终的测试脚本退出码
const knownAfterRound3 = readFileSync(process.env.KNOWN_FILE, 'utf8');
expect('分片部分失败：known.json 未被覆盖（残缺集合不落盘）', knownAfterRound3 === priorKnown);
const runsAfterRound3 = readRuns().filter(r => r.sourceKey === 'roblox-sitemap');
expect('分片部分失败：健康记录里有一条 partial', runsAfterRound3.some(r => r.status === 'partial'));

// ---- round 4: 恢复，且验证 reentered（444 掉榜后重新上榜，不是第二条 first_seen）----
round = 4;
await import(`./sitemap-monitor.mjs?round=4`); // SHARD2_V1（444 消失，回到只有 333）
round = 5;
await import(`./sitemap-monitor.mjs?round=5`); // SHARD2_V2（444 重新出现）
const linesAfter = readEvents();
const reenteredLines = linesAfter.filter(l => l.placeId === 444 && l.eventType === 'reentered');
const firstSeenLines444 = linesAfter.filter(l => l.placeId === 444 && l.eventType === 'first_seen');
expect('444 重新上榜产生 reentered 事件', reenteredLines.length === 1);
expect('444 全程只有一条 first_seen（不是两条）', firstSeenLines444.length === 1);
const knownFinal = JSON.parse(readFileSync(process.env.KNOWN_FILE, 'utf8'));
expect('444 重新上榜后 everSeenPlaceIds 仍然只记一次', knownFinal.everSeenPlaceIds.filter(id => id === 444).length === 1);

// ---- round 6: 新增 555，发现时富化失败（universe API 403）----
round = 6;
await import(`./sitemap-monitor.mjs?round=6`);
const event555 = readEvents().find(l => l.placeId === 555 && l.eventType === 'first_seen');
expect('555 的 first_seen 事件照常写入（universeId null）', event555 !== undefined && event555.universeId === null);
const queue6 = readQueue();
expect('555 进 pending 队列', queue6.pending['555'] !== undefined);
expect('队列 seenAt 等于事件的 seenAt', queue6.pending['555']?.seenAt === event555?.seenAt);
const enrichRun6 = readRuns().filter(r => r.sourceKey === 'roblox-sitemap-enrich').at(-1);
expect('发现时富化失败：enrich 健康记录非 ok', enrichRun6?.status === 'error');
expect('发现时富化失败：分片健康记录仍是 ok（两条轨迹独立）',
  readRuns().filter(r => r.sourceKey === 'roblox-sitemap').at(-1)?.status === 'ok');

// ---- round 7: API 恢复，队列回填 555 ----
round = 7;
await import(`./sitemap-monitor.mjs?round=7`);
const enriched555 = readEvents().find(l => l.placeId === 555 && l.eventType === 'enriched');
expect('回填追加 enriched 事件', enriched555 !== undefined);
expect('enriched 事件保留原始 seenAt', enriched555?.seenAt === event555?.seenAt);
expect('enriched 事件带 enrichedAt', typeof enriched555?.enrichedAt === 'string');
expect('enriched 富化字段正确（universeId/name/playingAtEnrich）',
  enriched555?.universeId === 1555 && enriched555?.name === 'Fail Then Recover' && enriched555?.playingAtEnrich === 777);
expect('ageDaysAtDiscovery 按原始 seenAt 计算（约 5 天）', Math.abs((enriched555?.ageDaysAtDiscovery ?? -99) - 5) < 0.1);
const queue7 = readQueue();
expect('回填成功后队列该项清除', queue7.pending['555'] === undefined && queue7.failed['555'] === undefined);
const enrichRun7 = readRuns().filter(r => r.sourceKey === 'roblox-sitemap-enrich').at(-1);
expect('回填成功：enrich 健康 ok（1 尝试 1 成功）',
  enrichRun7?.status === 'ok' && enrichRun7?.eligibleCount === 1 && enrichRun7?.fetchedCount === 1);

// ---- round 8: ENRICH_ONLY + 队列种子（删掉 queue 文件，让它从事件日志重建）----
// 种子该排除 555（已有 enriched 事件），该包含手工注入的 666（universeId null、无 enriched）。
// 666 的 seenAt 是 10 天前、游戏 created 30 天前——ageDaysAtDiscovery 必须是 20（按原始 seenAt），
// 用"现在"算会得 30，这里能抓出来。
const seenAt666 = new Date(Date.now() - 10 * DAY).toISOString();
appendFileSync(process.env.NEWSEEN_FILE, JSON.stringify({
  eventType: 'first_seen', seenAt: seenAt666, placeId: 666, slug: 'Seeded-Backfill',
  universeId: null, name: null, playing: null, createdAt: null, ageDaysAtDiscovery: null,
}) + '\n');
rmSync(process.env.QUEUE_FILE);
const knownBeforeRound8 = readFileSync(process.env.KNOWN_FILE, 'utf8');
const shardRunCountBefore8 = readRuns().filter(r => r.sourceKey === 'roblox-sitemap').length;
round = 8;
process.env.ENRICH_ONLY = '1';
process.exitCode = 0;
await import(`./sitemap-monitor.mjs?round=8`);
expect('ENRICH_ONLY 不写 roblox-sitemap 健康记录',
  readRuns().filter(r => r.sourceKey === 'roblox-sitemap').length === shardRunCountBefore8);
expect('ENRICH_ONLY 不碰 known.json', readFileSync(process.env.KNOWN_FILE, 'utf8') === knownBeforeRound8);
expect('ENRICH_ONLY 不设非零退出码（没抓 sitemap 就没有分片失败）', (process.exitCode ?? 0) === 0);
const enriched666 = readEvents().find(l => l.placeId === 666 && l.eventType === 'enriched');
expect('种子回填 666 成功（保留原始 seenAt）', enriched666 !== undefined && enriched666.seenAt === seenAt666);
expect('666 的 ageDaysAtDiscovery 按原始 seenAt 计算（20 天，不是 30）',
  Math.abs((enriched666?.ageDaysAtDiscovery ?? -99) - 20) < 0.1);
expect('种子排除已有 enriched 事件的 555（不重复回填）',
  readEvents().filter(l => l.placeId === 555 && l.eventType === 'enriched').length === 1);
expect('种子回填后队列清空', Object.keys(readQueue().pending).length === 0);

// ---- round 9: attempts 到 8 移入 failed ----
writeFileSync(process.env.QUEUE_FILE, JSON.stringify({
  pending: { 777: { seenAt: new Date(Date.now() - 5 * DAY).toISOString(), attempts: 7 } },
  failed: {}, updatedAt: new Date().toISOString(),
}, null, 2));
round = 9;
await import(`./sitemap-monitor.mjs?round=9`);
const queue9 = readQueue();
expect('第 8 次失败后移出 pending', queue9.pending['777'] === undefined);
expect('移入 failed 留审计（attempts 8）', queue9.failed['777']?.attempts === 8);
expect('全部失败：enrich 健康记录 error',
  readRuns().filter(r => r.sourceKey === 'roblox-sitemap-enrich').at(-1)?.status === 'error');
delete process.env.ENRICH_ONLY;

// ---- baseline 全程不被后续轮次改写 ----
expect('后续轮次不改写 baseline 文件', readFileSync(process.env.BASELINE_FILE, 'utf8') === baselineRaw);

console.log(failed ? `\n${failed} 条回归失败` : '\n回归全过');
process.exit(failed ? 1 : 0);
