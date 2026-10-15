# Kinda Hard Golf scores

A desktop score tracker for Kinda Hard Golf. Open `/golf/` on GitHub Pages. The browser loads a bundled Supabase client from this repository. No external fonts are required. Dark mode is the default; the theme toggle saves a preference under `golf.theme` in localStorage.

## Local preview

From the repository root:

```sh
python -m http.server 8767 --bind 127.0.0.1
```

Visit `http://127.0.0.1:8767/golf/`. JavaScript modules require HTTP; opening the HTML file directly is unsupported.

For development and database checks, use Node.js 22 or later:

```sh
cd golf
npm ci
npm test
npm run build
```

## Supabase setup

1. In Supabase **Authentication → Sign In / Providers**, enable email/password sign-in and new-user signups, disable **Confirm email**, and disable new anonymous sign-ins. Set the minimum password length to **8**. Leave email-based password reauthentication and email notifications off; require the current password for password changes where that setting is available. Enable **Allow manual linking** for existing anonymous players to add credentials. Keep the project's authentication rate limits enabled. No SMTP setup is needed.
2. Run the complete contents of `supabase/setup.sql` in the project's SQL Editor before publishing the frontend. It creates tables, an Auth trigger, and the required functions and access policies. Rerunning it preserves existing players, scores, and the season start. The change blocks score submissions from old anonymous sessions until those players set a username and password.
3. Set the project URL and publishable key in `supabase-config.js`. This key is public configuration. Do not use a secret or service-role key.
4. Push the site changes to `main` to run the Pages workflow, or build with `npm run build` and deploy `dist/`. The published route is `/golf/`.
5. Create a username and password on the published site. Existing players must do this in the browser where they previously registered to retain their player ID, display name, and scores. Sessions are specific to each browser origin; a localhost session does not transfer to GitHub Pages. After creating credentials, the same account works on other devices.

The default season starts on the Monday of the week when setup first runs. The database's `golf_settings` row contains the season start, map-date anchor, and game reset hour. Map zero is 2 April 2025, and the game changes its map at 04:00 UTC. Weekly standings use the server's current Copenhagen date; entry and today's player statistics use the active game map, which can belong to the previous calendar day overnight. Weekend maps are not eligible.

There is no seed data. A successful shared database read removes the old browser demo key `office-open.mock.v1` without importing it. Theme preferences remain under `golf.theme`. Session tokens are managed by the Supabase client under `golf.auth.v1`; exports never include tokens, account identifiers, or passwords. Clearing site storage signs the user out; they can sign back in with their credentials.

The form disappears after the active map's score is submitted and stays hidden after reload. The page refreshes shared standings on focus, after writes, after identity changes, and once per minute while visible. It updates the active week and score-entry state as the server date or game map changes.

The Weekly league tab opens on every visit. The Daily bonus tab shows a separate leaderboard for the active map, ranked by fewest shots with shared places for ties. Players can optionally enter one integer shot count per game day, including weekends, without first submitting a league score. Bonus entry closes when the next map opens at 04:00 UTC; past bonus levels cannot be submitted. Skipped bonus days have no assigned scores. Bonus submissions do not enter weekly totals, awards, handicaps, or player statistics.

Run the updated `supabase/setup.sql` before deploying the bonus tab. It adds `golf_bonus_scores` and the `golf_submit_bonus_score` function while preserving existing data. Until setup is applied, the app keeps league entry available and marks bonus entry unavailable.

The public leaderboard exposes player display names and scores. Only a registered password account can submit for its own player. Player profiles are created by an Auth trigger; display names are updated through an ownership-checked database function. Direct API inserts, updates, and deletes are denied. Unique constraints enforce account identifiers and player/map pairs. Browser checks provide feedback; the database independently checks the account, parses the raw result, and validates totals, checkpoint lines, dates, and ownership.

The API currently returns all submitted league history in one snapshot, preserving the last-20-round handicap calculation. This is intended for a small office league. Test the table and function permissions after changing the schema. The local SQL checks run the setup in an isolated PostgreSQL WASM runtime with Supabase's roles and identity function represented locally; they do not create players or scores in the live project.

## Accounts and passwords

