-- =====================================================================
--  MIGRATION: device coin "arming" (claim) for per-customer billing
--  Run this ONCE in Supabase → SQL Editor.
--
--  WHY: the coin acceptor (NodeMCU) cannot know WHICH customer phone
--  dropped the coin. So the customer's phone "arms" the machine for a
--  short window when they tap "Insert Coin", and the firmware coin insert
--  is credited to whoever is currently armed on that device.
-- =====================================================================

-- 1) Track who is currently allowed to receive coins on each device.
--    One row per device (device_id is the PK), overwritten on each arm.
create table if not exists public.device_arms (
  device_id   uuid primary key references public.vendo_devices(id) on delete cascade,
  client_mac  text not null,
  armed_at    timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index if not exists idx_device_arms_expires on public.device_arms(expires_at);

-- 2) Arm a device for a client MAC (called by the captive portal).
--    Window default 90s; re-arming just extends/overwrites.
create or replace function public.arm_device(
  p_device_id uuid,
  p_client_mac text,
  p_seconds integer default 90
)
returns public.device_arms
language plpgsql security definer set search_path = public as $$
declare
  v_row public.device_arms%rowtype;
begin
  if p_device_id is null or p_client_mac is null then
    raise exception 'device_id and client_mac required';
  end if;

  insert into device_arms (device_id, client_mac, armed_at, expires_at)
  values (p_device_id, p_client_mac, now(), now() + (p_seconds || ' seconds')::interval)
  on conflict (device_id) do update
    set client_mac = excluded.client_mac,
        armed_at   = excluded.armed_at,
        expires_at = excluded.expires_at
  returning * into v_row;

  return v_row;
end; $$;

-- 3) Add credits FROM A DEVICE, resolving the client_mac from the arm.
--    Firmware only sends device_id + amount; this finds the armed client.
--    Falls back to error if nobody is armed (or arm expired).
create or replace function public.add_credits_from_device(
  p_device_id uuid,
  p_amount    numeric,
  p_txn_ref   text
)
returns public.internet_sessions
language plpgsql security definer set search_path = public as $$
declare
  v_mac     text;
  v_session public.internet_sessions%rowtype;
begin
  -- Dedupe early: if this txn_ref already processed, return the latest session
  -- for whoever was armed (best-effort), so firmware retries are harmless.
  if p_txn_ref is not null and exists (select 1 from coin_transactions where txn_ref = p_txn_ref) then
    select s.* into v_session
      from coin_transactions c
      join internet_sessions s on s.client_mac = c.client_mac
      where c.txn_ref = p_txn_ref
      order by s.created_at desc limit 1;
    return v_session;
  end if;

  -- Find the currently-armed, non-expired client for this device.
  select client_mac into v_mac
    from device_arms
    where device_id = p_device_id and expires_at > now();

  if v_mac is null then
    raise exception 'NO_ARMED_CLIENT';  -- nobody tapped "Insert Coin" recently
  end if;

  -- Reuse the existing add_credits() so pricing/session logic stays in one place.
  v_session := public.add_credits(p_device_id, v_mac, p_amount, p_txn_ref);
  return v_session;
end; $$;

-- 4) Optional housekeeping: clear expired arms (call from cron or ignore;
--    arm_device overwrites anyway, and add_credits_from_device checks expiry).
create or replace function public.clear_expired_arms()
returns void language sql security definer set search_path = public as $$
  delete from device_arms where expires_at < now() - interval '10 minutes';
$$;