-- =====================================================================
--  MIGRATION: is_device_armed() — para sa NodeMCU inhibit/coin-rejection
--  Run this ONCE in Supabase → SQL Editor (spawn-vendo-cloud project RA!).
--
--  WHY: ang firmware (NodeMCU) mo-check kung naay armed client sa device
--  para mahibal-an kung i-enable ba ang coin slot (inhibit wire).
--  Kung walay armed client, i-reject/iluwa ang coin (dili dawaton).
-- =====================================================================

create or replace function public.is_device_armed(
  p_device_id uuid
)
returns boolean
language sql security definer set search_path = public as $$
  select exists (
    select 1 from device_arms
    where device_id = p_device_id
      and expires_at > now()
  );
$$;