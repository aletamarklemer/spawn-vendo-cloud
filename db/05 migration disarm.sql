-- =====================================================================
--  MIGRATION: disarm_device() — instant cancel sa arming
--  Run this ONCE in Supabase → SQL Editor (spawn-vendo-cloud project RA!).
--
--  WHY: kung mag-tap ang user "Insert Coin" dayon mag-Cancel, kinahanglan
--  i-disarm DAYON ang device para dili modawat ug coin. Kung walay disarm,
--  buhi pa ang 90s arm window — modawat gihapon ug coin bisan gi-cancel.
-- =====================================================================

create or replace function public.disarm_device(
  p_device_id uuid,
  p_client_mac text default null
)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_device_id is null then
    raise exception 'device_id required';
  end if;

  -- I-delete ang arm para ani nga device. Kung gihatag ang client_mac,
  -- i-disarm LANG kung kini ang armed client (para dili ma-disarm ang lain).
  if p_client_mac is not null then
    delete from device_arms
      where device_id = p_device_id and client_mac = p_client_mac;
  else
    delete from device_arms where device_id = p_device_id;
  end if;
end; $$;