import assert from 'node:assert/strict';
import { test } from 'node:test';
import { leagueConfig } from './fixtures.js';
import { dateForMap, handicapForPlayer, playerStats, roundStats, standingsForWeek } from '../domain.js';
import { mergeCourseData, validateCourse } from '../course-data.js';
import { courseIdentity, discoverSource, scrapeCourse, updateFeed } from '../scripts/scrape-courses.js';

function fixture() {
  return { config: leagueConfig, players: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    courses: [557, 558, 559, 560, 561, 562].map(mapNumber => ({
      mapNumber, courseDate: dateForMap(mapNumber, leagueConfig), par: 20, source: 'sample',
    })),
    scores: [558, 559, 560, 561, 562].map((mapNumber, index) => ({ playerId: 'a', mapNumber, total: [22, 24, 26, 1, 100][index] })),
  };
}

function gameCourse(overrides = {}) {
  return { mapNumber: 561, courseDate: '2026-10-15', source: 'game', fetchedAt: '2026-10-15T12:00:00Z',
    averageScore: 24.7, par: 25, percentFinished: 82, minScore: 1, maxScore: 100,
    percentiles: { 25: { first: 37, repeat: 43 } }, ...overrides };
}

test('handicap uses earlier par-relative rounds, never the round itself or future scores', () => {
  const league = fixture();
  assert.deepEqual(handicapForPlayer(league, 'a', 561), { handicap: 4, rounds: 3, expected: 24 });
  league.scores.reverse();
  assert.deepEqual(handicapForPlayer(league, 'a', 561), { handicap: 4, rounds: 3, expected: 24 });
  assert.deepEqual(handicapForPlayer(league, 'a', 560), { handicap: null, rounds: 2, expected: null });
  assert.deepEqual(handicapForPlayer(league, 'new', 561), { handicap: null, rounds: 0, expected: null });
});

test('missing par is excluded and a missing daily par still allows an existing handicap', () => {
  const league = fixture();
  league.courses = league.courses.filter(course => course.mapNumber !== 561);
  assert.deepEqual(handicapForPlayer(league, 'a', 561), { handicap: 4, rounds: 3, expected: null });
  league.courses = league.courses.filter(course => course.mapNumber !== 560);
  assert.equal(handicapForPlayer(league, 'a', 561).handicap, null);
});

test('uses the most recent 20 eligible rounds and supports negative handicaps', () => {
  const league = fixture();
  league.courses = Array.from({ length: 25 }, (_, index) => ({
    mapNumber: 530 + index, courseDate: dateForMap(530 + index, leagueConfig), par: 50, source: 'sample',
  }));
  league.courses.push({ mapNumber: 561, courseDate: '2026-10-15', par: 20 });
  league.scores = league.courses.filter(course => course.mapNumber < 561).map((course, index) => ({
    playerId: 'a', mapNumber: course.mapNumber, total: index < 5 ? 100 : 1,
  }));
  assert.deepEqual(handicapForPlayer(league, 'a', 561), { handicap: -49, rounds: 20, expected: 1 });
});

test('daily ranks preserve ties and groups include tied scores in the upper bound', () => {
  const league = fixture();
  league.scores = [{ playerId: 'a', mapNumber: 561, total: 25 },
    { playerId: 'b', mapNumber: 561, total: 25 }, { playerId: 'c', mapNumber: 561, total: 30 }];
  let stats = roundStats(league, league.scores[0]);
  assert.equal(stats.rank, 1);
  assert.equal(stats.topPercent, 67);
  assert.equal(stats.players, 3);
  assert.equal(stats.versusPar, 5);
  assert.equal(stats.global, null);
  assert.equal(roundStats(league, league.scores[2]).rank, 3);
  assert.equal(roundStats(league, league.scores[2]).topPercent, 100);
  league.scores.pop();
  assert.equal(roundStats(league, league.scores[0]).topPercent, 100);
  league.scores.pop();
  assert.equal(roundStats(league, league.scores[0]).topPercent, 100);
});

test('player stats exclude future maps and handle a player with no history', () => {
  assert.deepEqual(playerStats(fixture(), 'a'), { rounds: 4, average: 18.25, best: 1 });
  assert.deepEqual(playerStats(fixture(), 'new'), { rounds: 0, average: null, best: null });
});

test('assigned weekly scores leave handicap and all played-round statistics unchanged', () => {
  const league = fixture();
  league.players = league.players.map(player => ({ ...player, name: player.id }));
  const before = {
    handicap: handicapForPlayer(league, 'a', 561),
    player: playerStats(league, 'a'),
    round: roundStats(league, league.scores[3]),
  };
  const weekly = standingsForWeek(league, '2026-10-12');
  assert.equal(weekly.rows.find(row => row.player.id === 'b').total, 75);
  assert.equal(weekly.scores.filter(score => score.assigned).length, 6);
  assert.deepEqual(playerStats(league, 'b'), { rounds: 0, average: null, best: null });
  assert.deepEqual(handicapForPlayer(league, 'b', 561), { handicap: null, rounds: 0, expected: null });
  league.scores.push(...weekly.scores.filter(score => score.assigned),
    { playerId: 'a', mapNumber: 557, total: 1000, assigned: true });
  assert.deepEqual(handicapForPlayer(league, 'a', 561), before.handicap);
  assert.deepEqual(playerStats(league, 'a'), before.player);
  assert.deepEqual(roundStats(league, league.scores[3]), before.round);
  assert.deepEqual(standingsForWeek(league, '2026-10-12'), weekly);
});

