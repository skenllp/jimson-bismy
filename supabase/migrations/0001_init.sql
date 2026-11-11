-- ============================================================
-- Jimson & Bismy — invitation backend schema
-- Safe to run on a fresh Supabase project (SQL editor or `supabase db push`)
-- and on plain PostgreSQL 13+. Idempotent: re-running will not break anything.
--
-- ACCESS MODEL
--   * All three data tables have Row Level Security ENABLED with NO permissive
--     policy for the Supabase `anon` / `authenticated` roles, and all table
--     privileges are revoked from them. The public Supabase REST/GraphQL API can
--     therefore never read or write guest data.
--   * The invitation's own API (Vercel serverless functions in /api) connects
--     server-side with the database owner (DATABASE_URL) and is the ONLY path to
--     the data. It enforces validation, rate limiting and admin authorization.
-- ============================================================

-- ---------- RSVPs ----------
create table if not exists public.rsvps (
  id                  uuid primary key default gen_random_uuid(),
  guest_name          text        not null,
  phone               text        not null,           -- normalised "+<digits>", never shown publicly
  attendance_status   text        not null,
  guest_count         integer     not null default 0,
  engagement_selected boolean     not null default false,
  reception_selected  boolean     not null default false,
  message             text,
  booking_reference   text        not null,
  checkin_token_hash  text        not null,           -- SHA-256 of the QR token (the token itself is never stored)
  token_version       integer     not null default 1, -- bump to invalidate a leaked QR / confirmation link
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint rsvps_name_len      check (char_length(guest_name) between 2 and 80),
  constraint rsvps_phone_fmt     check (phone ~ '^\+[0-9]{8,15}$'),
  constraint rsvps_status_valid  check (attendance_status in ('attending','declined','cancelled')),
  constraint rsvps_count_range   check (guest_count between 0 and 10),
  constraint rsvps_message_len   check (message is null or char_length(message) <= 300),
  constraint rsvps_reference_fmt check (booking_reference ~ '^JB-[A-HJ-NP-Z2-9]{6}$'),
  constraint rsvps_consistency   check (
       (attendance_status = 'attending'
          and guest_count between 1 and 10
          and (engagement_selected or reception_selected))
    or (attendance_status = 'declined'
          and guest_count = 0 and not engagement_selected and not reception_selected)
    or  attendance_status = 'cancelled'
  )
);
create unique index if not exists rsvps_phone_key     on public.rsvps (phone);              -- no duplicate bookings
create unique index if not exists rsvps_reference_key on public.rsvps (booking_reference);
create unique index if not exists rsvps_token_key     on public.rsvps (checkin_token_hash);
create index        if not exists rsvps_status_idx    on public.rsvps (attendance_status);
create index        if not exists rsvps_created_idx   on public.rsvps (created_at desc);

create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists rsvps_set_updated_at on public.rsvps;
create trigger rsvps_set_updated_at before update on public.rsvps
  for each row execute function public.set_updated_at();

-- ---------- Check-ins (one row per guest party per event) ----------
create table if not exists public.checkins (
  id            uuid primary key default gen_random_uuid(),
  rsvp_id       uuid        not null references public.rsvps(id) on delete cascade,
  event_type    text        not null,
  guests_arrived integer    not null,
  checked_in_at timestamptz not null default now(),
  checked_in_by text        not null,
  constraint checkins_event_valid check (event_type in ('engagement','reception')),
  constraint checkins_arrived    check (guests_arrived between 0 and 20),
  constraint checkins_by_len     check (char_length(checked_in_by) between 1 and 80),
  constraint checkins_once       unique (rsvp_id, event_type)   -- scanning twice can never double-count
);
create index if not exists checkins_event_idx on public.checkins (event_type);

-- ---------- Wishes ----------
create table if not exists public.wishes (
  id           uuid primary key default gen_random_uuid(),
  guest_name   text        not null,
  message      text        not null,
  approved     boolean     not null default false,   -- moderation: hidden until approved
  is_private   boolean     not null default false,   -- privacy option: never shown publicly, even if approved
  dedupe_hash  text        not null,                 -- stops repeated-click / replayed duplicates
  created_at   timestamptz not null default now(),
  moderated_at timestamptz,
  constraint wishes_name_len check (char_length(guest_name) between 1 and 60),
  constraint wishes_msg_len  check (char_length(message) between 1 and 500)
);
create unique index if not exists wishes_dedupe_key on public.wishes (dedupe_hash);
create index        if not exists wishes_public_idx on public.wishes (created_at desc) where approved and not is_private;

-- ---------- Rate limiting (abuse protection) ----------
create table if not exists public.rate_limits (
  key          text primary key,                      -- sha256(bucket ':' client)
  window_start timestamptz not null default now(),
  hits         integer     not null default 0
);

-- ---------- Lock the tables down ----------
alter table public.rsvps       enable row level security;
alter table public.checkins    enable row level security;
alter table public.wishes      enable row level security;
alter table public.rate_limits enable row level security;

do $$
declare t text;
begin
  -- These roles exist on Supabase; on plain Postgres this block is a no-op.
  if exists (select 1 from pg_roles where rolname = 'anon')
     and exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.rsvps, public.checkins, public.wishes, public.rate_limits from anon, authenticated;
    revoke execute on function public.set_updated_at() from anon, authenticated;
    foreach t in array array['rsvps','checkins','wishes','rate_limits'] loop
      execute format('drop policy if exists "deny all direct access" on public.%I', t);
      execute format(
        'create policy "deny all direct access" on public.%I for all to anon, authenticated using (false) with check (false)', t);
    end loop;
  end if;
end $$;

comment on table public.rsvps is 'Guest reservations. Access only through the invitation API (service connection); RLS denies anon/authenticated.';
