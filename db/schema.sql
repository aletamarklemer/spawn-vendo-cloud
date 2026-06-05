-- =====================================================================
--  Spawn Internet - Coin Vendo System
--  db/schema.sql
--  Run this in the Supabase SQL Editor (one shot). Idempotent-ish:
--  uses IF NOT EXISTS where possible. Order matters (FKs).
-- =====================================================================

-- ---------- Extensions ----------
create extension if not exists "pgcrypto";   -- gen_random_uuid()

-- ---------- ENUM types ----------
do $$ begin
  create type user_role     as enum ('admin','technician','operator');
exception when duplicate_object then null; end $$;

do $$ begin
  create type device_status as enum ('online','offline','maintenance');
exception when duplicate_object then null; end $$;

do $$ begin
  create type session_status as enum ('active','expired','paused');
exception when duplicate_object then null; end $$;

do $$ begin
  create type voucher_status as enum ('unused','used','void');
exception when duplicate_object then null; end $$;

-- =====================================================================
--  profiles  (1:1 with auth.users)
-- =====================================================================
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text,
  email       text unique,
  role        user_role not null default 'operator',
  is_active   boolean   not null default true,
  created_at  timestamptz not null default now()
);

-- =====================================================================
--  vendo_devices
-- =====================================================================
create table if not exists public.vendo_devices (
  id           uuid primary key default gen_random_uuid(),
  device_name  text not null,
  location     text,
  mac_address  text unique not null,
  vlan         integer,
  area         text,
  status       device_status not null default 'offline',
  last_online  timestamptz,
  operator_id  uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists idx_devices_status   on public.vendo_devices(status);
create index if not exists idx_devices_operator on public.vendo_devices(operator_id);

-- =====================================================================
--  settings  (pricing). Single active row pattern, but keep history.
-- =====================================================================
create table if not exists public.settings (
  id            uuid primary key default gen_random_uuid(),
  peso_rate     numeric(10,2) not null default 1,    -- pesos per unit
  minutes_rate  integer       not null default 10,   -- minutes granted per peso_rate
  is_active     boolean       not null default true,
  updated_at    timestamptz   not null default now()
);

-- =====================================================================
--  coin_transactions
-- =====================================================================
create table if not exists public.coin_transactions (
  id            uuid primary key default gen_random_uuid(),
  device_id     uuid references public.vendo_devices(id) on delete set null,
  amount        numeric(10,2) not null,        -- pesos inserted
  credits       integer not null,              -- minutes granted
  client_mac    text,                          -- customer device MAC
  txn_ref       text unique,                   -- dedupe key from firmware
  created_at    timestamptz not null default now()
);
create index if not exists idx_coin_device on public.coin_transactions(device_id);
create index if not exists idx_coin_created on public.coin_transactions(created_at);

-- =====================================================================
--  internet_sessions
-- =====================================================================
create table if not exists public.internet_sessions (
  id                 uuid primary key default gen_random_uuid(),
  client_mac         text not null,
  device_id          uuid references public.vendo_devices(id) on delete set null,
  user_id            uuid references public.profiles(id) on delete set null,
  start_time         timestamptz not null default now(),
  end_time           timestamptz,
  remaining_seconds  integer not null default 0,
  status             session_status not null default 'active',
  created_at         timestamptz not null default now()
);
create index if not exists idx_sessions_mac    on public.internet_sessions(client_mac);
create index if not exists idx_sessions_status on public.internet_sessions(status);

-- =====================================================================
--  vouchers
-- =====================================================================
create table if not exists public.vouchers (
  id          uuid primary key default gen_random_uuid(),
  code        text unique not null,
  minutes     integer not null,
  status      voucher_status not null default 'unused',
  redeemed_by text,                  -- client_mac that redeemed it
  redeemed_at timestamptz,
  created_at  timestamptz not null default now()
);

-- =====================================================================
--  collections
-- =====================================================================
create table if not exists public.collections (
  id              uuid primary key default gen_random_uuid(),
  operator_id     uuid references public.profiles(id) on delete set null,
  device_id       uuid references public.vendo_devices(id) on delete set null,
  amount          numeric(10,2) not null,
  collection_date date not null default current_date,
  notes           text,
  created_at      timestamptz not null default now()
);
create index if not exists idx_collections_operator on public.collections(operator_id);
create index if not exists idx_collections_date     on public.collections(collection_date);

-- =====================================================================
--  maintenance_requests (technician dashboard)
-- =====================================================================
create table if not exists public.maintenance_requests (
  id            uuid primary key default gen_random_uuid(),
  device_id     uuid references public.vendo_devices(id) on delete cascade,
  technician_id uuid references public.profiles(id) on delete set null,
  issue         text not null,
  resolution    text,
  status        text not null default 'pending',   -- pending|in_progress|resolved
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz
);

-- =====================================================================
--  audit_logs
-- =====================================================================
create table if not exists public.audit_logs (
  id         uuid primary key default gen_random_uuid(),
  action     text not null,
  details    jsonb,
  user_id    uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_audit_created on public.audit_logs(created_at);

-- =====================================================================
--  TRIGGER: auto-create profile row when an auth user is created
-- =====================================================================
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.email),
    coalesce((new.raw_user_meta_data->>'role')::user_role, 'operator')
  )
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =====================================================================
--  FUNCTION: add_credits  (atomic coin insert -> session top-up)
--  Called by backend via RPC. Dedupes on txn_ref. Returns the session row.
-- =====================================================================
create or replace function public.add_credits(
  p_device_id  uuid,
  p_client_mac text,
  p_amount     numeric,
  p_txn_ref    text
)
returns public.internet_sessions
language plpgsql security definer set search_path = public as $$
declare
  v_setting   public.settings%rowtype;
  v_minutes   integer;
  v_seconds   integer;
  v_session   public.internet_sessions%rowtype;
