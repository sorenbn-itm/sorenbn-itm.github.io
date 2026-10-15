import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSupabaseDatabase } from '../supabase-db.js';

test('old demo data is removed only after a successful shared database read', async () => {
  const removed = [];
  const storage = { removeItem: key => removed.push(key) };
  const league = { config: {}, players: [], scores: [] };
  const db = createSupabaseDatabase({ rpc: async () => ({data: league}) }, storage);
  assert.equal(await db.getLeague(), league);
  assert.deepEqual(removed, ['office-open.mock.v1']);
  const missing = createSupabaseDatabase({rpc: async () => ({error: {code: 'PGRST202'}})}, storage);
  await assert.rejects(missing.getLeague(), {code: 'SETUP_REQUIRED'});
  assert.equal(removed.length, 1);
});

test('anonymous sessions are created only when registering a new browser', async () => {
  let signIns = 0;
  let registeredName;
  const client = { auth: {
    getSession: async () => ({data:{session:null}}),
    signInAnonymously: async () => { signIns++; return {data:{}}; },
  }, rpc: async (_, args) => { registeredName = args.p_name; return {data:{id:'player',name:args.p_name}}; } };
  const db = createSupabaseDatabase(client, null);
  await db.registerPlayer('  Casey  Rivers ');
  assert.equal(signIns, 1);
  assert.equal(registeredName, 'Casey Rivers');
  client.auth.getSession = async () => ({data:{session:{user:{id:'player'}}}});
  await db.registerPlayer('Casey Rivers');
  assert.equal(signIns, 1);
});

test('duplicate writes become a final-score error with no retry or upsert', async () => {
  const calls = [];
  const db = createSupabaseDatabase({rpc: async (...args) => { calls.push(args); return {error:{code:'23505'}}; }}, null);
  await assert.rejects(db.submitScore({rawText:'Kinda Hard Golf #561\n📝 3\n0.🏌️ 3'}), {code:'SCORE_EXISTS'});
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'golf_submit_score');
  assert.deepEqual(Object.keys(calls[0][1]), ['p_raw_text']);
});