Usernames are unique and case-insensitive, 3–24 ASCII letters, numbers, underscores or hyphens, starting with a letter or number. Usernames are fixed in the app. New players' display names default to their lowercase username; existing players retain their display name when adding credentials. Players can change their display name in the account dialog at any time. Display names allow 2–24 characters, are normalized for whitespace, and can be shared by multiple players. Changing a display name updates its appearance throughout the leaderboard and history while preserving score ownership and sign-in credentials.

Supabase requires email- or phone-based password identities. The client maps a username to `username@players.golf.invalid`, a reserved, non-deliverable identifier. Users never provide an email address, and email confirmation must remain disabled. Do not add real email addresses or email-based recovery to these identities.

Supabase Auth stores passwords with bcrypt and a separate random salt for each password; the app does not store or hash passwords itself. New passwords require at least 8 characters and at most 72 UTF-8 bytes, bcrypt's input limit. Enforce the 8-character minimum in Supabase as well as in the form. The account dialog requires the current password before accepting a change. Only session tokens persist in browser storage. See [Supabase password security](https://supabase.com/docs/guides/auth/password-security).

There is no email password recovery. The league administrator must verify the requester independently before resetting an account. On a trusted computer, set `SUPABASE_SERVICE_ROLE_KEY` in the terminal environment, then run from `golf/`:

```sh
npm run reset-password -- username
```

The script prompts for the new password twice without echoing it. Never place the administrator key in public configuration, source control, browser code, or command arguments. Remove it from the terminal environment after use. The reset script is excluded from the published site. Give the temporary password to its owner privately; they can change it after signing in.

If an existing anonymous player's browser session has already been lost, account creation cannot establish ownership of that player's scores. An administrator must verify the owner and recover or transfer the player; matching a public name is insufficient.

## Handicaps and player statistics

Select a player below the leaderboard to see their handicap, today's expected shots, daily league group, rounds played, average shots, and best score. Open a score for its par comparison, target comparison, league rank, and global groups when collected.

The handicap is the average of `shots − par` across the last 20 earlier played rounds with known par, rounded to one decimal. It requires at least three rounds. Today's target is `par + handicap`, rounded to whole shots with a minimum of one. Negative handicaps are supported. The current round and future rounds never enter their own target. Missing historical submissions and revised par snapshots can recalculate targets. This is a league statistic, not an official golf handicap. Assigned scores count toward weekly rankings and awards; handicap, rounds played, averages, best scores, and percentiles use submitted rounds only.

League groups compare submitted scores on the same map. `Top N%` is the percentage of scores equal to or better than the player's score, rounded up; ties share the same rank and group. A sole player or an all-tied field is top 100%. Global groups are supplied by the game for first daily runs and repeat runs separately. They are not inferred from the league's scores. Scores outside the collected range show no global percentile.

Course statistics are shown only when their map number and date match the league calendar. There is no sample par in the live league. Handicaps need three earlier played rounds with collected par.

## Daily game data

Run the collector from the repository root:

```sh
node golf/scripts/scrape-courses.js
```

The collector reads the public game page and its current JavaScript module, discovers the game's daily reset calculation and stats request, and collects the same data used by the game. It does not require login, run gameplay, or submit scores. The inspected game uses a 04:00 UTC reset with map zero on 2 April 2025. Its displayed par is the rounded global average and changes during the day.

`golf/data/courses.json` retains one latest snapshot per course date, including collection time, par, average, completion percentage, score range, and first/repeat percentiles for integer scores up to the daily maximum, capped at 500. Collection is sequential with a 150 ms pause between score requests, a 15-second request timeout, and up to three attempts for temporary failures. These are snapshots collected over an interval, not a single atomic reading. The game has no documented integration contract; changes to its page or internal requests may require collector updates. Invalid responses and collections crossing the daily reset leave the existing archive intact.

`.github/workflows/golf-stats.yml` collects four times daily at 05:17, 11:17, 17:17, and 23:17 UTC, saves snapshots to the repository, and deploys GitHub Pages. Main-branch pushes run checks and deploy without recollecting. Manual workflow runs collect and deploy. In repository **Settings → Pages**, select **GitHub Actions** as the build source before enabling this workflow. Its explicit Pages deployment publishes collected data even though commits made by `GITHUB_TOKEN` do not trigger another workflow. Scheduled jobs can be delayed by GitHub; timestamps in the UI identify the collection time.

