-- =====================================================================
--  MIGRATION 02: enforcement allowed-list for OpenWRT
--  Run this ONCE in Supabase -> SQL Editor (AFTER schema.sql + 01 arming).
--
--  WHY: the OpenWRT router needs to know WHICH client MACs currently have
--  paid time so it can allow them through the firewall and block the rest.
--  This function expires stale sessions first, then returns the live
--  allowed-list. The enforcement agent on the router polls an API endpoint
--  that calls this.
-- =====================================================================

-- Returns every client_mac that has an ACTIVE, non-expired session,
-- along with how many seconds remain. Expires stale rows in the same call
-- so the list is always fresh.
create or replace function public.list_allowed_clients()
returns table (
  client_mac        text,
  remaining_seconds integer,
  end_time          timestamptz,
  device_id         uuid
)
language plpgsql security definer set search_path = public as $$
begin
  -- 1) Flip any active sessions whose time has passed to 'expired'.
  update internet_sessions
     set status = 'expired'
   where status = 'active'
     and end_time is not null
     and end_time <= now();

  -- 2) Return the still-active list with live remaining seconds.
  --    DISTINCT ON keeps the newest session per MAC (in case of dupes).
  return query
    select distinct on (s.client_mac)
           s.client_mac,
           greatest(0, floor(extract(epoch from (s.end_time - now())))::integer) as remaining_seconds,
           s.end_time,
           s.device_id
      from internet_sessions s
     where s.status = 'active'
       and s.end_time is not null
       and s.end_time > now()
       and s.client_mac is not null
     order by s.client_mac, s.created_at desc;
end; $$;