test('game snapshots replace matching sample courses and expose both global groups', () => {
  const league = fixture();
  const course = gameCourse();
  const merged = mergeCourseData(league, { version: 1, courses: [course] });
  assert.equal(merged.courses.length, league.courses.length);
  assert.equal(merged.courses.find(value => value.mapNumber === 561).par, 25);
  const stats = roundStats(merged, { playerId: 'a', mapNumber: 561, total: 25 });
  assert.deepEqual(stats.global, { first: 37, repeat: 43 });
  assert.equal(stats.versusPar, 0);
  assert.equal(stats.versusExpected, -4);
  assert.equal(league.courses.find(value => value.mapNumber === 561).source, 'sample');
  assert.equal(roundStats(merged, { playerId: 'a', mapNumber: 561, total: 1000 }).global, null);
});

test('snapshots with an unrelated map date cannot attach stats to the demo', () => {
  const league = fixture();
  const merged = mergeCourseData(league, { version: 1, courses: [gameCourse({ courseDate: '2026-10-14' })] });
  assert.equal(merged.courses.find(course => course.mapNumber === 561).source, 'sample');
});

test('malformed feeds and invalid values never replace saved course data', () => {
  for (const patch of [{ par: 100 }, { averageScore: null }, { percentFinished: 101 }, { fetchedAt: 'invalid' },
    { percentiles: { 25: { first: -1, repeat: 43 } } }, { percentiles: [] }, { source: 'sample' }]) {
    assert.equal(validateCourse(gameCourse(patch)), false);
    assert.throws(() => mergeCourseData(fixture(), { version: 1, courses: [gameCourse(patch)] }));
  }
  assert.throws(() => updateFeed({ version: 2, courses: [] }, gameCourse()));
});

const html = '<script type="module" crossorigin src="./assets/main-current.js"></script><script>const utcLaunchDate = "2025-04-02"; const offsetHours = 4;</script>';
const script = 'async function stats(score) { return fetch("/api/stats?score=" + score); }';
const statsResponse = { averageScore: 2.6, minScore: 1, maxScore: 3, percentFinished: 80,
  percentile: 40, firstAttemptPercentile: 30 };

test('discovers the game source without a fixed asset hash and respects the 04:00 UTC reset', () => {
  const source = discoverSource(html, script);
  assert.equal(source.statsPath, '/api/stats?score=');
  assert.deepEqual(courseIdentity(source, new Date('2026-10-15T03:59:59Z')), { courseDate: '2026-10-14', mapNumber: 560 });
  assert.deepEqual(courseIdentity(source, new Date('2026-10-15T04:00:00Z')), { courseDate: '2026-10-15', mapNumber: 561 });
  assert.throws(() => discoverSource('<html/>', script), /changed/);
});

test('scraper collects daily par and per-score percentiles with read-only requests', async () => {
  const urls = [];
  const request = async (url, options) => {
    assert.equal(options.method, undefined);
    urls.push(String(url));
    return { ok: true, text: async () => urls.length === 1 ? html : script, json: async () => statsResponse };
  };
  const course = await scrapeCourse({ request, now: () => new Date('2026-10-15T12:00:00Z'), delay: async () => {} });
  assert.equal(course.par, 3);
  assert.equal(course.mapNumber, 561);
  assert.deepEqual(Object.keys(course.percentiles), ['1', '2', '3']);
  assert.ok(urls.every(url => url.startsWith('https://kindahardgolf.com/')));
  assert.equal(urls.length, 5);
  const updated = updateFeed({ version: 1, courses: [gameCourse({ mapNumber: 560, courseDate: '2026-10-14' }), gameCourse()] }, course);
  assert.equal(updated.courses.length, 2);
  assert.equal(updated.courses[1].par, 3);
});

test('scraper retries a temporary failure, rejects invalid stats and refuses a reset during collection', async () => {
  let calls = 0;
  const request = async url => {
    calls++;
    if (calls === 1) return { ok: false, status: 500 };
    return { ok: true, text: async () => String(url).endsWith('.js') ? script : html, json: async () => statsResponse };
  };
  await scrapeCourse({ request, delay: async () => {}, now: () => new Date('2026-10-15T12:00:00Z') });
  assert.equal(calls, 6);
  const invalid = async url => ({ ok: true, text: async () => String(url).endsWith('.js') ? script : html,
    json: async () => ({ ...statsResponse, averageScore: null }) });
  await assert.rejects(scrapeCourse({ request: invalid, delay: async () => {} }), /invalid daily statistics/);
  let times = 0;
  const changingClock = () => new Date(times++ === 0 ? '2026-10-15T03:59:59Z' : '2026-10-15T04:00:01Z');
  await assert.rejects(scrapeCourse({ request, delay: async () => {}, now: changingClock }), /changed during collection/);
});
