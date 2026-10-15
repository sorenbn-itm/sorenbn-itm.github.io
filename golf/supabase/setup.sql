begin;

create schema if not exists golf_private;
revoke all on schema golf_private from public, anon, authenticated;

create or replace function golf_private.clock()
returns timestamptz language sql stable set search_path = ''
as $$ select current_timestamp $$;

create table if not exists public.golf_settings (
  singleton boolean primary key default true check (singleton),
  season_start date not null,
  anchor_date date not null default date '2025-04-02',
  anchor_map integer not null default 0,
  reset_hour_utc integer not null default 4 check (reset_hour_utc between 0 and 23)
);

insert into public.golf_settings (singleton, season_start)
values (true, date_trunc('week', current_timestamp at time zone 'Europe/Copenhagen')::date)
on conflict do nothing;

create table if not exists public.golf_players (
  id uuid primary key references auth.users(id),
  name text not null check (char_length(name) between 2 and 24 and name !~ '[[:cntrl:]]'),
  created_at timestamptz not null default current_timestamp
);
create unique index if not exists golf_players_name_unique on public.golf_players (lower(name));

create table if not exists public.golf_scores (
  player_id uuid not null references public.golf_players(id),
  map_number integer not null check (map_number between 1 and 1000000),
  course_date date not null,
  total integer not null check (total between 1 and 10000),
  checkpoints jsonb not null check (jsonb_typeof(checkpoints) = 'array'),
  raw_text text not null check (char_length(raw_text) between 1 and 12000),
  submitted_at timestamptz not null default current_timestamp,
  primary key (player_id, map_number),
  unique (player_id, course_date)
);
create index if not exists golf_scores_map_index on public.golf_scores (map_number);

alter table public.golf_settings enable row level security;
alter table public.golf_players enable row level security;
alter table public.golf_scores enable row level security;
revoke all on public.golf_settings, public.golf_players, public.golf_scores from public, anon, authenticated;
grant select on public.golf_settings, public.golf_players, public.golf_scores to anon, authenticated;

drop policy if exists golf_settings_read on public.golf_settings;
create policy golf_settings_read on public.golf_settings for select to anon, authenticated using (true);
drop policy if exists golf_players_read on public.golf_players;
create policy golf_players_read on public.golf_players for select to anon, authenticated using (true);
drop policy if exists golf_scores_read on public.golf_scores;
create policy golf_scores_read on public.golf_scores for select to anon, authenticated using (true);

create or replace function golf_private.parse_score(p_text text)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  v_text text;
  v_line text;
  v_match text[];
  v_maps text[];
  v_totals text[];
  v_map integer;
  v_total integer;
  v_index bigint;
  v_shots integer;
  v_sum integer := 0;
  v_seen jsonb := '{}'::jsonb;
  v_checkpoints jsonb := '[]'::jsonb;
begin
  if p_text is null or char_length(p_text) > 12000 then
    raise exception 'Paste one complete result.' using errcode = '22023';
  end if;
  v_text := btrim(replace(replace(replace(p_text, chr(160), ' '), E'\r\n', E'\n'), E'\r', E'\n'));
  select array_agg(m[1]) into v_maps from regexp_matches(v_text, '#([0-9]+)\M', 'g') m;
  if coalesce(array_length(v_maps, 1), 0) <> 1 or length(v_maps[1]) > 7 then
    raise exception 'Include one map number, such as #561.' using errcode = '22023';
  end if;
  v_map := v_maps[1]::integer;
  if v_map < 1 or v_map > 1000000 then
    raise exception 'Invalid map number.' using errcode = '22023';
  end if;
  select array_agg(btrim(line)) into v_totals
    from regexp_split_to_table(v_text, E'\n') line where position('📝' in line) > 0;
  if coalesce(array_length(v_totals, 1), 0) <> 1 then
    raise exception 'Include the total score line.' using errcode = '22023';
  end if;
  v_match := regexp_match(v_totals[1], '^📝️?[[:space:]]*([0-9]+)[[:space:]]*$');
  if v_match is null or length(v_match[1]) > 5 then
    raise exception 'Invalid total score.' using errcode = '22023';
  end if;
  v_total := v_match[1]::integer;
  if v_total < 1 or v_total > 10000 then
    raise exception 'Total must be between 1 and 10000.' using errcode = '22023';
  end if;
  for v_line in select btrim(line) from regexp_split_to_table(v_text, E'\n') line loop
    if v_line !~ '^[0-9]+[[:space:]]*\.' then continue; end if;
    v_match := regexp_match(v_line,
      '^([0-9]+)\.[[:space:]]*(?:⛳️?|🏌️?(?:‍[♂♀]️?)?)[[:space:]]*([0-9]+|[-–—])[[:space:]]*$');
    if v_match is null or length(v_match[1]) > 16 then
      raise exception 'Invalid checkpoint line.' using errcode = '22023';
    end if;
    v_index := v_match[1]::bigint;
    if v_index > 9007199254740991 or v_seen ? v_index::text then
      raise exception 'Invalid or repeated checkpoint number.' using errcode = '22023';
    end if;
    v_seen := v_seen || jsonb_build_object(v_index::text, true);
    if v_match[2] in ('-', '–', '—') then
      v_shots := null;
    else
      if length(v_match[2]) > 5 or v_match[2]::integer > 10000 then
        raise exception 'Invalid checkpoint shots.' using errcode = '22023';
      end if;
      v_shots := v_match[2]::integer;
    end if;
    v_sum := v_sum + coalesce(v_shots, 0);
    v_checkpoints := v_checkpoints || jsonb_build_array(jsonb_build_object('index', v_index, 'shots', v_shots));
  end loop;
  if not (v_seen ? '0') or v_sum <> v_total then
    raise exception 'Include all checkpoints. Their shots must add up to the total.' using errcode = '22023';
  end if;
  select jsonb_agg(value order by (value->>'index')::bigint desc) into v_checkpoints
    from jsonb_array_elements(v_checkpoints);
  return jsonb_build_object('mapNumber', v_map, 'total', v_total,
    'checkpoints', v_checkpoints, 'rawText', v_text);
