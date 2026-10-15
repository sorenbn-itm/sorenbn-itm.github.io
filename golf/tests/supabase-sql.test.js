import assert from 'node:assert/strict';
import { before, beforeEach, after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { parseScore, standingsForWeek, awardsForWeek, handicapForPlayer, playerStats, roundStats } from '../domain.js';

const db = new PGlite();
const alice = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';
const result = (map = 561, count = 3) => `Kinda Hard Golf #${map}\n📝 ${count * 2}\n${Array.from({length: count}, (_, i) => `${i}.${i ? '⛳' : '🏌️'} 2`).join('\n')}`;

before(async () => {
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key, email text unique, email_confirmed_at timestamptz,
      encrypted_password text, is_anonymous boolean not null default true);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;`);
  await db.exec(await readFile(new URL('../supabase/setup.sql', import.meta.url), 'utf8'));
});
beforeEach(async () => {
  await db.exec(`reset role; set request.jwt.claim.sub = '';
    truncate public.golf_bonus_scores, public.golf_scores, public.golf_players, auth.users;
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
  // Represent a successful managed Auth signup; password hashing belongs to Supabase Auth.
  await db.query(`update auth.users set email = $2, email_confirmed_at = now(),
    encrypted_password = 'managed-password-hash', is_anonymous = false where id = $1`, [id, `${name.toLowerCase()}@players.golf.invalid`]);
  return (await state(id)).identity;
}
async function submit(id, text = result()) {
  return (await asPlayer(id, 'select public.golf_submit_score($1) as score', [text])).rows[0].score;
}
async function state(id = null) {
  return (await asPlayer(id, 'select public.golf_state() as league')).rows[0].league;
}
async function submitBonus(id, map = 561, total = 3) {
  return (await asPlayer(id, 'select public.golf_submit_bonus_score($1, $2) as score', [map, total])).rows[0].score;
}
async function rename(id, name) {
  return (await asPlayer(id, 'select public.golf_update_display_name($1) as player', [name])).rows[0].player;
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
  await assert.rejects(asPlayer(null, "insert into public.golf_players(id,name) values ($1,'Alice')", [alice]), { code: '42501' });
  await assert.rejects(asPlayer(alice, "select public.golf_register_player('Alice')"), { code: '42883' });
  await assert.rejects(submit(null), { code: '42501' });
  await assert.rejects(submit(alice), { code: '42501' });
});

test('new account names use canonical usernames and direct name changes are denied', async () => {
  assert.equal((await register(alice, 'Alice_Jensen')).name, 'alice_jensen');
  assert.deepEqual((await state(alice)).account, { username: 'alice_jensen' });
  assert.equal((await state(bob)).account, null);
  await assert.rejects(register(bob, 'ALICE_JENSEN'), { code: '23505' });
  await assert.rejects(asPlayer(alice, "update public.golf_players set name = 'Other' where id = $1", [alice]), { code: '42501' });
});

test('unconfirmed, passwordless, anonymous, and unrelated identities cannot create players or submit', async () => {
  const cases = [
    ['alice@players.golf.invalid', null, 'managed-hash', false],
    ['alice@players.golf.invalid', '2026-10-15', '', false],
    ['alice@players.golf.invalid', '2026-10-15', 'managed-hash', true],
    ['alice@example.com', '2026-10-15', 'managed-hash', false],
    ['x@players.golf.invalid', '2026-10-15', 'managed-hash', false],
    ['Alice@players.golf.invalid', '2026-10-15', 'managed-hash', false],
  ];
  for (const attributes of cases) {
    await db.query(`update auth.users set email = $2, email_confirmed_at = $3,
      encrypted_password = $4, is_anonymous = $5 where id = $1`, [alice, ...attributes]);
    assert.equal((await state(alice)).identity, null);
    assert.equal((await state(alice)).account, null);
    await assert.rejects(submit(alice), { code: '42501' });
  }
  await assert.rejects(asPlayer(alice, 'update auth.users set is_anonymous = false'), { code: '42501' });
  await assert.rejects(asPlayer(alice, 'select golf_private.account_username($1)', [bob]), { code: '42501' });
});

test('upgrading an existing browser account preserves player ID, name, and scores', async () => {
  await db.query("insert into public.golf_players(id, name) values ($1, 'Alice Jensen')", [alice]);
  await db.query(`insert into public.golf_scores(player_id,map_number,course_date,total,checkpoints,raw_text)
    values ($1,560,'2026-10-14',6,'[]','existing score')`, [alice]);
  assert.equal((await state(alice)).account, null);
  await assert.rejects(submit(alice), { code: '42501' });
  await register(alice, 'alice_login');
  const league = await state(alice);
  assert.equal(league.identity.id, alice);
  assert.equal(league.identity.name, 'Alice Jensen');
  assert.equal(league.players.length, 1);
  assert.equal(league.scores[0].playerId, alice);
  assert.deepEqual(league.account, { username: 'alice_login' });
  assert.equal((await submit(alice)).playerId, alice);
});

test('display names are independent of unique login usernames', async () => {
  await db.query("insert into public.golf_players(id, name) values ($1, 'Alice')", [alice]);
  assert.equal((await register(bob, 'alice')).name, 'alice');
  await rename(bob, 'Bob Jensen');
  await assert.rejects(register(alice, 'alice'), { code: '23505' });
  assert.equal((await state(alice)).identity.name, 'Alice');
  assert.deepEqual((await state(bob)).account, { username: 'alice' });
});

