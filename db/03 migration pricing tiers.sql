-- =====================================================================
--  MIGRATION: custom pricing tiers (specific price -> specific duration)
--  Run this ONCE in Supabase → SQL Editor.
--
--  WHY: replace the single linear rate (peso_rate × minutes_rate) with an
--  admin-managed table of fixed tiers, e.g.
--      ₱5  -> 20 minutes
--      ₱10 -> 1 hour
--      ₱20 -> 3 hours
--      ₱50 -> 1 day
--  Matching is EXACT: an inserted amount must equal a tier's amount.
--  BACKWARD-COMPAT: if NO active tiers exist, add_credits falls back to the
--  old linear formula so the system keeps working until tiers are set.
-- =====================================================================

-- 1) Pricing tiers table.
create table if not exists public.pricing_tiers (
  id             uuid primary key default gen_random_uuid(),
  amount         numeric(10,2) not null,             -- pesos for this tier
  duration_value integer       not null,             -- e.g. 3
  duration_unit  text          not null,             -- 'minute' | 'hour' | 'day'
  seconds        integer       not null,             -- canonical duration in seconds
  is_active      boolean       not null default true,
  sort_order     integer       not null default 0,
  created_at     timestamptz   not null default now(),
  constraint pricing_tiers_unit_chk check (duration_unit in ('minute','hour','day'))
);

-- One active tier per amount (enforces exact-match uniqueness).
create unique index if not exists uniq_pricing_active_amount
  on public.pricing_tiers(amount) where is_active = true;
create index if not exists idx_pricing_active_sort
  on public.pricing_tiers(sort_order) where is_active = true;

-- 2) Rewrite add_credits to prefer pricing tiers (exact match), with a
--    linear fallback only when there are no active tiers at all.
--    DROP first: the original function declared parameter defaults, and
--    CREATE OR REPLACE cannot remove them (Postgres error 42P13).
drop function if exists public.add_credits(uuid, text, numeric, text);

create function public.add_credits(
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
  v_has_tiers boolean;
begin
  -- Dedupe: if this txn_ref already exists, return current/most-recent session.
  if p_txn_ref is not null and exists (select 1 from coin_transactions where txn_ref = p_txn_ref) then
    select * into v_session from internet_sessions
      where client_mac = p_client_mac order by created_at desc limit 1;
    return v_session;
  end if;

  -- Resolve duration: pricing tiers (exact match) first, linear fallback only
  -- when no active tiers are configured.
  select exists(select 1 from pricing_tiers where is_active = true) into v_has_tiers;

  if v_has_tiers then
    select seconds into v_seconds from pricing_tiers
      where is_active = true and amount = p_amount limit 1;
    if v_seconds is null then
      raise exception 'NO_PRICING_TIER';   -- amount has no matching tier
    end if;
    v_minutes := round(v_seconds / 60.0);
  else
    select * into v_setting from settings where is_active = true order by updated_at desc limit 1;
    if not found then
      v_setting.peso_rate := 1; v_setting.minutes_rate := 10;
    end if;
    v_minutes := floor((p_amount / v_setting.peso_rate) * v_setting.minutes_rate);
    v_seconds := v_minutes * 60;
  end if;

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
