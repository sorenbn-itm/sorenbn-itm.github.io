export function normalizeUsername(value) {
  const username = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^[a-z0-9][a-z0-9_-]{2,23}$/.test(username)) {
    throw new Error('Choose a username of 3–24 letters, numbers, underscores or hyphens, starting with a letter or number.');
  }
  return username;
}

export function accountEmail(username) {
  // Supabase password identities require an email-shaped identifier.
  return `${normalizeUsername(username)}@players.golf.invalid`;
}

export function validatePassword(password) {
  if (typeof password !== 'string' || [...password].length < 8) {
    throw new Error('Use a password of at least 8 characters.');
  }
  if (new TextEncoder().encode(password).length > 72) {
    throw new Error('Use a password of at most 72 bytes (some characters use more than one byte).');
  }
}
