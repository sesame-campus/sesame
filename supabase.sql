-- =============================================================
--  SÉSAME v2.2 — base de données (QR qui change toutes les 10 s)
--  À coller EN ENTIER dans Supabase > SQL Editor > requête vide > Run.
--  Peut être relancé sans risque : ne supprime aucune donnée
--  (étudiants, QR, historique, réglages sont conservés).
-- =============================================================

-- Chiffrement des codes personnels (déjà installé sur Supabase)
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------- Tables ----------
create table if not exists public.students (
  b00        text primary key check (b00 ~ '^B00[0-9]{6}$'),
  email      text not null,
  prenom     text not null,
  nom        text not null,
  photo      text not null,               -- photo carrée compressée (data:image/jpeg;base64,...)
  updated_at timestamptz not null default now()
);
alter table public.students add column if not exists created_at  timestamptz not null default now();
alter table public.students add column if not exists consent_at  timestamptz;          -- accord RGPD
alter table public.students add column if not exists blocked     boolean not null default false;
alter table public.students add column if not exists photo_reset boolean not null default false; -- l'admin demande une nouvelle photo
alter table public.students add column if not exists pin_hash         text;                      -- code personnel (chiffré)
alter table public.students add column if not exists pin_failures     int not null default 0;
alter table public.students add column if not exists pin_locked_until timestamptz;
create index if not exists students_email_idx on public.students (email);

create table if not exists public.tokens (
  id         text primary key,            -- code à 8 caractères contenu dans le QR
  b00        text not null references public.students(b00) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,        -- 23:59:59 (heure de Paris) le jour de création
  week       date not null,               -- lundi de la semaine (heure de Paris)
  used_at    timestamptz                  -- rempli au premier scan validé
);
alter table public.tokens add column if not exists counted boolean not null default true; -- false = remis à zéro par l'admin
alter table public.tokens add column if not exists secret  text;   -- v2.2 : clé du QR qui change toutes les 10 secondes
create index if not exists tokens_b00_week_idx on public.tokens (b00, week);

-- Historique : chaque scan d'agent, accepté ou refusé. Conservé sans limite de durée.
create table if not exists public.scans (
  id         bigint generated always as identity primary key,
  token_id   text,
  b00        text,                         -- vide si le code est inconnu
  verdict    text not null,                -- ok | used | expired | blocked | unknown
  scanned_at timestamptz not null default now()
);
create index if not exists scans_time_idx on public.scans (scanned_at desc);
create index if not exists scans_b00_idx  on public.scans (b00, scanned_at desc);

-- Tentatives de PIN / mot de passe ratées (anti-devinette)
create table if not exists public.secret_failures (
  id   bigint generated always as identity primary key,
  kind text not null,
  ip   text not null,
  at   timestamptz not null default now()
);
create index if not exists secret_failures_idx on public.secret_failures (kind, ip, at desc);

create table if not exists public.settings (
  key   text primary key,
  value text not null
);
insert into public.settings (key, value) values
  ('agent_pin',      '2580'),
  ('week_limit',     '6'),
  ('admin_password', 'sesame-admin-2026'),  -- ⚠️ à changer dans l'espace admin (Réglages)
  ('email_domain',   'essec.edu')           -- seules ces adresses peuvent s'inscrire ('' = toutes)
on conflict (key) do nothing;

-- Personne ne lit ni n'écrit les tables directement : tout passe par les fonctions.
alter table public.students        enable row level security;
alter table public.tokens          enable row level security;
alter table public.scans           enable row level security;
alter table public.secret_failures enable row level security;
alter table public.settings        enable row level security;

-- Anciennes fonctions v1 (sans vérification du mail) : supprimées.
drop function if exists public.student_state(text, text, boolean);
drop function if exists public.register_student(text, text, text, text, text);
drop function if exists public.generate_token(text, text);
drop function if exists public.verify_pin(text);
-- v2 sans code personnel : remplacées par des versions avec code
drop function if exists public.register_me(text, text, text, text, boolean);
drop function if exists public.generate_my_token();

-- =============================================================
--  Outils internes
-- =============================================================
create or replace function public.paris_week() returns date
language sql stable set search_path = public as $$
  select date_trunc('week', now() at time zone 'Europe/Paris')::date
$$;

create or replace function public.paris_today_start() returns timestamptz
language sql stable set search_path = public as $$
  select date_trunc('day', now() at time zone 'Europe/Paris') at time zone 'Europe/Paris'
$$;

