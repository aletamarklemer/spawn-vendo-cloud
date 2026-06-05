-- =====================================================================
--  Spawn Internet - Row Level Security policies
--  db/rls.sql  (run AFTER schema.sql)
--
--  Model:
--   - The backend uses the service_role key and BYPASSES RLS entirely.
--     All privileged writes go through the API, where we enforce RBAC in
--     middleware. RLS below is the second line of defence for any client
--     that talks to Supabase directly (e.g. Realtime subscriptions using
--     the anon key + a logged-in Supabase session).
--   - Helper: public.my_role() reads the caller's role from profiles.
-- =====================================================================

create or replace function public.my_role()
returns user_role language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'admin' from public.profiles where id = auth.uid()), false);
$$;

-- Enable RLS
alter table public.profiles            enable row level security;
alter table public.vendo_devices       enable row level security;
alter table public.settings            enable row level security;
alter table public.coin_transactions   enable row level security;
alter table public.internet_sessions   enable row level security;
alter table public.vouchers            enable row level security;
alter table public.collections         enable row level security;
alter table public.maintenance_requests enable row level security;
alter table public.audit_logs          enable row level security;

-- ---- profiles ----
drop policy if exists profiles_self_read on public.profiles;
create policy profiles_self_read on public.profiles
  for select using (id = auth.uid() or public.is_admin());

drop policy if exists profiles_self_update on public.profiles;
create policy profiles_self_update on public.profiles
  for update using (id = auth.uid() or public.is_admin());

drop policy if exists profiles_admin_all on public.profiles;
create policy profiles_admin_all on public.profiles
  for all using (public.is_admin()) with check (public.is_admin());

-- ---- vendo_devices ----
drop policy if exists devices_read on public.vendo_devices;
create policy devices_read on public.vendo_devices
  for select using (
    public.is_admin()
    or public.my_role() = 'technician'
    or operator_id = auth.uid()
  );

drop policy if exists devices_admin_write on public.vendo_devices;
create policy devices_admin_write on public.vendo_devices
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists devices_tech_status on public.vendo_devices;
create policy devices_tech_status on public.vendo_devices
  for update using (public.my_role() = 'technician');

-- ---- settings ----
drop policy if exists settings_read on public.settings;
create policy settings_read on public.settings for select using (auth.uid() is not null);
drop policy if exists settings_admin on public.settings;
create policy settings_admin on public.settings for all
  using (public.is_admin()) with check (public.is_admin());

-- ---- coin_transactions ----
drop policy if exists coin_read on public.coin_transactions;
create policy coin_read on public.coin_transactions
  for select using (public.is_admin() or public.my_role() in ('operator','technician'));

-- ---- internet_sessions ----
drop policy if exists sessions_read on public.internet_sessions;
create policy sessions_read on public.internet_sessions
  for select using (auth.uid() is not null);

-- ---- vouchers ----
drop policy if exists vouchers_admin on public.vouchers;
create policy vouchers_admin on public.vouchers for all
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists vouchers_read on public.vouchers;
create policy vouchers_read on public.vouchers for select using (auth.uid() is not null);

-- ---- collections ----
drop policy if exists collections_operator on public.collections;
create policy collections_operator on public.collections
  for select using (public.is_admin() or operator_id = auth.uid());
drop policy if exists collections_operator_insert on public.collections;
create policy collections_operator_insert on public.collections
  for insert with check (operator_id = auth.uid() or public.is_admin());

-- ---- maintenance_requests ----
drop policy if exists maint_read on public.maintenance_requests;
create policy maint_read on public.maintenance_requests
  for select using (public.is_admin() or public.my_role() = 'technician');
drop policy if exists maint_tech_write on public.maintenance_requests;
create policy maint_tech_write on public.maintenance_requests
  for all using (public.is_admin() or public.my_role() = 'technician')
  with check (public.is_admin() or public.my_role() = 'technician');

-- ---- audit_logs ----
drop policy if exists audit_admin on public.audit_logs;
create policy audit_admin on public.audit_logs for select using (public.is_admin());
