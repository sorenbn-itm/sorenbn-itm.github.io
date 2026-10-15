import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSupabaseDatabase } from '../supabase-db.js';
import { accountEmail, normalizeDisplayName, normalizeUsername, validatePassword } from '../accounts.js';

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

test('usernames are canonical and cannot inject another account identifier', () => {
  assert.equal(normalizeUsername('  Casey_Rivers '), 'casey_rivers');
  assert.equal(accountEmail('Casey_Rivers'), 'casey_rivers@players.golf.invalid');
  for (const username of ['ab', 'a'.repeat(25), 'alice@example.com', '_alice', 'a b', 'cás', 'Ａlice', 'a.b']) {
    assert.throws(() => accountEmail(username));
  }
});

test('passwords are not trimmed and bcrypt byte limits include multibyte characters', () => {
  validatePassword('a'.repeat(8));
  validatePassword(' long password ');
  validatePassword('a'.repeat(72));
  validatePassword('é'.repeat(36));
  for (const password of ['', 'a'.repeat(7), 'a'.repeat(73), 'é'.repeat(37), '😀'.repeat(19)]) {
    assert.throws(() => validatePassword(password));
  }
});

function authClient(user = null) {
  const calls = [];
  const confirmed = { id: user?.id ?? 'new-player', email_confirmed_at: '2026-10-15', is_anonymous: false };
  const client = { auth: {
    getSession: async () => ({ data: { session: user ? { user } : null } }),
    getUser: async () => ({ data: { user } }),
    signUp: async args => { calls.push(['signup', args]); return { data: { user: confirmed, session: { user: confirmed } } }; },
    updateUser: async args => { calls.push(['update', args]); return { data: { user: confirmed } }; },
    signInWithPassword: async args => { calls.push(['login', args]); return { data: { user: confirmed } }; },
    signOut: async args => { calls.push(['logout', args]); return { data: {} }; },
  }, rpc: async () => ({ data: { config: {}, players: [], scores: [] } }) };
  return { client, calls };
}

test('new accounts use managed password signup without creating an anonymous session', async () => {
  const { client, calls } = authClient();
  await createSupabaseDatabase(client, null).registerAccount('Casey', ' a long password ');
  assert.deepEqual(calls, [['signup', { email: 'casey@players.golf.invalid', password: ' a long password ' }]]);
});

test('existing browser users gain credentials on the same account, keeping score ownership', async () => {
  const { client, calls } = authClient({ id: 'original-player', is_anonymous: true });
  const db = createSupabaseDatabase(client, null);
  const user = await db.registerAccount('Casey', 'a long password');
  assert.equal(user.id, 'original-player');
  assert.deepEqual(calls, [['update', { email: 'casey@players.golf.invalid', password: 'a long password' }]]);
});

test('permanent sessions cannot be registered over', async () => {
  const { client, calls } = authClient({ id: 'original-player', is_anonymous: false });
  const db = createSupabaseDatabase(client, null);
  await assert.rejects(db.registerAccount('Casey', 'a long password'), /Sign out/);
  assert.deepEqual(calls, []);
});

test('display names never reserve sign-in usernames', async () => {
  const { client, calls } = authClient();
  client.rpc = async () => { throw new Error('Signup must not check display names.'); };
  await createSupabaseDatabase(client, null).registerAccount('Casey', 'a long password');
  assert.equal(calls[0][0], 'signup');
});

test('display names normalize whitespace, support Unicode, and enforce length and control checks', () => {
  assert.equal(normalizeDisplayName('  Élodie\u00a0  Jensen  '), 'Élodie Jensen');
  assert.equal(normalizeDisplayName('Ａlice'), 'Alice');
  assert.equal(normalizeDisplayName('😀'.repeat(24)), '😀'.repeat(24));
  for (const name of [null, '', '   ', 'x', 'x'.repeat(25), 'Al\u0001ice']) {
    assert.throws(() => normalizeDisplayName(name));
  }
});