create or replace function public.paris_end_of_day() returns timestamptz
language sql stable set search_path = public as $$
  select ((date_trunc('day', now() at time zone 'Europe/Paris') + interval '1 day')
          at time zone 'Europe/Paris') - interval '1 millisecond'
$$;

-- Adresse mail vérifiée de l'étudiant connecté (via le code reçu par mail)
create or replace function public.me_email() returns text
language sql stable set search_path = public as $$
  select nullif(lower(coalesce(auth.jwt() ->> 'email', '')), '')
$$;

create or replace function public.email_allowed(p_email text) returns boolean
language sql stable set search_path = public as $$
  select coalesce((select value from public.settings where key = 'email_domain'), '') = ''
      or lower(p_email) like '%@' || lower((select value from public.settings where key = 'email_domain'))
$$;

create or replace function public.client_ip() returns text
language plpgsql stable set search_path = public as $$
declare h text := current_setting('request.headers', true);
begin
  if h is null or h = '' then return 'inconnu'; end if;
  return coalesce(nullif(trim(split_part(h::json ->> 'x-forwarded-for', ',', 1)), ''), 'inconnu');
exception when others then return 'inconnu';
end $$;

-- Vérifie un PIN / mot de passe. 6 erreurs en 15 min depuis la même connexion = blocage 15 min.
-- Renvoie 'ok', 'bad' ou 'locked' (sans lever d'erreur, pour que l'échec soit bien enregistré).
create or replace function public.check_secret(p_key text, p_value text) returns text
language plpgsql volatile security definer set search_path = public as $$
declare
  v_ip   text := client_ip();
  v_fail int;
begin
  select count(*) into v_fail from secret_failures
   where kind = p_key and ip = v_ip and at > now() - interval '15 minutes';
  if v_fail >= 6 then return 'locked'; end if;
  if coalesce(p_value, '') <> ''
     and exists (select 1 from settings where key = p_key and value = p_value) then
    return 'ok';
  end if;
  insert into secret_failures (kind, ip) values (p_key, v_ip);
  return case when v_fail + 1 >= 6 then 'locked' else 'bad' end;
end $$;

-- Code personnel : 6 chiffres, pas trop évident
create or replace function public.pin_valid(p_pin text) returns text
language plpgsql immutable set search_path = public as $$
begin
  if coalesce(p_pin, '') !~ '^[0-9]{6}$' then return 'PIN_FORMAT'; end if;
  if p_pin ~ '^(.)\1{5}$' or p_pin in ('123456', '654321', '012345', '543210', '121212', '123123') then
    return 'PIN_WEAK';
  end if;
  return null;
end $$;

-- QR dynamique : le QR change toutes les 10 secondes.
-- Chaque QR contient « code.étape.signature », où étape = nombre de tranches de 10 s
-- depuis 1970 et signature = HMAC-SHA256(code.étape, clé secrète du QR).
-- Une capture d'écran est donc refusée au bout d'environ 20 secondes.
create or replace function public.qr_step() returns bigint
language sql volatile set search_path = public as $$
  select floor(extract(epoch from clock_timestamp()) / 10)::bigint
$$;

create or replace function public.qr_hex(p_id text, p_step bigint, p_secret text) returns text
language sql immutable set search_path = public as $$
  select encode(extensions.hmac(p_id || '.' || p_step::text, p_secret, 'sha256'), 'hex')
$$;

-- Code de secours à taper à la main : 4 chiffres tirés de la même signature
create or replace function public.qr_otp(p_hex text) returns text
language sql immutable set search_path = public as $$
  select lpad((('x' || lpad(substr(p_hex, 9, 8), 16, '0'))::bit(64)::bigint % 10000)::text, 4, '0')
$$;

-- Réglages publics (affichés avant connexion)
create or replace function public.public_config() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'email_domain', (select value from settings where key = 'email_domain'),
    'week_limit',   (select value::int from settings where key = 'week_limit'))
$$;