end;
$$;

create or replace function public.golf_state()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_settings public.golf_settings;
  v_today date := (golf_private.clock() at time zone 'Europe/Copenhagen')::date;
  v_active date;
  v_players jsonb;
  v_scores jsonb;
  v_identity jsonb;
begin
  select * into strict v_settings from public.golf_settings where singleton;
  v_active := ((golf_private.clock() at time zone 'UTC') - make_interval(hours => v_settings.reset_hour_utc))::date;
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'createdAt', created_at) order by created_at, id), '[]'::jsonb)
    into v_players from public.golf_players;
  select jsonb_build_object('id', id, 'name', name, 'createdAt', created_at)
    into v_identity from public.golf_players where id = auth.uid();
  select coalesce(jsonb_agg(jsonb_build_object('playerId', player_id, 'mapNumber', map_number,
    'courseDate', course_date, 'total', total, 'checkpoints', checkpoints,
    'rawText', raw_text, 'submittedAt', submitted_at) order by course_date, player_id), '[]'::jsonb)
    into v_scores from public.golf_scores;
  return jsonb_build_object('players', v_players, 'scores', v_scores, 'courses', '[]'::jsonb,
    'identity', v_identity, 'config', jsonb_build_object('name', 'Kinda Hard Golf scores',
      'timeZone', 'Europe/Copenhagen', 'today', v_today, 'weekdays', jsonb_build_array(1,2,3,4,5),
      'seasonStart', v_settings.season_start, 'archiveWeeks', 3,
      'mapAnchor', jsonb_build_object('date', v_settings.anchor_date, 'number', v_settings.anchor_map),
      'activeCourseDate', v_active, 'activeMapNumber', v_active - v_settings.anchor_date + v_settings.anchor_map,
      'acceptingScores', extract(isodow from v_active) between 1 and 5 and v_active >= v_settings.season_start));
end;
$$;

create or replace function public.golf_register_player(p_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := auth.uid();
  v_name text;
  v_player public.golf_players;
begin
  if v_id is null then raise exception 'A player session is required.' using errcode = '42501'; end if;
  if exists(select 1 from public.golf_players where id = v_id) then
    raise exception 'This browser already has a name.' using errcode = '22023';
  end if;
  if p_name is null or char_length(p_name) > 200 then
    raise exception 'Choose a name between 2 and 24 characters.' using errcode = '22023';
  end if;
  v_name := btrim(regexp_replace(normalize(p_name, NFKC), '[[:space:]]+', ' ', 'g'));
  if char_length(v_name) not between 2 and 24 or v_name ~ '[[:cntrl:]]' then
    raise exception 'Choose a name between 2 and 24 characters.' using errcode = '22023';
  end if;
  insert into public.golf_players(id, name) values(v_id, v_name) returning * into v_player;
  return jsonb_build_object('id', v_player.id, 'name', v_player.name, 'createdAt', v_player.created_at);
exception when unique_violation then
  raise exception 'That name is already taken.' using errcode = '23505';
end;
$$;

create or replace function public.golf_submit_score(p_raw_text text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := auth.uid();
  v_parsed jsonb;
  v_settings public.golf_settings;
  v_date date;
  v_active date;
  v_score public.golf_scores;
begin
  if v_id is null or not exists(select 1 from public.golf_players where id = v_id) then
    raise exception 'Enter your name before submitting a score.' using errcode = '42501';
  end if;
  v_parsed := golf_private.parse_score(p_raw_text);
  select * into strict v_settings from public.golf_settings where singleton;
  v_date := v_settings.anchor_date + ((v_parsed->>'mapNumber')::integer - v_settings.anchor_map);
  v_active := ((golf_private.clock() at time zone 'UTC') - make_interval(hours => v_settings.reset_hour_utc))::date;
  if v_date > v_active or v_date < v_settings.season_start or extract(isodow from v_date) not between 1 and 5 then
    raise exception 'Submit a weekday map from this season that has already opened.' using errcode = '22023';
  end if;
  insert into public.golf_scores(player_id, map_number, course_date, total, checkpoints, raw_text, submitted_at)
    values(v_id, (v_parsed->>'mapNumber')::integer, v_date, (v_parsed->>'total')::integer,
      v_parsed->'checkpoints', v_parsed->>'rawText', golf_private.clock()) returning * into v_score;
  return v_parsed || jsonb_build_object('playerId', v_id, 'courseDate', v_date, 'submittedAt', v_score.submitted_at);
exception when unique_violation then
  raise exception 'You already submitted a score for this map. Scores are final.' using errcode = '23505';
end;
$$;

revoke all on all functions in schema golf_private from public, anon, authenticated;
revoke all on function public.golf_state(), public.golf_register_player(text), public.golf_submit_score(text) from public, anon, authenticated;
grant execute on function public.golf_state() to anon, authenticated;
grant execute on function public.golf_register_player(text), public.golf_submit_score(text) to authenticated;

commit;