begin
  -- Dedupe: if this txn_ref already exists, return current/most-recent session.
  if p_txn_ref is not null and exists (select 1 from coin_transactions where txn_ref = p_txn_ref) then
    select * into v_session from internet_sessions
      where client_mac = p_client_mac order by created_at desc limit 1;
    return v_session;
  end if;

  select * into v_setting from settings where is_active = true order by updated_at desc limit 1;
  if not found then
    v_setting.peso_rate := 1; v_setting.minutes_rate := 10;
  end if;

  v_minutes := floor((p_amount / v_setting.peso_rate) * v_setting.minutes_rate);
  v_seconds := v_minutes * 60;

  insert into coin_transactions (device_id, amount, credits, client_mac, txn_ref)
  values (p_device_id, p_amount, v_minutes, p_client_mac, p_txn_ref);

  -- Find an active session for this MAC, else create one.
  select * into v_session from internet_sessions
    where client_mac = p_client_mac and status = 'active'
    order by created_at desc limit 1;

  if found then
    update internet_sessions
      set remaining_seconds = remaining_seconds + v_seconds,
          end_time = now() + ((remaining_seconds + v_seconds) || ' seconds')::interval
      where id = v_session.id
      returning * into v_session;
  else
    insert into internet_sessions (client_mac, device_id, remaining_seconds, status, end_time)
    values (p_client_mac, p_device_id, v_seconds, 'active', now() + (v_seconds || ' seconds')::interval)
    returning * into v_session;
  end if;

  return v_session;
end; $$;

-- =====================================================================
--  FUNCTION: redeem_voucher
-- =====================================================================
create or replace function public.redeem_voucher(
  p_code text, p_client_mac text, p_device_id uuid
)
returns public.internet_sessions
language plpgsql security definer set search_path = public as $$
declare
  v_voucher public.vouchers%rowtype;
  v_seconds integer;
  v_session public.internet_sessions%rowtype;
begin
  select * into v_voucher from vouchers where code = p_code for update;
  if not found then raise exception 'VOUCHER_NOT_FOUND'; end if;
  if v_voucher.status <> 'unused' then raise exception 'VOUCHER_ALREADY_USED'; end if;

  update vouchers set status='used', redeemed_by=p_client_mac, redeemed_at=now()
    where id = v_voucher.id;

  v_seconds := v_voucher.minutes * 60;

  select * into v_session from internet_sessions
    where client_mac = p_client_mac and status='active' order by created_at desc limit 1;
  if found then
    update internet_sessions
      set remaining_seconds = remaining_seconds + v_seconds,
          end_time = now() + ((remaining_seconds + v_seconds) || ' seconds')::interval
      where id = v_session.id returning * into v_session;
  else
    insert into internet_sessions (client_mac, device_id, remaining_seconds, status, end_time)
    values (p_client_mac, p_device_id, v_seconds, 'active', now() + (v_seconds||' seconds')::interval)
    returning * into v_session;
  end if;
  return v_session;
end; $$;

-- =====================================================================
--  FUNCTION: expire_sessions  (call from a cron / pg_cron schedule)
-- =====================================================================
create or replace function public.expire_sessions()
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  with upd as (
    update internet_sessions set status='expired'
    where status='active' and end_time is not null and end_time <= now()
    returning 1
  ) select count(*) into n from upd;
  return n;
end; $$;

-- =====================================================================
--  Seed a default settings row
-- =====================================================================
insert into public.settings (peso_rate, minutes_rate, is_active)
select 1, 10, true
where not exists (select 1 from public.settings where is_active = true);
