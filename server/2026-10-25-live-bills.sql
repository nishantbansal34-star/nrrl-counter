-- NRRL Counter — live bills: every open bill on every phone and laptop is kept on the server so it can be
-- passed to another person, and the owner can see all of them. Additive only.
create table if not exists counter.carts(
  id text primary key, staff_id uuid not null, staff_name text not null default '', device text not null default '',
  cart jsonb not null default '{}'::jsonb, total numeric not null default 0, items int not null default 0,
  state text not null default 'open', from_name text not null default '', created_at timestamptz not null default now(), updated_at timestamptz not null default now());
alter table counter.carts enable row level security;
create index if not exists carts_staff on counter.carts(staff_id);

-- the work, shared by the phone (session token) and laptop (device key + signed-in person) versions
create or replace function counter.cart_put(s counter.staff, p_id text, p_cart jsonb, p_state text, p_device text) returns json
language plpgsql security definer set search_path = '' as $$
declare c counter.carts; tot numeric := 0; n int := 0;
begin
  if p_id is null or length(p_id) > 64 then raise exception 'MISSING_FIELDS' using errcode='P0001'; end if;
  select * into c from counter.carts where id = p_id;
  if found and c.staff_id <> s.id then return json_build_object('moved', true, 'to', c.staff_name); end if; -- passed on or taken over
  select coalesce(sum(coalesce((l->>'price')::numeric, (l->>'rate')::numeric, 0) * coalesce((l->>'qty')::numeric, 0)), 0), count(*)
    into tot, n from jsonb_array_elements(coalesce(p_cart->'lines', '[]'::jsonb)) l;
  insert into counter.carts(id, staff_id, staff_name, device, cart, total, items, state, updated_at)
  values (p_id, s.id, s.name, coalesce(p_device, ''), p_cart, round(tot - coalesce((p_cart->>'discount')::numeric, 0), 2), n, case when p_state = 'held' then 'held' else 'open' end, now())
  on conflict (id) do update set cart = excluded.cart, total = excluded.total, items = excluded.items, device = excluded.device,
    state = case when counter.carts.state = 'sent' and excluded.state = 'open' then 'open' else excluded.state end, updated_at = now();
  return json_build_object('ok', true);
end $$;

create or replace function counter.cart_close(s counter.staff, p_id text) returns json
language plpgsql security definer set search_path = '' as $$
begin
  delete from counter.carts where id = p_id and (staff_id = s.id or s.role = 'owner');
  return json_build_object('ok', true);
end $$;

create or replace function counter.cart_list(s counter.staff) returns json
language plpgsql security definer set search_path = '' as $$
begin
  return coalesce((select json_agg(json_build_object('id', id, 'staff_id', staff_id, 'staff_name', staff_name, 'device', device, 'cart', cart,
      'total', total, 'items', items, 'state', state, 'from_name', from_name, 'updated_at', updated_at, 'mine', staff_id = s.id) order by updated_at desc)
    from counter.carts where (s.role = 'owner' or staff_id = s.id) and items > 0 and updated_at > now() - interval '3 days'), '[]'::json);
end $$;

create or replace function counter.cart_transfer(s counter.staff, p_id text, p_to uuid) returns json
language plpgsql security definer set search_path = '' as $$
declare c counter.carts; t counter.staff;
begin
  perform counter.need(s, 'bill');
  select * into c from counter.carts where id = p_id for update;
  if not found then raise exception 'CART_GONE' using errcode='P0001'; end if;
  if c.staff_id <> s.id and s.role <> 'owner' then raise exception 'NO_ACCESS' using errcode='P0001'; end if;
  select * into t from counter.staff where id = p_to and active;
  if not found or not counter.can(t, 'bill') then raise exception 'CANT_BILL' using errcode='P0001'; end if;
  update counter.carts set staff_id = t.id, staff_name = t.name, state = 'sent', from_name = s.name, updated_at = now() where id = p_id;
  return json_build_object('ok', true, 'to', t.name);