-- =============================================================
--  Étudiant (nécessite d'être connecté avec le code reçu par mail)
-- =============================================================
create or replace function public.my_state(p_with_photo boolean default false) returns json
language plpgsql security definer set search_path = public as $$
declare
  v_email  text := me_email();
  s        students;
  v_count  int;
  v_limit  int;
  v_active tokens;
  v_used   timestamptz;
begin
  if v_email is null then raise exception 'NOT_AUTH'; end if;
  select * into s from students where email = v_email order by updated_at desc limit 1;
  if not found then
    return json_build_object('registered', false, 'email', v_email,
                             'email_allowed', email_allowed(v_email));
  end if;

  select value::int into v_limit from settings where key = 'week_limit';
  select count(*) into v_count from tokens where b00 = s.b00 and week = paris_week() and counted;
  select * into v_active from tokens
   where b00 = s.b00 and used_at is null and expires_at > now()
   order by created_at desc limit 1;
  select max(used_at) into v_used from tokens
   where b00 = s.b00 and used_at >= paris_today_start();

  return json_build_object(
    'registered', true, 'email', v_email,
    'b00', s.b00, 'prenom', s.prenom, 'nom', s.nom,
    'photo', case when p_with_photo then s.photo else null end,
    'blocked', s.blocked, 'needs_consent', s.consent_at is null, 'needs_photo', s.photo_reset,
    'needs_pin', s.pin_hash is null,
    'pin_locked_until', case when s.pin_locked_until > now() then s.pin_locked_until end,
    'used_this_week', v_count, 'week_limit', v_limit,
    -- Le code du QR n'est jamais renvoyé ici : seulement après le code personnel.
    'has_active', v_active.id is not null,
    'used_today_at', v_used);
end $$;

create or replace function public.register_me(
  p_prenom text, p_nom text, p_b00 text, p_photo text, p_consent boolean, p_pin text)
returns json
language plpgsql security definer set search_path = public as $$
declare
  v_email text := me_email();
  v_b00   text := upper(trim(coalesce(p_b00, '')));
  v_old   students;
  v_pin   text := pin_valid(p_pin);
begin
  if v_email is null then raise exception 'NOT_AUTH'; end if;
  if not email_allowed(v_email) then raise exception 'EMAIL_DOMAIN'; end if;
  if v_b00 !~ '^B00[0-9]{6}$' then raise exception 'B00_FORMAT'; end if;
  if coalesce(trim(p_prenom), '') = '' or coalesce(trim(p_nom), '') = '' then raise exception 'NAME_MISSING'; end if;
  if p_photo is null or left(p_photo, 11) <> 'data:image/' or length(p_photo) > 300000 then
    raise exception 'PHOTO_INVALID';
  end if;
  if p_consent is not true then raise exception 'CONSENT_REQUIRED'; end if;
  if v_pin is not null then raise exception '%', v_pin; end if;
  if exists (select 1 from students where email = v_email and b00 <> v_b00) then
    raise exception 'ALREADY_REGISTERED';
  end if;

  select * into v_old from students where b00 = v_b00;
  if found then
    if v_old.email <> v_email then raise exception 'B00_TAKEN'; end if;
    return my_state(true);            -- déjà inscrit : la photo reste verrouillée
  end if;

  insert into students (b00, email, prenom, nom, photo, consent_at, created_at, updated_at, pin_hash)
  values (v_b00, v_email, trim(p_prenom), trim(p_nom), p_photo, now(), now(), now(),
          extensions.crypt(p_pin, extensions.gen_salt('bf', 8)));
  return my_state(true);
end $$;

create or replace function public.give_consent() returns json
language plpgsql security definer set search_path = public as $$
begin
  if me_email() is null then raise exception 'NOT_AUTH'; end if;
  update students set consent_at = now(), updated_at = now()
   where email = me_email() and consent_at is null;
  return my_state(false);
end $$;

-- Changement de photo : seulement si l'admin l'a demandé (photo verrouillée sinon)
create or replace function public.update_my_photo(p_photo text) returns json
language plpgsql security definer set search_path = public as $$
declare s students;
begin
  if me_email() is null then raise exception 'NOT_AUTH'; end if;
  select * into s from students where email = me_email() limit 1;
  if not found then raise exception 'NOT_REGISTERED'; end if;
  if not s.photo_reset then raise exception 'PHOTO_LOCKED'; end if;
  if p_photo is null or left(p_photo, 11) <> 'data:image/' or length(p_photo) > 300000 then
    raise exception 'PHOTO_INVALID';
  end if;
  update students set photo = p_photo, photo_reset = false, updated_at = now() where b00 = s.b00;
  return my_state(true);
end $$;

-- Création du code personnel (comptes existants, ou après réinitialisation par l'admin)
create or replace function public.set_my_pin(p_pin text) returns json
language plpgsql security definer set search_path = public as $$
declare s students; v_pin text := pin_valid(p_pin);
begin
  if me_email() is null then raise exception 'NOT_AUTH'; end if;
  select * into s from students where email = me_email() limit 1;
  if not found then raise exception 'NOT_REGISTERED'; end if;
  if s.pin_hash is not null then raise exception 'PIN_ALREADY_SET'; end if;
  if v_pin is not null then raise exception '%', v_pin; end if;
  update students set pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf', 8)),
                      pin_failures = 0, pin_locked_until = null, updated_at = now()
   where b00 = s.b00;
  return my_state(false);
end $$;

-- Génère (ou réaffiche) le QR du jour. Exige le code personnel.
-- 5 codes faux = génération bloquée 15 minutes. Les erreurs de code sont renvoyées
-- dans la réponse (pas en exception) pour que le compteur d'erreurs soit bien enregistré.
create or replace function public.generate_my_token(p_pin text) returns json
language plpgsql security definer set search_path = public as $$
declare
  v_email  text := me_email();
  s        students;
  v_count  int;
  v_limit  int;
  v_active tokens;
  v_alpha  text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   -- sans 0/O, 1/I/L
  v_bytes  bytea;
  v_id     text;
  v_pos    int;
begin
  if v_email is null then raise exception 'NOT_AUTH'; end if;
  select * into s from students where email = v_email limit 1 for update;
  if not found then raise exception 'NOT_REGISTERED'; end if;
  if s.blocked then raise exception 'BLOCKED'; end if;
  if s.consent_at is null then raise exception 'CONSENT_REQUIRED'; end if;
  if s.photo_reset then raise exception 'PHOTO_REQUIRED'; end if;
  if s.pin_hash is null then raise exception 'PIN_REQUIRED'; end if;

  -- Vérification du code personnel
  if s.pin_locked_until > now() then
    return json_build_object('error', 'PIN_LOCKED', 'until', s.pin_locked_until);
  end if;
  if extensions.crypt(coalesce(p_pin, ''), s.pin_hash) <> s.pin_hash then
    if s.pin_failures + 1 >= 5 then
      update students set pin_failures = 0, pin_locked_until = now() + interval '15 minutes' where b00 = s.b00;
      return json_build_object('error', 'PIN_LOCKED', 'until', now() + interval '15 minutes');
    end if;
    update students set pin_failures = s.pin_failures + 1 where b00 = s.b00;
    return json_build_object('error', 'PIN_BAD', 'remaining', 5 - (s.pin_failures + 1));
  end if;
  if s.pin_failures > 0 or s.pin_locked_until is not null then
    update students set pin_failures = 0, pin_locked_until = null where b00 = s.b00;
  end if;

  -- Un QR encore valable ? On le réaffiche sans consommer de quota.
  select * into v_active from tokens
   where b00 = s.b00 and used_at is null and expires_at > now()
   order by created_at desc limit 1;

  if v_active.id is null then
    select value::int into v_limit from settings where key = 'week_limit';
    select count(*) into v_count from tokens where b00 = s.b00 and week = paris_week() and counted;
    if v_count >= v_limit then raise exception 'WEEK_LIMIT'; end if;

    loop
      v_bytes := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
      v_id := '';
      foreach v_pos in array array[0,1,2,3,4,5,10,11] loop
        v_id := v_id || substr(v_alpha, 1 + get_byte(v_bytes, v_pos) % length(v_alpha), 1);
      end loop;
      exit when not exists (select 1 from tokens where id = v_id);
    end loop;
    insert into tokens (id, b00, expires_at, week, secret)
    values (v_id, s.b00, paris_end_of_day(), paris_week(), encode(extensions.gen_random_bytes(16), 'hex'))
    returning * into v_active;
  elsif v_active.secret is null then
    update tokens set secret = encode(extensions.gen_random_bytes(16), 'hex')
     where id = v_active.id returning * into v_active;
  end if;

  -- La clé n'est envoyée qu'après le code personnel, et reste dans la mémoire de l'appli.
  return json_build_object(
    'state', my_state(false),
    'qr', json_build_object('id', v_active.id, 'expires_at', v_active.expires_at,
                            'secret', v_active.secret,
                            'server_time', floor(extract(epoch from clock_timestamp()) * 1000)::bigint));
end $$;

-- Droit à l'effacement : supprime le profil, la photo et les QR.
-- L'historique des passages (B00, date, verdict) est conservé.
create or replace function public.delete_my_account() returns json
language plpgsql security definer set search_path = public as $$
declare v_email text := me_email();
begin
  if v_email is null then raise exception 'NOT_AUTH'; end if;
  delete from students where email = v_email;
  begin
    delete from auth.users where id = auth.uid();
  exception when others then null;
  end;
  return json_build_object('deleted', true);
end $$;

-- =============================================================
--  Agent de sécurité (PIN)
-- =============================================================
create or replace function public.verify_pin(p_pin text) returns json
language plpgsql security definer set search_path = public as $$
declare v_sec text := check_secret('agent_pin', p_pin);
begin
  if v_sec <> 'ok' then return json_build_object('error', v_sec); end if;
  return json_build_object('ok', true);
end $$;

create or replace function public.check_token(p_code text, p_pin text) returns json
language plpgsql security definer set search_path = public as $$
declare
  v_sec     text := check_secret('agent_pin', p_pin);
  v_raw     text := trim(coalesce(p_code, ''));
  v_code    text;
  v_mode    text;            -- qr | manual | static
  v_step    bigint;
  v_sig     text;
  v_otp     text;
  v_now     bigint := qr_step();
  v_fresh   boolean := false;
  k         bigint;
  t         tokens;
  s         students;
  v_verdict text;
begin
  if v_sec <> 'ok' then return json_build_object('error', v_sec); end if;

  -- Formats acceptés :
  --   QR scanné      : CODE8.ÉTAPE.SIGNATURE   (ex. K7QF2MXP.176412345.a1b2c3d4)
  --   Code tapé      : CODE8 + 4 chiffres      (ex. K7QF-2MXP-0427)
  --   Ancien QR fixe : CODE8 seul               (refusé : capture probable)
  if v_raw ~* '^[A-Z0-9]{8}\.[0-9]{1,15}\.[0-9a-f]{8}$' then
    v_mode := 'qr';
    v_code := upper(split_part(v_raw, '.', 1));
    v_step := split_part(v_raw, '.', 2)::bigint;
    v_sig  := lower(split_part(v_raw, '.', 3));
  else
    v_code := upper(regexp_replace(v_raw, '[^A-Za-z0-9]', '', 'g'));
    if v_code ~ '^[A-Z0-9]{8}[0-9]{4}$' then
      v_mode := 'manual'; v_otp := right(v_code, 4); v_code := left(v_code, 8);
    else
      v_mode := 'static';
    end if;
  end if;

  -- Verrou sur le QR : deux scans simultanés passent l'un après l'autre.
  select * into t from tokens where id = v_code for update;
  if not found or (v_mode = 'qr' and (t.secret is null or qr_hex(t.id, v_step, t.secret) not like v_sig || '%')) then
    -- Code inconnu, ou signature fausse (QR fabriqué) : aucune info sur l'étudiant.
    insert into scans (token_id, b00, verdict) values (left(v_code, 32), null, 'unknown');
    return json_build_object('verdict', 'unknown');
  end if;

  -- QR « en direct » : étape actuelle ou précédente (≈ 20 s au maximum)
  if v_mode = 'qr' then
    v_fresh := v_step between v_now - 1 and v_now + 1;
  elsif v_mode = 'manual' and t.secret is not null then
    -- Code tapé à la main : un peu plus de marge (≈ 40 s)
    for k in v_now - 3 .. v_now + 1 loop
      if qr_otp(qr_hex(t.id, k, t.secret)) = v_otp then v_fresh := true; exit; end if;
    end loop;
  end if;

  select * into s from students where b00 = t.b00;
  if s.blocked then
    v_verdict := 'blocked';
  elsif t.used_at is not null then
    v_verdict := 'used';
  elsif t.expires_at <= now() then
    v_verdict := 'expired';
  elsif not v_fresh then
    v_verdict := 'stale';      -- capture d'écran ou code périmé : le QR reste valable
  else
    update tokens set used_at = now() where id = t.id returning * into t;
    v_verdict := 'ok';
  end if;

  insert into scans (token_id, b00, verdict) values (t.id, t.b00, v_verdict);

  return json_build_object(
    'verdict', v_verdict, 'used_at', t.used_at, 'created_at', t.created_at,
    'student', json_build_object('b00', s.b00, 'prenom', s.prenom, 'nom', s.nom, 'photo', s.photo),
    'week', json_build_object(
      'limit',     (select value::int from settings where key = 'week_limit'),
      'generated', (select count(*) from tokens where b00 = t.b00 and week = paris_week() and counted),
      'refused',   (select count(*) from scans where b00 = t.b00 and verdict <> 'ok'
                      and scanned_at >= (paris_week()::timestamp at time zone 'Europe/Paris')),
      'passages',  coalesce((select json_agg(x.used_at order by x.used_at desc) from tokens x
                              where x.b00 = t.b00 and x.week = paris_week() and x.used_at is not null), '[]'::json)));
end $$;

create or replace function public.agent_history(p_pin text) returns json
language plpgsql security definer set search_path = public as $$
declare
  v_sec   text := check_secret('agent_pin', p_pin);
  v_start timestamptz := paris_today_start();
begin
  if v_sec <> 'ok' then return json_build_object('error', v_sec); end if;
  return json_build_object(
    'ok',      (select count(*) from scans where scanned_at >= v_start and verdict = 'ok'),
    'refused', (select count(*) from scans where scanned_at >= v_start and verdict <> 'ok'),
    'items', coalesce((
      select json_agg(r order by r.scanned_at desc) from (
        select sc.scanned_at, sc.verdict, sc.b00, sc.token_id, st.prenom, st.nom
          from scans sc left join students st on st.b00 = sc.b00
         where sc.scanned_at >= v_start
         order by sc.scanned_at desc limit 200) r), '[]'::json));
end $$;

-- =============================================================
--  Espace admin (mot de passe admin)
-- =============================================================
create or replace function public.admin_login(p_pw text) returns json
language plpgsql security definer set search_path = public as $$
declare v_sec text := check_secret('admin_password', p_pw);
begin
  if v_sec <> 'ok' then return json_build_object('error', v_sec); end if;
  return json_build_object('ok', true,
    'default_password', (select value from settings where key = 'admin_password') = 'sesame-admin-2026');
end $$;

create or replace function public.admin_overview(p_pw text) returns json
language plpgsql security definer set search_path = public as $$
declare
  v_sec   text := check_secret('admin_password', p_pw);
  v_today timestamptz := paris_today_start();
  v_week  timestamptz := paris_week()::timestamp at time zone 'Europe/Paris';
begin
  if v_sec <> 'ok' then return json_build_object('error', v_sec); end if;
  return json_build_object(
    'today_ok',       (select count(*) from scans where scanned_at >= v_today and verdict = 'ok'),
    'today_refused',  (select count(*) from scans where scanned_at >= v_today and verdict <> 'ok'),
    'week_ok',        (select count(*) from scans where scanned_at >= v_week and verdict = 'ok'),
    'week_refused',   (select count(*) from scans where scanned_at >= v_week and verdict <> 'ok'),
    'week_generated', (select count(*) from tokens where week = paris_week()),
    'students',       (select count(*) from students),
    'students_week',  (select count(*) from students where created_at >= v_week),
    'blocked',        (select count(*) from students where blocked),
    'days', coalesce((
      select json_agg(d order by d.day) from (
        select g.day::date as day,
               (select count(*) from scans c where c.verdict = 'ok'
                  and (c.scanned_at at time zone 'Europe/Paris')::date = g.day::date) as ok,
               (select count(*) from scans c where c.verdict <> 'ok'
                  and (c.scanned_at at time zone 'Europe/Paris')::date = g.day::date) as refused
          from generate_series((now() at time zone 'Europe/Paris')::date - 13,
                               (now() at time zone 'Europe/Paris')::date, interval '1 day') as g(day)) d), '[]'::json),
    'settings', json_build_object(
      'week_limit',   (select value::int from settings where key = 'week_limit'),
      'agent_pin',    (select value from settings where key = 'agent_pin'),
      'email_domain', (select value from settings where key = 'email_domain')),
    'default_password', (select value from settings where key = 'admin_password') = 'sesame-admin-2026');
end $$;

create or replace function public.admin_history(
  p_pw text, p_search text default '', p_from date default null, p_to date default null,
  p_limit int default 50, p_offset int default 0)
returns json
language plpgsql security definer set search_path = public as $$
declare
  v_sec text := check_secret('admin_password', p_pw);
  v_q   text := '%' || coalesce(trim(p_search), '') || '%';
begin
  if v_sec <> 'ok' then return json_build_object('error', v_sec); end if;
  return (
    with f as (
      select sc.id, sc.scanned_at, sc.verdict, sc.b00, sc.token_id, st.prenom, st.nom
        from scans sc left join students st on st.b00 = sc.b00
       where (p_from is null or (sc.scanned_at at time zone 'Europe/Paris')::date >= p_from)
         and (p_to   is null or (sc.scanned_at at time zone 'Europe/Paris')::date <= p_to)
         and (coalesce(trim(p_search), '') = ''
              or sc.b00 ilike v_q or sc.token_id ilike v_q
              or (coalesce(st.prenom, '') || ' ' || coalesce(st.nom, '')) ilike v_q
              or (coalesce(st.nom, '') || ' ' || coalesce(st.prenom, '')) ilike v_q))
    select json_build_object(
      'total', (select count(*) from f),
      'items', coalesce((select json_agg(x order by x.scanned_at desc, x.id desc) from (
                  select * from f order by scanned_at desc, id desc
                  limit least(greatest(coalesce(p_limit, 50), 1), 10000)
                  offset greatest(coalesce(p_offset, 0), 0)) x), '[]'::json)));
end $$;

create or replace function public.admin_students(p_pw text, p_search text default '') returns json
language plpgsql security definer set search_path = public as $$
declare
  v_sec text := check_secret('admin_password', p_pw);
  v_q   text := '%' || coalesce(trim(p_search), '') || '%';
begin
  if v_sec <> 'ok' then return json_build_object('error', v_sec); end if;
  return json_build_object(
    'week_limit', (select value::int from settings where key = 'week_limit'),
    'items', coalesce((select json_agg(x order by x.nom, x.prenom) from (
      select s.b00, s.prenom, s.nom, s.email, s.created_at, s.blocked, s.photo_reset,
             s.consent_at is not null as consent, s.pin_hash is not null as has_pin,
             (select count(*) from tokens t where t.b00 = s.b00 and t.week = paris_week() and t.counted) as week_generated,
             (select count(*) from scans c where c.b00 = s.b00 and c.verdict = 'ok') as total_ok,
             (select max(c.scanned_at) from scans c where c.b00 = s.b00 and c.verdict = 'ok') as last_ok
        from students s
       where coalesce(trim(p_search), '') = ''
          or s.b00 ilike v_q or s.email ilike v_q
          or (s.prenom || ' ' || s.nom) ilike v_q or (s.nom || ' ' || s.prenom) ilike v_q
       order by s.nom, s.prenom limit 500) x), '[]'::json));
end $$;

create or replace function public.admin_student(p_pw text, p_b00 text) returns json
language plpgsql security definer set search_path = public as $$
declare
  v_sec text := check_secret('admin_password', p_pw);
  s     students;
begin
  if v_sec <> 'ok' then return json_build_object('error', v_sec); end if;
  select * into s from students where b00 = upper(trim(p_b00));
  if not found then return json_build_object('error', 'not_found'); end if;
  return json_build_object(
    'b00', s.b00, 'prenom', s.prenom, 'nom', s.nom, 'email', s.email, 'photo', s.photo,
    'created_at', s.created_at, 'consent_at', s.consent_at,
    'blocked', s.blocked, 'photo_reset', s.photo_reset,
    'has_pin', s.pin_hash is not null,
    'pin_locked_until', case when s.pin_locked_until > now() then s.pin_locked_until end,
    'week_limit', (select value::int from settings where key = 'week_limit'),
    'week_generated', (select count(*) from tokens where b00 = s.b00 and week = paris_week() and counted),
    'total_ok', (select count(*) from scans where b00 = s.b00 and verdict = 'ok'),
    'total_refused', (select count(*) from scans where b00 = s.b00 and verdict <> 'ok'),
    'scans', coalesce((select json_agg(x order by x.scanned_at desc) from (
               select scanned_at, verdict from scans where b00 = s.b00
                order by scanned_at desc limit 50) x), '[]'::json));
end $$;

create or replace function public.admin_action(p_pw text, p_b00 text, p_action text) returns json
language plpgsql security definer set search_path = public as $$
declare
  v_sec text := check_secret('admin_password', p_pw);
  v_b00 text := upper(trim(coalesce(p_b00, '')));
begin
  if v_sec <> 'ok' then return json_build_object('error', v_sec); end if;
  if not exists (select 1 from students where b00 = v_b00) then
    return json_build_object('error', 'not_found');
  end if;
  case p_action
    when 'block'       then update students set blocked = true,  updated_at = now() where b00 = v_b00;
    when 'unblock'     then update students set blocked = false, updated_at = now() where b00 = v_b00;
    when 'reset_photo' then update students set photo_reset = true, updated_at = now() where b00 = v_b00;
    when 'reset_pin'   then update students set pin_hash = null, pin_failures = 0, pin_locked_until = null, updated_at = now() where b00 = v_b00;
    when 'reset_week'  then update tokens set counted = false where b00 = v_b00 and week = paris_week();
    when 'delete'      then
      delete from students where b00 = v_b00;
      return json_build_object('deleted', true);
    else return json_build_object('error', 'bad_action');
  end case;
  return admin_student(p_pw, v_b00);
end $$;

create or replace function public.admin_set(p_pw text, p_key text, p_value text) returns json
language plpgsql security definer set search_path = public as $$
declare
  v_sec text := check_secret('admin_password', p_pw);
  v_val text := trim(coalesce(p_value, ''));
begin
  if v_sec <> 'ok' then return json_build_object('error', v_sec); end if;
  if p_key = 'week_limit' then
    if v_val !~ '^[0-9]{1,2}$' or v_val::int < 1 then return json_build_object('error', 'bad_value'); end if;
  elsif p_key = 'agent_pin' then
    if v_val !~ '^[0-9]{4,8}$' then return json_build_object('error', 'bad_value'); end if;
  elsif p_key = 'admin_password' then
    if length(v_val) < 8 then return json_build_object('error', 'bad_value'); end if;
  elsif p_key = 'email_domain' then
    v_val := lower(regexp_replace(v_val, '^@', ''));
    if v_val <> '' and v_val !~ '^[a-z0-9.-]+\.[a-z]{2,}$' then return json_build_object('error', 'bad_value'); end if;
  else
    return json_build_object('error', 'bad_key');
  end if;
  update settings set value = v_val where key = p_key;
  return json_build_object('ok', true, 'key', p_key, 'value', v_val);
end $$;

-- =============================================================
--  Droits d'accès
-- =============================================================
-- Outils internes : jamais appelables depuis le site
revoke all on function public.paris_week()                 from public, anon, authenticated;
revoke all on function public.paris_today_start()          from public, anon, authenticated;
revoke all on function public.paris_end_of_day()           from public, anon, authenticated;
revoke all on function public.me_email()                   from public, anon, authenticated;
revoke all on function public.email_allowed(text)          from public, anon, authenticated;
revoke all on function public.client_ip()                  from public, anon, authenticated;
revoke all on function public.check_secret(text, text)     from public, anon, authenticated;
revoke all on function public.pin_valid(text)              from public, anon, authenticated;
revoke all on function public.qr_step()                    from public, anon, authenticated;
revoke all on function public.qr_hex(text, bigint, text)   from public, anon, authenticated;
revoke all on function public.qr_otp(text)                 from public, anon, authenticated;

-- Étudiant : uniquement connecté (code reçu par mail)
revoke all on function public.my_state(boolean)                              from public, anon;
revoke all on function public.register_me(text, text, text, text, boolean, text) from public, anon;
revoke all on function public.set_my_pin(text)                                from public, anon;
revoke all on function public.give_consent()                                  from public, anon;
revoke all on function public.update_my_photo(text)                           from public, anon;
revoke all on function public.generate_my_token(text)                         from public, anon;
revoke all on function public.delete_my_account()                             from public, anon;
grant execute on function public.my_state(boolean)                           to authenticated;
grant execute on function public.register_me(text, text, text, text, boolean, text) to authenticated;
grant execute on function public.set_my_pin(text)                             to authenticated;
grant execute on function public.give_consent()                               to authenticated;
grant execute on function public.update_my_photo(text)                        to authenticated;
grant execute on function public.generate_my_token(text)                      to authenticated;
grant execute on function public.delete_my_account()                          to authenticated;

-- Public, agent et admin (protégés par PIN / mot de passe)
revoke all on function public.public_config()                                     from public;
revoke all on function public.verify_pin(text)                                    from public;
revoke all on function public.check_token(text, text)                             from public;
revoke all on function public.agent_history(text)                                 from public;
revoke all on function public.admin_login(text)                                   from public;
revoke all on function public.admin_overview(text)                                from public;
revoke all on function public.admin_history(text, text, date, date, int, int)     from public;
revoke all on function public.admin_students(text, text)                          from public;
revoke all on function public.admin_student(text, text)                           from public;
revoke all on function public.admin_action(text, text, text)                      from public;
revoke all on function public.admin_set(text, text, text)                         from public;
grant execute on function public.public_config()                                  to anon, authenticated;
grant execute on function public.verify_pin(text)                                 to anon, authenticated;
grant execute on function public.check_token(text, text)                          to anon, authenticated;
grant execute on function public.agent_history(text)                              to anon, authenticated;
grant execute on function public.admin_login(text)                                to anon, authenticated;
grant execute on function public.admin_overview(text)                             to anon, authenticated;
grant execute on function public.admin_history(text, text, date, date, int, int)  to anon, authenticated;
grant execute on function public.admin_students(text, text)                       to anon, authenticated;
grant execute on function public.admin_student(text, text)                        to anon, authenticated;
grant execute on function public.admin_action(text, text, text)                   to anon, authenticated;
grant execute on function public.admin_set(text, text, text)                      to anon, authenticated;