test('display-name updates send only the normalized name, with no selectable player ID', async () => {
  const calls = [];
  const db = createSupabaseDatabase({ rpc: async (...args) => {
    calls.push(args); return { data: { id: 'player', name: args[1].p_name } };
  } }, null);
  assert.deepEqual(await db.updateDisplayName('  Casey   Rivers '), { id: 'player', name: 'Casey Rivers' });
  assert.deepEqual(calls, [['golf_update_display_name', { p_name: 'Casey Rivers' }]]);
  await assert.rejects(db.updateDisplayName('x'));
  assert.equal(calls.length, 1);
});

test('confirmation being enabled is reported as a setup problem', async () => {
  const { client } = authClient();
  client.auth.signUp = async () => ({ data: { user: { id: 'pending' }, session: null } });
  await assert.rejects(createSupabaseDatabase(client, null).registerAccount('Casey', 'a long password'), { code: 'SETUP_REQUIRED' });
});

test('sign-in errors do not reveal whether the username or password was wrong', async () => {
  const { client } = authClient();
  client.auth.signInWithPassword = async () => ({ error: { code: 'invalid_credentials' } });
  await assert.rejects(createSupabaseDatabase(client, null).signIn('Casey', 'bad'), {
    code: 'INVALID_CREDENTIALS', message: 'Incorrect username or password.',
  });
  client.auth.signInWithPassword = async () => ({ error: { status: 429 } });
  await assert.rejects(createSupabaseDatabase(client, null).signIn('Casey', 'bad'), { code: 'RATE_LIMIT' });
});

test('password changes reauthenticate before sending the replacement password', async () => {
  const { client, calls } = authClient({ id: 'player', email: 'casey@players.golf.invalid', is_anonymous: false });
  const db = createSupabaseDatabase(client, null);
  await db.changePassword('old password', 'new long password');
  assert.deepEqual(calls, [
    ['login', { email: 'casey@players.golf.invalid', password: 'old password' }],
    ['update', { password: 'new long password', current_password: 'old password' }],
  ]);
  calls.length = 0;
  client.auth.signInWithPassword = async () => ({ error: { code: 'invalid_credentials' } });
  await assert.rejects(db.changePassword('wrong password', 'new long password'), { code: 'INVALID_CREDENTIALS' });
  assert.deepEqual(calls, []);
});

test('sign-out removes the current device session', async () => {
  const { client, calls } = authClient();
  await createSupabaseDatabase(client, null).signOut();
  assert.deepEqual(calls, [['logout', { scope: 'local' }]]);
});

test('exports exclude account identifiers and authentication data', async () => {
  const { client } = authClient();
  client.rpc = async () => ({ data: {
    config: {}, players: [{ id: 'player', name: 'casey' }], scores: [],
    account: { username: 'casey', email: 'casey@players.golf.invalid' }, identity: { id: 'player' },
  } });
  const exported = JSON.parse(await createSupabaseDatabase(client, null).exportData());
  assert.deepEqual(Object.keys(exported), ['version', 'exportedAt', 'config', 'players', 'scores', 'bonusScores']);
});

test('duplicate writes become a final-score error with no retry or upsert', async () => {
  const calls = [];
  const db = createSupabaseDatabase({rpc: async (...args) => { calls.push(args); return {error:{code:'23505'}}; }}, null);
  await assert.rejects(db.submitScore({rawText:'Kinda Hard Golf #561\n📝 3\n0.🏌️ 3'}), {code:'SCORE_EXISTS'});
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'golf_submit_score');
  assert.deepEqual(Object.keys(calls[0][1]), ['p_raw_text']);
});

test('bonus submissions use a separate RPC with an explicit map and integer total', async () => {
  const calls = [];
  const db = createSupabaseDatabase({ rpc: async (...args) => {
    calls.push(args); return { data: { total: 4 } };
  } }, null);
  assert.deepEqual(await db.submitBonusScore({ mapNumber: 561, total: 4 }), { total: 4 });
  assert.deepEqual(calls, [['golf_submit_bonus_score', { p_map_number: 561, p_total: 4 }]]);
  for (const total of [null, '', '3', 0, -1, 1.5, 10001, NaN, Infinity]) {
    await assert.rejects(db.submitBonusScore({ mapNumber: 561, total }));
  }
  await assert.rejects(db.submitBonusScore({ mapNumber: null, total: 3 }));
  assert.equal(calls.length, 1);
});