The browser reads game statistics from the checked-in JSON feed, avoiding cross-origin game requests. If the feed fails, score entry and league statistics remain available; game data is marked unavailable. Global statistics are never fabricated when a snapshot is missing. The archive begins when collection starts; this collector cannot backfill past game statistics.

## League rules

- Weeks run Monday through Friday in Europe/Copenhagen, including daylight-saving changes. Lowest total wins. Played and assigned scores count toward all due rounds for ranking. During the week, rankings are provisional.
- Once a day is earlier than the league's current date, every registered player without a submission is assigned the highest submitted score on that map plus one. Today's and future rounds remain pending. If nobody submitted on a day, it stays pending until a submitted score provides a baseline. Weekends are excluded.
- Assigned scores appear in red with `DNF` (did not finish). Their details show the highest submitted score and the added stroke. Weekly totals show played and assigned round counts separately.
- Assignments are calculated from submissions when standings are read, including archived weeks. They are not stored as submissions and have no checkpoints. Multiple absent players receive the same score; assignments never become the baseline for another assignment. Late submissions replace assignments and recalculate any assignments based on the day's highest score.
- Players with pending due rounds appear below the rankings, ordered by rounds counted, then total. Pending rounds do not count as zero.
- Equal totals share a place. The archive shows every tied winner and loser. A sole eligible player is the winner and has no loser.
- One submission per player per map. Scores are final: duplicate writes are rejected by the adapter. There is no update operation.
- Missing earlier weekday scores in the season can be submitted before the current map is submitted. They recalculate assignments and archived awards. Existing submissions cannot be changed.
- Checkpoint counts vary by map. A checkpoint dash means skipped, not zero shots. The reported total must equal the numeric checkpoint shots.

## Source layout

- `index.html`, `styles.css`, `assets/`: page and original SVG artwork.
- `app.js`: rendering, forms, dialogs, and interactions.
- `domain.js`: parsing, date arithmetic, standings, and awards.
- `config.js`: initial calendar defaults and active-map selection; server configuration takes precedence.
- `accounts.js`, `database.js`, `supabase-db.js`, `supabase-config.js`: username/password validation, client initialization, database adapter, and public project configuration.
- `supabase/setup.sql`: schema, server validation, permissions, and backend calendar.
- `scripts/build.js`, `vendor/`: bundled client and allowlisted Pages artifact.
- `tests/`: domain, collection, adapter, and SQL permission checks; never published.
- `course-data.js`, `data/courses.json`: validated daily game snapshots and feed loading.
- `scripts/scrape-courses.js`: game page inspection and daily statistics collection.

## Database interface

| Method | Result |
| --- | --- |
| `getLeague()` | `{ config, players, scores, courses, identity, account }` from `golf_state()` |
| `registerAccount(username, password)` | Managed Auth signup, or credentials added to the current anonymous player |
| `signIn(username, password)` | Supabase password session |
| `signOut()` | Sign out of the current device |
| `changePassword(currentPassword, password)` | Reauthenticate and update the managed password |
| `updateDisplayName(name)` | Update the signed-in player's display name |
| `submitScore({ rawText })` | Server-parsed score from `golf_submit_score()` |
| `submitBonusScore({ mapNumber, total })` | Current daily bonus shot count from `golf_submit_bonus_score()` |
| `exportData()` | JSON containing calendar, players, league scores, and separate bonus scores; no auth session |

`league.scores` contains actual submissions only. `standingsForWeek()` derives DNF scores with `assigned: true` and `highestTotal`, keeping assignments out of submission uniqueness checks and personal statistics. Courses come from the validated checked-in feed. Dates and active-map eligibility come from the database.

The client dependency is pinned in `package-lock.json`. The checked-in `vendor/` files allow local HTTP preview without a build. Run `npm run build` after dependency changes; it regenerates the SDK bundle and third-party licenses, then writes a clean allowlisted `dist/golf/`. Tests, SQL files, Node dependencies, and sample fixtures are excluded from the Pages artifact. The workflow installs dependencies, runs the checks, collects game statistics on scheduled/manual runs, builds, and publishes `dist/`.
