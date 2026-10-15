import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { createClient } from '@supabase/supabase-js';
import { supabaseConfig } from '../supabase-config.js';
import { accountEmail, normalizeUsername, validatePassword } from '../accounts.js';

async function resetPassword() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('Set SUPABASE_SERVICE_ROLE_KEY in this terminal before running the reset.');
  if (!process.stdin.isTTY) throw new Error('Run in an interactive terminal so passwords can be entered without echo.');
  const username = normalizeUsername(process.argv[2]);
  const client = createClient(supabaseConfig.url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  let user;
  for (let page = 1; ; page++) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error('Could not look up accounts. Check the project, administrator key, and connection.');
    user = data.users.find(candidate => candidate.email === accountEmail(username));
    if (user || data.users.length < 1000) break;
  }
  if (!user) throw new Error('Username not found.');
  const output = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const prompt = createInterface({ input: process.stdin, output, terminal: true });
  let password;
  try {
    process.stdout.write(`New password for ${username} (hidden): `);
    password = await prompt.question('');
    process.stdout.write('\nConfirm new password (hidden): ');
    const confirmation = await prompt.question('');
    process.stdout.write('\n');
    validatePassword(password);
    if (password !== confirmation) throw new Error('The passwords do not match.');
  } finally { prompt.close(); }
  const { error } = await client.auth.admin.updateUserById(user.id, { password });
  if (error) throw new Error('Could not reset the password. Check the project password requirements and administrator access.');
  console.log(`Password reset for ${username}.`);
}

resetPassword().catch(error => { console.error(error.message); process.exitCode = 1; });
