import { LeagueError, parseScore } from './domain.js';

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

    async registerPlayer(name) {
      const cleanName = typeof name === 'string' ? name.normalize('NFKC').replace(/\s+/g, ' ').trim() : '';
      if (cleanName.length < 2 || cleanName.length > 24 || /[\p{Cc}\p{Cf}]/u.test(cleanName)) {
        throw new LeagueError('Choose a name between 2 and 24 characters.');
      }
      const session = await client.auth.getSession();
      if (session.error) throw databaseError(session.error);
      if (!session.data.session) {
        const signedIn = await client.auth.signInAnonymously();
        if (signedIn.error) throw databaseError(signedIn.error);
      }
      return rpc('golf_register_player', { p_name: cleanName }, 'name');
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