test('players can change display names repeatedly without changing credentials or score ownership', async () => {
  await register(alice, 'alice_login');
  await register(bob, 'bob_login');
  await submit(alice);
  const before = await state(alice);
  assert.equal((await rename(alice, '  Élodie   Jensen  ')).name, 'Élodie Jensen');
  assert.equal((await state(bob)).players.find(player => player.id === alice).name, 'Élodie Jensen');
  assert.equal((await rename(alice, 'New Name')).name, 'New Name');
  assert.equal((await state(alice)).identity.id, alice);
  assert.deepEqual((await state(alice)).account, before.account);
  assert.deepEqual((await state(alice)).scores, before.scores);
  assert.equal((await state(bob)).identity.name, 'bob_login');
  await rename(bob, 'New Name');
  assert.equal((await state()).players.filter(player => player.name === 'New Name').length, 2);
  await db.exec(await readFile(new URL('../supabase/setup.sql', import.meta.url), 'utf8'));
  assert.equal((await state()).players.filter(player => player.name === 'New Name').length, 2);
});

test('display-name updates reject invalid input, anonymous sessions, and selecting another owner', async () => {
  await assert.rejects(rename(null, 'Other Name'), { code: '42501' });
  await db.query("insert into public.golf_players(id, name) values ($1, 'Legacy Player')", [alice]);
  await assert.rejects(rename(alice, 'Other Name'), { code: '42501' });
  await register(alice, 'alice_login');
  for (const name of [null, '', '   ', 'x', 'x'.repeat(25), 'x'.repeat(201), 'Al\u0001ice']) {
    await assert.rejects(rename(alice, name), { code: '22023' });
  }
  await assert.rejects(asPlayer(alice, 'select public.golf_update_display_name($1, $2)', ['Other Name', bob]), { code: '42883' });
  assert.equal((await state(alice)).identity.name, 'Legacy Player');
});

test('an account inserted by Auth creates its profile in the same transaction', async () => {
  const id = '33333333-3333-4333-8333-333333333333';
  await db.query(`insert into auth.users(id,email,email_confirmed_at,encrypted_password,is_anonymous)
    values ($1,'casey@players.golf.invalid',now(),'managed-hash',false)`, [id]);
  assert.equal((await state(id)).identity.name, 'casey');
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
  await submitBonus(alice);
  await db.exec(await readFile(new URL('../supabase/setup.sql', import.meta.url), 'utf8'));
  assert.equal((await state()).players.length, 1);
  assert.equal((await state()).scores.length, 1);
  assert.equal((await state()).bonusScores.length, 1);
});

test('bonus scores are independent of league submissions, awards, and personal statistics', async () => {
  await register(alice, 'Alice');
  await register(bob, 'Bob');
  await submit(alice, result(560));
  await submit(alice);
  const before = await state(alice);
  const score = await submitBonus(alice);
  await submitBonus(bob, 561, 1);
  const after = await state(alice);
  assert.equal(score.playerId, alice);
  assert.equal(score.courseDate, '2026-10-15');
  assert.equal(after.bonusScores.length, 2);
  assert.deepEqual(after.scores, before.scores);
  for (const operation of [league => standingsForWeek(league, '2026-10-12'),
    league => awardsForWeek(league, '2026-10-12'), league => playerStats(league, alice),
    league => handicapForPlayer(league, alice, 561), league => roundStats(league, before.scores[0])]) {
    assert.deepEqual(operation(after), operation(before));
  }
  // A bonus submission does not consume the player's daily league submission.
  await submit(bob);
  assert.equal((await state()).scores.length, 3);
});

test('bonus submissions require an account and cannot be forged, changed, or repeated', async () => {
  await assert.rejects(submitBonus(null), { code: '42501' });
  await assert.rejects(submitBonus(alice), { code: '42501' });
  await register(alice, 'Alice');
  await register(bob, 'Bob');
  await submitBonus(alice);
  await assert.rejects(submitBonus(alice, 561, 1), { code: '23505' });
  await assert.rejects(asPlayer(alice, 'update public.golf_bonus_scores set total = 1'), { code: '42501' });
  await assert.rejects(asPlayer(alice, 'delete from public.golf_bonus_scores'), { code: '42501' });
  await assert.rejects(asPlayer(bob, `insert into public.golf_bonus_scores(player_id,map_number,course_date,total)
    values ($1,561,'2026-10-15',1)`, [alice]), { code: '42501' });
  assert.equal((await asPlayer(null, 'select * from public.golf_bonus_scores')).rows.length, 1);
  assert.equal((await state()).bonusScores[0].total, 3);
});

test('bonus validation allows only the active map and a positive integer shot count', async () => {
  await register(alice, 'Alice');
  for (const total of [null, -1, 0, 10001]) await assert.rejects(submitBonus(alice, 561, total), { code: '22023' });
  await assert.rejects(submitBonus(alice, 561, '1.5'), { code: '22P02' });
  for (const map of [null, 560, 562, 1000001]) await assert.rejects(submitBonus(alice, map), { code: '22023' });
  assert.equal((await state()).bonusScores.length, 0);
  assert.equal((await submitBonus(alice, 561, 10000)).total, 10000);
});

test('bonus scores reset with the game at 04:00 UTC, including weekends', async () => {
  await register(alice, 'Alice');
  await db.exec(`create or replace function golf_private.clock() returns timestamptz language sql stable
    as $$ select timestamptz '2026-10-17T03:59:59Z' $$;`);
  assert.equal((await submitBonus(alice, 562)).courseDate, '2026-10-16');
  await db.exec(`create or replace function golf_private.clock() returns timestamptz language sql stable
    as $$ select timestamptz '2026-10-17T04:00:00Z' $$;`);
  assert.equal((await state()).config.acceptingScores, false);
  await assert.rejects(submitBonus(alice, 562), { code: '22023' });
  assert.equal((await submitBonus(alice, 563)).courseDate, '2026-10-17');
  assert.equal((await state()).bonusScores.length, 2);
});
