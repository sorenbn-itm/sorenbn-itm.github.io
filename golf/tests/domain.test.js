import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exampleScore, leagueConfig } from '../config.js';
import { addDays, awardsForWeek, dateForMap, dateInTimeZone, mapForDate, mondayOf, parseScore,
  standingsForWeek, weekDates, weekNumber } from '../domain.js';

test('parses the supplied share format and preserves skipped checkpoints', () => {
  const result = parseScore(exampleScore);
  assert.equal(result.mapNumber, 561);
  assert.equal(result.total, 25);
  assert.equal(result.checkpoints.length, 9);
  assert.deepEqual(result.checkpoints.find(checkpoint => checkpoint.index === 2), { index: 2, shots: null });
  assert.deepEqual(result.checkpoints.at(-1), { index: 0, shots: 3 });
});

test('accepts CRLF, nonbreaking spaces, gendered golfer emoji and an en dash', () => {
  const text = exampleScore.replaceAll('\n', '\r\n').replaceAll(' ', '\u00a0')
    .replace('🏌️', '🏌️‍♂️').replace('⛳\u00a0-', '⛳\u00a0–');
  assert.equal(parseScore(text).total, 25);
});

test('rejects an inconsistent total, duplicate checkpoints and multiple results', () => {
  assert.throws(() => parseScore(exampleScore.replace('📝 25', '📝 26')), /don’t add up/);
  assert.throws(() => parseScore(exampleScore.replace('7.⛳ 2', '8.⛳ 2')), /repeated/);
  assert.throws(() => parseScore(`${exampleScore}\n${exampleScore}`), /one map number/);
});

test('rejects missing or truncated checkpoint data and malformed totals', () => {
  assert.throws(() => parseScore('Kinda Hard Golf #561\n📝 25'), /breakdown/);
  assert.throws(() => parseScore(exampleScore.replace('3.⛳ 2', '3.⛳ …')), /incomplete/);
  for (const value of ['-25', '25.5', 'NaN', '0', '10001']) {
    assert.throws(() => parseScore(exampleScore.replace('📝 25', `📝 ${value}`)));
  }
});

test('calendar arithmetic works across DST, leap days and ISO week-year boundaries', () => {
  assert.equal(addDays('2026-10-24', 2), '2026-10-26');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(mondayOf('2027-01-01'), '2026-12-28');
  assert.equal(mondayOf('2026-10-18'), '2026-10-12');
  assert.equal(weekNumber('2027-01-01'), 53);
  assert.equal(weekNumber('2024-12-30'), 1);
  assert.equal(mapForDate('2026-10-12', leagueConfig), 558);
  assert.equal(dateForMap(561, leagueConfig), '2026-10-15');
});

test('competition weeks are Monday through Friday', () => {
  assert.deepEqual(weekDates('2026-10-12', leagueConfig),
    ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']);
});

test('Copenhagen week rollover respects both summer and winter offsets', () => {
  for (const [before, after, previousWeek, nextWeek] of [
    ['2026-10-18T21:59:59Z', '2026-10-18T22:00:00Z', '2026-10-12', '2026-10-19'],
    ['2026-10-25T22:59:59Z', '2026-10-25T23:00:00Z', '2026-10-19', '2026-10-26'],
    ['2026-03-29T21:59:59Z', '2026-03-29T22:00:00Z', '2026-03-23', '2026-03-30'],
  ]) {
    assert.equal(mondayOf(dateInTimeZone(before, leagueConfig.timeZone)), previousWeek);
    assert.equal(mondayOf(dateInTimeZone(after, leagueConfig.timeZone)), nextWeek);
  }
});

test('checkpoint counts vary by map, including a level with only a start', () => {
  for (const count of [1, 4, 9, 16]) {
    const lines = Array.from({ length: count }, (_, index) => `${index}.${index ? '⛳' : '🏌️'} 2`);
    const parsed = parseScore(`Kinda Hard Golf #561\n📝 ${count * 2}\n${lines.join('\n')}`);
    assert.equal(parsed.checkpoints.length, count);
    assert.equal(parsed.total, count * 2);
  }
});

function leagueFor(totals, today = '2026-10-15') {
  const players = totals.map((_, index) => ({ id: String(index), name: `Player ${index}` }));
  const scores = totals.flatMap((days, index) => days.flatMap((total, day) =>
    total === null ? [] : [{ playerId: String(index), mapNumber: 558 + day, total }]));
  return { config: { ...leagueConfig, today }, players, scores, identity: null };
}

test('incomplete players cannot beat complete players with fewer rounds', () => {
  const league = leagueFor([[20, 20, 20, 20], [1, null, null, null], [21, 21, 21, 21]]);
  const { rows, dueDates } = standingsForWeek(league, '2026-10-12');
  assert.deepEqual(rows.map(row => row.player.id), ['0', '2', '1']);
  assert.deepEqual(rows.map(row => row.rank), [1, 2, null]);
  assert.equal(dueDates.length, 4);
  assert.equal(rows.at(-1).total, 1);
});

test('ties use competition ranks and daily best includes all submitted rounds', () => {
  const league = leagueFor([[20, 20, 20, 20], [19, 21, 20, 20], [22, 22, 22, 22], [10]]);
  const result = standingsForWeek(league, '2026-10-12');
  assert.deepEqual(result.rows.map(row => row.rank), [1, 1, 3, null]);
  assert.equal(result.bestByMap[558], 10);
  assert.equal(result.bestByMap[562], null);
});

test('historical awards require the full week and preserve tied winners and losers', () => {
  const league = leagueFor([[20, 20, 20, 20, 20], [20, 20, 20, 20, 20],
    [30, 30, 30, 30, 30], [30, 30, 30, 30, 30], [1]], '2026-10-19');
  const awards = awardsForWeek(league, '2026-10-12');
  assert.deepEqual(awards.winners.map(row => row.player.id), ['0', '1']);
  assert.deepEqual(awards.last.map(row => row.player.id), ['2', '3']);
});

test('an empty week has no awards and a lone finisher is not also the loser', () => {
  const empty = awardsForWeek(leagueFor([]), '2026-10-12');
  assert.deepEqual(empty.winners, []);
  const alone = awardsForWeek(leagueFor([[20, 20, 20, 20]]), '2026-10-12');
  assert.equal(alone.winners.length, 1);
  assert.deepEqual(alone.last, []);
});
