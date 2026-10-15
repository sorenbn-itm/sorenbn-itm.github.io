import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { beforeEach, test } from 'node:test';
import { exampleScore } from '../config.js';
import { database, STORAGE_KEY } from '../mock-db.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
let storage;
beforeEach(() => {
  storage = new Map();
  globalThis.localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  };
});

test('the sample league loads without creating a player identity', async () => {
  const league = await database.getLeague();
  assert.equal(league.identity, null);
  assert.equal(league.players.length, 6);
  assert.equal(league.scores.length, 112);
  league.players[0].name = 'Changed';
  assert.equal((await database.getLeague()).players[0].name, 'Alex Morgan');
});

test('registration persists a normalized name and prevents changing it', async () => {
  const player = await database.registerPlayer('  Casey   Rivers  ');
  assert.equal(player.name, 'Casey Rivers');
  assert.equal((await database.getLeague()).identity.id, player.id);
  await assert.rejects(database.registerPlayer('Another Name'), /already has/);
});

test('duplicate names are rejected without regard to case', async () => {
  await assert.rejects(database.registerPlayer('aLeX mOrGaN'), /already taken/);
  await assert.rejects(database.registerPlayer('X'), /between 2 and 24/);
});

test('saving requires identity and duplicate submissions can never change a score', async () => {
  await assert.rejects(database.submitScore({ rawText: exampleScore }), { code: 'IDENTITY_REQUIRED' });
  await database.registerPlayer('Casey Rivers');
  const saved = await database.submitScore({ rawText: exampleScore });
  assert.equal(saved.total, 25);
  assert.equal(saved.courseDate, '2026-10-15');
  await assert.rejects(database.submitScore({ rawText: exampleScore }), { code: 'SCORE_EXISTS' });
  const replacement = exampleScore.replace('📝 25', '📝 26').replace('8.⛳ 5', '8.⛳ 6');
  await assert.rejects(database.submitScore({ rawText: replacement }), { code: 'SCORE_EXISTS' });
  await assert.rejects(database.submitScore({ rawText: replacement, replace: true }), { code: 'SCORE_EXISTS' });
  const league = await database.getLeague();
  const ownScores = league.scores.filter(score => score.playerId === league.identity.id);
  assert.equal(ownScores.length, 1);
  assert.equal(ownScores[0].total, 25);
});

test('different maps can store different checkpoint counts', async () => {
  await database.registerPlayer('Casey Rivers');
  await database.submitScore({ rawText: exampleScore });
  await database.submitScore({ rawText: 'Kinda Hard Golf #560\n📝 3\n0.🏌️ 3' });
  const league = await database.getLeague();
  const own = league.scores.filter(score => score.playerId === league.identity.id);
  assert.deepEqual(own.map(score => score.checkpoints.length), [9, 1]);
});

test('future, weekend and out-of-season submissions are rejected', async () => {
  await database.registerPlayer('Casey Rivers');
  await assert.rejects(database.submitScore({ rawText: exampleScore.replace('#561', '#562') }), /future/);
  await assert.rejects(database.submitScore({ rawText: exampleScore.replace('#561', '#557') }), /weekend/);
  await assert.rejects(database.submitScore({ rawText: exampleScore.replace('#561', '#500') }), /outside/);
});

test('export includes local submissions and reset restores the original league', async () => {
  await database.registerPlayer('Casey Rivers');
  await database.submitScore({ rawText: exampleScore });
  const exported = JSON.parse(await database.exportData());
  assert.equal(exported.players.length, 7);
  assert.equal(exported.scores.length, 113);
  await database.resetDemo();
  const league = await database.getLeague();
  assert.equal(league.identity, null);
  assert.equal(league.players.length, 6);
  assert.equal(league.scores.length, 112);
});

test('corrupt storage remains exportable until an explicit reset', async () => {
  storage.set(STORAGE_KEY, '{broken');
  await assert.rejects(database.getLeague(), { code: 'STORAGE_INVALID' });
  assert.equal(await database.exportData(), '{broken');
  await database.resetDemo();
  assert.equal((await database.getLeague()).players.length, 6);
});

test('a failed write reports failure without claiming a persisted identity', async () => {
  globalThis.localStorage.setItem = () => { throw new Error('Quota exceeded'); };
  await assert.rejects(database.registerPlayer('Casey Rivers'), { code: 'STORAGE_UNAVAILABLE' });
  assert.equal((await database.getLeague()).identity, null);
});
