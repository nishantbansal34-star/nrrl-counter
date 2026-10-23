-- NRRL Counter — server changes from the 23 Oct 2026 audit. All additive: no data is changed or removed.
-- Apply only with the owner's approval.

-- 1. Helper functions: fixed search path (Supabase security advisor warning).
alter function counter.perms_of(counter.staff) set search_path = '';
alter function counter.can(counter.staff, text) set search_path = '';
alter function counter.need(counter.staff, text) set search_path = '';

-- 2. Phone app: only the items that changed since the last refresh (less mobile data with many items).
--    p_since null = the whole list. "now" is the server's clock, with a 30-second overlap so nothing is missed.
create or replace function public.counter_items_since(p_token text, p_since timestamptz) returns json
language plpgsql security definer set search_path = '' as $$
declare s counter.staff; see boolean;
begin
  s := counter.who(p_token); see := counter.can(s, 'stock');
  return json_build_object('now', now() - interval '30 seconds', 'items', coalesce((select json_agg(json_build_object(
      'code',code,'name',name,'retail',retail,'wholesale',wholesale,'wholesale_unit',wholesale_unit,'wholesale_qty',wholesale_qty,
      'stock',case when see then stock end,'unit',unit,'gst',gst,'hsn',hsn,'removed',removed))
    from counter.items where (p_since is null and not removed) or (p_since is not null and updated_at > p_since)), '[]'::json));
end $$;

-- 3. Laptops: learn about bills cancelled elsewhere (on the phone app or another laptop) after they were copied.
alter table counter.bills add column if not exists deleted_at timestamptz;
create or replace function counter.bills_mark_deleted() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.deleted and not coalesce(old.deleted, false) then new.deleted_at := now(); end if;
  return new;
end $$;
drop trigger if exists bills_mark_deleted on counter.bills;
create trigger bills_mark_deleted before update of deleted on counter.bills for each row execute function counter.bills_mark_deleted();

create or replace function public.counter_dev_bills_voided(p_key text, p_since timestamptz) returns json
language plpgsql security definer set search_path = '' as $$
declare d counter.devices;
begin
  d := counter.dev(p_key);
  return json_build_object('now', now() - interval '30 seconds', 'bills', coalesce((select json_agg(json_build_object('id', b.id, 'source', b.source, 'client_id', b.client_id))
    from counter.bills b where b.deleted and b.deleted_at > coalesce(p_since, now() - interval '30 days') and (b.device_id is null or b.device_id <> d.id)), '[]'::json));
end $$;