end $$;

create or replace function counter.cart_take(s counter.staff, p_id text, p_device text) returns json
language plpgsql security definer set search_path = '' as $$
declare c counter.carts;
begin
  select * into c from counter.carts where id = p_id for update;
  if not found then raise exception 'CART_GONE' using errcode='P0001'; end if;
  if c.staff_id <> s.id and s.role <> 'owner' then raise exception 'NO_ACCESS' using errcode='P0001'; end if;
  update counter.carts set staff_id = s.id, staff_name = s.name, state = 'open', device = coalesce(p_device, device),
    from_name = case when c.staff_id <> s.id then c.staff_name else c.from_name end, updated_at = now() where id = p_id;
  return json_build_object('id', c.id, 'cart', c.cart, 'from', case when c.staff_id <> s.id then c.staff_name else c.from_name end);
end $$;

-- phone app (session token)
create or replace function public.counter_cart_put(p_token text, p_id text, p_cart jsonb, p_state text, p_device text) returns json
language plpgsql security definer set search_path = '' as $$ begin return counter.cart_put(counter.who(p_token), p_id, p_cart, p_state, p_device); end $$;
create or replace function public.counter_cart_close(p_token text, p_id text) returns json
language plpgsql security definer set search_path = '' as $$ begin return counter.cart_close(counter.who(p_token), p_id); end $$;
create or replace function public.counter_carts(p_token text) returns json
language plpgsql security definer set search_path = '' as $$ begin return counter.cart_list(counter.who(p_token)); end $$;
create or replace function public.counter_cart_transfer(p_token text, p_id text, p_to uuid) returns json
language plpgsql security definer set search_path = '' as $$ begin return counter.cart_transfer(counter.who(p_token), p_id, p_to); end $$;
create or replace function public.counter_cart_take(p_token text, p_id text, p_device text) returns json
language plpgsql security definer set search_path = '' as $$ begin return counter.cart_take(counter.who(p_token), p_id, p_device); end $$;

-- laptops: the device key proves the laptop; the person was already signed in on it with their PIN
create or replace function counter.dev_staff(p_key text, p_staff uuid) returns counter.staff
language plpgsql security definer set search_path = '' as $$
declare s counter.staff;
begin
  perform counter.dev(p_key);
  select * into s from counter.staff where id = p_staff and active;
  if not found then raise exception 'SESSION_EXPIRED' using errcode='P0001'; end if;
  return s;
end $$;
create or replace function public.counter_dev_cart_put(p_key text, p_staff uuid, p_id text, p_cart jsonb, p_state text, p_device text) returns json
language plpgsql security definer set search_path = '' as $$ begin return counter.cart_put(counter.dev_staff(p_key, p_staff), p_id, p_cart, p_state, p_device); end $$;
create or replace function public.counter_dev_cart_close(p_key text, p_staff uuid, p_id text) returns json
language plpgsql security definer set search_path = '' as $$ begin return counter.cart_close(counter.dev_staff(p_key, p_staff), p_id); end $$;
create or replace function public.counter_dev_carts(p_key text, p_staff uuid) returns json
language plpgsql security definer set search_path = '' as $$ begin return counter.cart_list(counter.dev_staff(p_key, p_staff)); end $$;
create or replace function public.counter_dev_cart_transfer(p_key text, p_staff uuid, p_id text, p_to uuid) returns json
language plpgsql security definer set search_path = '' as $$ begin return counter.cart_transfer(counter.dev_staff(p_key, p_staff), p_id, p_to); end $$;
create or replace function public.counter_dev_cart_take(p_key text, p_staff uuid, p_id text, p_device text) returns json
language plpgsql security definer set search_path = '' as $$ begin return counter.cart_take(counter.dev_staff(p_key, p_staff), p_id, p_device); end $$;
