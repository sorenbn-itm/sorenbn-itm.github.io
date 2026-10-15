import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exampleScore, leagueConfig } from './fixtures.js';
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

test('players still missing today remain unranked after earlier missing days are assigned', () => {
  const league = leagueFor([[20, 20, 20, 20], [1, null, null, null], [21, 21, 21, 21]]);
  const { rows, dueDates } = standingsForWeek(league, '2026-10-12');
  assert.deepEqual(rows.map(row => row.player.id), ['0', '2', '1']);
  assert.deepEqual(rows.map(row => row.rank), [1, 2, null]);
  assert.equal(dueDates.length, 4);
  assert.equal(rows.at(-1).total, 45);
  assert.deepEqual(rows.at(-1).rounds.filter(round => round.assigned).map(round => round.total), [22, 22]);
});

test('ties use competition ranks and daily best includes all submitted rounds', () => {
  const league = leagueFor([[20, 20, 20, 20], [19, 21, 20, 20], [22, 22, 22, 22], [10]]);
  const result = standingsForWeek(league, '2026-10-12');
  assert.deepEqual(result.rows.map(row => row.rank), [1, 1, 3, null]);
  assert.equal(result.bestByMap[558], 10);
  assert.equal(result.bestByMap[562], null);
});

test('historical awards include assigned rounds and preserve tied winners and losers', () => {
  const league = leagueFor([[20, 20, 20, 20, 20], [20, 20, 20, 20, 20],
    [30, 30, 30, 30, 30], [30, 30, 30, 30, 30], [1]], '2026-10-19');
  const awards = awardsForWeek(league, '2026-10-12');
  assert.deepEqual(awards.winners.map(row => row.player.id), ['0', '1']);
  assert.deepEqual(awards.last.map(row => row.player.id), ['2', '3']);
});

test('missing past rounds get the daily maximum plus one for every absent player', () => {
  const league = leagueFor([[20, 30, 10, 20], [25, null, null, 21], []]);
  const originalScores = structuredClone(league.scores);
  const result = standingsForWeek(league, '2026-10-12');
  const absent = result.rows.find(row => row.player.id === '2');
  assert.deepEqual(absent.rounds.map(round => [round.mapNumber, round.total, round.assigned]),
    [[558, 26, true], [559, 31, true], [560, 11, true]]);
  assert.equal(absent.total, 68);
  assert.equal(absent.rank, null);
  assert.equal(result.scores.filter(score => score.assigned && score.mapNumber === 559).length, 2);
  assert.ok(result.scores.filter(score => score.assigned && score.mapNumber === 559).every(score => score.total === 31));
  assert.deepEqual(league.scores, originalScores);
  const partial = result.rows.find(row => row.player.id === '1');
  assert.equal(partial.complete, true);
  assert.equal(partial.total, 88);
  assert.equal(partial.rank, 2);
  assert.equal(result.bestByMap[559], 30);
});

test('no assignments are made for today, future days, or a day without a submission', () => {
  const league = leagueFor([[20, null, 25, 30, 1], []]);
  const { rows, scores, bestByMap } = standingsForWeek(league, '2026-10-12');
  const absent = rows.find(row => row.player.id === '1');
  assert.deepEqual(absent.rounds.map(round => round.mapNumber), [558, 560]);
  assert.equal(absent.complete, false);
  assert.equal(rows[0].complete, false);
  assert.equal(bestByMap[559], null);
  assert.equal(bestByMap[562], null);
  assert.ok(!scores.some(score => score.mapNumber === 562));
  assert.ok(!scores.some(score => score.assigned && score.mapNumber === 561));
});

test('Friday becomes assignable after the weekend and assignments count toward archive awards', () => {
  const league = leagueFor([[20, 20, 20, 20, 20], []], '2026-10-19');
  const result = awardsForWeek(league, '2026-10-12');
  assert.deepEqual(result.standings.rows.map(row => [row.player.id, row.total, row.complete]),
    [['0', 100, true], ['1', 105, true]]);
  assert.equal(result.last[0].player.id, '1');
  assert.equal(result.last[0].rounds.find(round => round.mapNumber === 562).total, 21);
  assert.equal(result.standings.scores.length, 10);
});

test('late submissions replace assignments and update the baseline without accumulating penalties', () => {
  const league = leagueFor([[20, 20, 20, 20, 20], [], []], '2026-10-19');
  assert.equal(standingsForWeek(league, '2026-10-12').rows.find(row => row.player.id === '1').total, 105);
  league.scores.push({ playerId: '1', mapNumber: 558, total: 40 });
  const result = standingsForWeek(league, '2026-10-12');
  const late = result.rows.find(row => row.player.id === '1');
  assert.equal(late.rounds.filter(round => round.mapNumber === 558).length, 1);
  assert.equal(late.rounds.find(round => round.mapNumber === 558).assigned, undefined);
  assert.equal(late.total, 124);
  const absent = result.rows.find(row => row.player.id === '2');
  assert.equal(absent.rounds.find(round => round.mapNumber === 558).total, 41);
  assert.equal(absent.total, 125);
  assert.deepEqual(standingsForWeek(league, '2026-10-12'), result);
});

test('assigned scores support the largest submitted total and preserve ties between absent players', () => {
  const league = leagueFor([[10000], [], []], '2026-10-13');
  league.config.weekdays = [1];
  const { rows } = standingsForWeek(league, '2026-10-12');
  assert.deepEqual(rows.map(row => row.total), [10000, 10001, 10001]);
  assert.deepEqual(rows.map(row => row.rank), [1, 2, 2]);
});

test('an empty week has no awards and a lone finisher is not also the loser', () => {
  const empty = awardsForWeek(leagueFor([]), '2026-10-12');
  assert.deepEqual(empty.winners, []);
  const alone = awardsForWeek(leagueFor([[20, 20, 20, 20]]), '2026-10-12');
  assert.equal(alone.winners.length, 1);
  assert.deepEqual(alone.last, []);
});
