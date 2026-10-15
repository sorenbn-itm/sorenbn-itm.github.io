import { LeagueError, parseScore } from './domain.js';
import { accountEmail, validatePassword } from './accounts.js';

function authError(error, operation) {
  if (error.status === 429 || error.code?.includes('rate_limit')) {
    return new LeagueError('Too many attempts. Please wait a few minutes and try again.', 'RATE_LIMIT');
  }
  if (['user_already_exists', 'email_exists'].includes(error.code)) {
    return new LeagueError('That username is already taken.', 'NAME_TAKEN');
  }
  if (error.code === 'weak_password') return new LeagueError('Choose a stronger password of at least 8 characters.', 'WEAK_PASSWORD');
  if (['email_not_confirmed', 'email_address_invalid', 'email_address_not_authorized', 'reauthentication_needed'].includes(error.code)) {
    return new LeagueError('Account sign-in needs administrator setup. Please contact the league administrator.', 'SETUP_REQUIRED');
  }
  if (operation === 'login' && error.code === 'invalid_credentials') {
    return new LeagueError('Incorrect username or password.', 'INVALID_CREDENTIALS');
  }
  if (['same_password', 'current_password_mismatch', 'current_password_required'].includes(error.code)) {
    return new LeagueError(error.code === 'same_password' ? 'Choose a different password.' : 'The current password is incorrect.', 'INVALID_CREDENTIALS');
  }
  return new LeagueError('Could not complete the account request. Please try again or contact the league administrator.', 'AUTH_ERROR');
}

function databaseError(error, operation) {
  if (['PGRST202', 'PGRST205', '42P01'].includes(error.code)) {
    return new LeagueError('The leaderboard is being set up. Please try again shortly.', 'SETUP_REQUIRED');
  }
  if (error.code === '23505') {
    return new LeagueError(operation === 'score' ? 'You already submitted a score for this map. Scores are final.'
      : 'That name is already taken. Try adding an initial.', operation === 'score' ? 'SCORE_EXISTS' : 'NAME_TAKEN');
  }
  if (error.code === '42501') return new LeagueError(error.message, 'IDENTITY_REQUIRED');
  if (error.code === '22023') return new LeagueError(error.message);
  if (error.status === 429) return new LeagueError('Too many new players at once. Please try again shortly.', 'RATE_LIMIT');
  return new LeagueError('Could not reach the leaderboard. Please try again.', 'NETWORK_ERROR');
}

export function createSupabaseDatabase(client, storage = globalThis.localStorage) {
  async function authRequest(operation, request) {
    let result;
    try { result = await request(); }
    catch { throw new LeagueError('Could not reach the account service. Please try again.', 'NETWORK_ERROR'); }
    if (result.error) throw authError(result.error, operation);
    return result.data;
  }

  async function rpc(name, args, operation) {
    let result;
    try { result = await client.rpc(name, args); }
    catch { throw new LeagueError('Could not reach the leaderboard. Please try again.', 'NETWORK_ERROR'); }
    if (result.error) throw databaseError(result.error, operation);
    return result.data;
  }

  return {
    async getLeague() {
      const league = await rpc('golf_state');
      if (!league?.config || !Array.isArray(league.players) || !Array.isArray(league.scores)) {
        throw new LeagueError('The leaderboard returned an invalid response.', 'INVALID_RESPONSE');
      }
      // Remove the browser-only demo after shared storage is available.
      try { storage?.removeItem('office-open.mock.v1'); } catch { /* Shared scores remain available without local demo storage. */ }
      return league;
    },

    async registerAccount(username, password) {
      const email = accountEmail(username);
      validatePassword(password);
      const { session } = await authRequest('register', () => client.auth.getSession());
      const { user } = session ? await authRequest('register', () => client.auth.getUser()) : { user: null };
      if (user && !user.is_anonymous) throw new LeagueError('Sign out before creating another account.');
      const league = await this.getLeague();
      if (league.players.some(player => player.id !== user?.id && player.name.toLowerCase() === email.split('@')[0])) {
        throw new LeagueError('That username is already taken.', 'NAME_TAKEN');
      }
      const data = user?.is_anonymous
        ? await authRequest('register', () => client.auth.updateUser({ email, password }))
        : await authRequest('register', () => client.auth.signUp({ email, password }));
      if (!data.user?.email_confirmed_at || data.user.is_anonymous || (!user && !data.session)) {
        throw new LeagueError('Accounts need administrator setup before you can sign in. Please contact the league administrator.', 'SETUP_REQUIRED');
      }
      return data.user;
    },

    async signIn(username, password) {
      const email = accountEmail(username);
      if (typeof password !== 'string' || !password) throw new LeagueError('Enter your password.');
      return authRequest('login', () => client.auth.signInWithPassword({ email, password }));
    },

    async signOut() {
      return authRequest('logout', () => client.auth.signOut({ scope: 'local' }));
    },

    async changePassword(currentPassword, password) {
      validatePassword(password);
      const { user } = await authRequest('password', () => client.auth.getUser());
      if (!user?.email || user.is_anonymous) throw new LeagueError('Sign in before changing your password.');
      await authRequest('login', () => client.auth.signInWithPassword({ email: user.email, password: currentPassword }));
      return authRequest('password', () => client.auth.updateUser({ password, current_password: currentPassword }));
    },

    async submitScore({ rawText }) {
      const parsed = parseScore(rawText);
      return rpc('golf_submit_score', { p_raw_text: parsed.rawText }, 'score');
    },

    async exportData() {
      const league = await this.getLeague();
      return JSON.stringify({ version: 1, exportedAt: new Date().toISOString(),
        config: league.config, players: league.players, scores: league.scores }, null, 2);
    },
  };
}
