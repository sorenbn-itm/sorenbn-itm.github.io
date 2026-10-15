import assert from 'node:assert/strict';
import { before, beforeEach, after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { parseScore, standingsForWeek } from '../domain.js';

const db = new PGlite();
const alice = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';
const result = (map = 561, count = 3) => `Kinda Hard Golf #${map}\n📝 ${count * 2}\n${Array.from({length: count}, (_, i) => `${i}.${i ? '⛳' : '🏌️'} 2`).join('\n')}`;

before(async () => {
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;`);
  await db.exec(await readFile(new URL('../supabase/setup.sql', import.meta.url), 'utf8'));
});
beforeEach(async () => {
  await db.exec(`reset role; set request.jwt.claim.sub = '';
    truncate public.golf_scores, public.golf_players, auth.users;
    insert into auth.users values ('${alice}'), ('${bob}');
    update public.golf_settings set season_start = '2026-10-12';
    create or replace function golf_private.clock() returns timestamptz language sql stable
      set search_path = '' as $$ select timestamptz '2026-10-15T12:00:00Z' $$;`);
});
after(() => db.close());

async function asPlayer(id, sql, args = []) {
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id ?? '']);
  await db.exec(`set role ${id ? 'authenticated' : 'anon'}`);
  try { return await db.query(sql, args); }
  finally { await db.exec('reset role'); }
}
async function register(id, name) {
  return (await asPlayer(id, 'select public.golf_register_player($1) as player', [name])).rows[0].player;
}
async function submit(id, text = result()) {
  return (await asPlayer(id, 'select public.golf_submit_score($1) as score', [text])).rows[0].score;
}
async function state(id = null) {
  return (await asPlayer(id, 'select public.golf_state() as league')).rows[0].league;
}

test('a new database exposes an empty league with the server calendar', async () => {
  const league = await state();
  assert.deepEqual(league.players, []);
  assert.deepEqual(league.scores, []);
  assert.equal(league.identity, null);
  assert.equal(league.config.today, '2026-10-15');
  assert.equal(league.config.activeMapNumber, 561);
  assert.equal(league.config.timeZone, 'Europe/Copenhagen');
});

test('anonymous visitors can read but cannot register or submit', async () => {
  await assert.rejects(register(null, 'Alice'), { code: '42501' });
  await assert.rejects(submit(null), { code: '42501' });
});

test('names are normalized, unique ignoring case, and immutable', async () => {
  assert.equal((await register(alice, '  Alice   Jensen ')).name, 'Alice Jensen');
  await assert.rejects(register(bob, 'ALICE JENSEN'), { code: '23505' });
  await assert.rejects(register(alice, 'New name'), /already has a name/);
  await assert.rejects(asPlayer(alice, "update public.golf_players set name = 'Other' where id = $1", [alice]), { code: '42501' });
});

test('scores are owned by the session and cannot be overwritten or deleted', async () => {
  await register(alice, 'Alice');
  await register(bob, 'Bob');
  const saved = await submit(alice);
  assert.equal(saved.playerId, alice);
  await assert.rejects(submit(alice, result(561, 4)), { code: '23505' });
  await assert.rejects(asPlayer(alice, 'update public.golf_scores set total = 1'), { code: '42501' });
  await assert.rejects(asPlayer(alice, 'delete from public.golf_scores'), { code: '42501' });
  await assert.rejects(asPlayer(bob, `insert into public.golf_scores(player_id,map_number,course_date,total,checkpoints,raw_text)
    values ($1,560,'2026-10-14',1,'[]','fake')`, [alice]), { code: '42501' });
  const league = await state(bob);
  assert.equal(league.identity.id, bob);
  assert.equal(league.scores.length, 1);
  assert.equal(league.scores[0].total, 6);
});

test('the server parser matches the browser for variable checkpoint counts', async () => {
  for (const count of [1, 4, 9, 16]) {
    const input = result(561, count);
    const parsed = (await db.query('select golf_private.parse_score($1) as score', [input])).rows[0].score;
    assert.deepEqual(parsed, parseScore(input));
  }
  const input = 'Kinda Hard Golf #561\r\n📝\u00a03\r\n2.⛳ -\r\n1.⛳ 1\r\n0.🏌️‍♂️ 2';
  const parsed = (await db.query('select golf_private.parse_score($1) as score', [input])).rows[0].score;
  assert.deepEqual(parsed, parseScore(input));
});

test('server validation rejects malformed totals and repeated checkpoints', async () => {
  await register(alice, 'Alice');
  for (const input of [result().replace('📝 6', '📝 7'), result().replace('1.⛳', '2.⛳'),
    result().replace('0.🏌️ 2', ''), result().replace('📝 6', '📝 -6'), `${result()}\n${result()}`]) {
    await assert.rejects(submit(alice, input), { code: '22023' });
  }
  assert.equal((await state()).scores.length, 0);
});

test('future, weekend, and pre-season maps are rejected while missing weekdays can be added', async () => {
  await register(alice, 'Alice');
  for (const map of [562, 557, 550]) await assert.rejects(submit(alice, result(map)), { code: '22023' });
  assert.equal((await submit(alice, result(560))).courseDate, '2026-10-14');
});

test('the game reset is separate from Copenhagen midnight', async () => {
  await db.exec(`create or replace function golf_private.clock() returns timestamptz language sql stable
    as $$ select timestamptz '2026-10-18T22:30:00Z' $$;`);
  const league = await state();
  assert.equal(league.config.today, '2026-10-19');
  assert.equal(league.config.activeCourseDate, '2026-10-18');
  assert.equal(league.config.acceptingScores, false);
});

test('a late submission replaces a derived DNF without allowing an update', async () => {
  await register(alice, 'Alice');
  await register(bob, 'Bob');
  await submit(alice, result(560));
  const before = standingsForWeek(await state(bob), '2026-10-12');
  assert.equal(before.scores.find(score => score.playerId === bob).assigned, true);
  await submit(bob, result(560, 1));
  const after = standingsForWeek(await state(bob), '2026-10-12');
  assert.equal(after.scores.find(score => score.playerId === bob).assigned, undefined);
  assert.equal(after.scores.find(score => score.playerId === bob).total, 2);
  await assert.rejects(submit(bob, result(560, 2)), {code:'23505'});
});

test('rerunning setup preserves registered players and submitted scores', async () => {
  await register(alice, 'Alice');
  await submit(alice);
  await db.exec(await readFile(new URL('../supabase/setup.sql', import.meta.url), 'utf8'));
  assert.equal((await state()).players.length, 1);
  assert.equal((await state()).scores.length, 1);
});
