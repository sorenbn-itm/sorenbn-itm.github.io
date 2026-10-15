import { createClient } from './vendor/supabase.js';
import { supabaseConfig } from './supabase-config.js';
import { createSupabaseDatabase } from './supabase-db.js';

const client = createClient(supabaseConfig.url, supabaseConfig.publishableKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'golf.auth.v1' },
  global: { fetch: (url, options) => fetch(url, { ...options, signal: options?.signal ?? AbortSignal.timeout(15000) }) },
});

export const database = createSupabaseDatabase(client);

export function onIdentityChange(callback) {
  const { data } = client.auth.onAuthStateChange(() => { setTimeout(callback, 0); });
  return () => data.subscription.unsubscribe();
}
