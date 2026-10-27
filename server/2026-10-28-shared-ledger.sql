-- NRRL Counter — udhaar accounts, payments, returns, suppliers and purchases shared by every laptop and the phone app.
-- Laptops send what they record (each record has a uid made on the laptop) and pull what the others recorded.
-- Additive only: new tables and functions, nothing existing is changed.
create sequence if not exists counter.ledger_seq;

create table if not exists counter.customers(
  key text primary key, name text not null default '', phone text not null default '', gstin text not null default '',
  address text not null default '', opening numeric not null default 0, note text not null default '',
  updated_at timestamptz not null default now(), seq bigint not null default 0);
create table if not exists counter.cust_alias(old_key text primary key, key text not null, seq bigint not null default 0);
create table if not exists counter.payments(
  uid text primary key, customer_key text not null, amount numeric not null, mode text not null default 'cash', note text not null default '',
  bill_ref text not null default '', at text not null, staff text not null default '', device_id uuid, cancelled boolean not null default false,
  seq bigint not null default 0);
create table if not exists counter.returns(
  uid text primary key, return_no text not null, bill_ref text not null, at text not null, refund_mode text not null,
  customer_key text not null default '', customer text not null default '', total numeric not null, gst numeric not null default 0,
  note text not null default '', staff text not null default '', lines jsonb not null default '[]', device_id uuid, seq bigint not null default 0);
create table if not exists counter.suppliers(
  key text primary key, name text not null, phone text not null default '', gstin text not null default '', address text not null default '',
  opening numeric not null default 0, seq bigint not null default 0);
create table if not exists counter.purchases(
  uid text primary key, purchase_no text not null, supplier_key text not null default '', supplier text not null default '',
  supplier_bill text not null default '', bill_date text not null default '', at text not null, items_count int not null default 0,
  total numeric not null, gst numeric not null default 0, paid numeric not null default 0, paid_mode text not null default 'cash',
  note text not null default '', staff text not null default '', lines jsonb not null default '[]', device_id uuid,
  cancelled boolean not null default false, seq bigint not null default 0);
create table if not exists counter.supplier_payments(
  uid text primary key, supplier_key text not null, amount numeric not null, mode text not null default 'cash', note text not null default '',
  at text not null, staff text not null default '', device_id uuid, cancelled boolean not null default false, seq bigint not null default 0);

alter table counter.customers enable row level security;
alter table counter.cust_alias enable row level security;
alter table counter.payments enable row level security;
alter table counter.returns enable row level security;
alter table counter.suppliers enable row level security;
alter table counter.purchases enable row level security;
alter table counter.supplier_payments enable row level security;

-- every new or changed row gets the next number, so a laptop can ask for "everything after N"
create or replace function counter.ledger_bump() returns trigger language plpgsql set search_path = '' as $$
begin new.seq := nextval('counter.ledger_seq'); return new; end $$;
do $$ declare t text; begin
  foreach t in array array['customers','cust_alias','payments','returns','suppliers','purchases','supplier_payments'] loop
    if not exists (select 1 from pg_trigger where tgname = t || '_seq' and tgrelid = ('counter.' || t)::regclass) then
      execute format('create trigger %I before insert or update on counter.%I for each row execute function counter.ledger_bump()', t || '_seq', t);
    end if;
    execute format('create index if not exists %I on counter.%I(seq)', t || '_seq_idx', t);
  end loop;
end $$;
create index if not exists payments_cust_idx on counter.payments(customer_key);
create index if not exists returns_cust_idx on counter.returns(customer_key);

-- one customer per phone number (last 10 digits), else per name — the same rule as the laptop app
create or replace function counter.cust_key(p_name text, p_phone text) returns text language sql immutable set search_path = '' as $$
  select case when length(regexp_replace(coalesce(p_phone,''), '\D', '', 'g')) >= 10 then 'p:' || right(regexp_replace(p_phone, '\D', '', 'g'), 10)
              when btrim(coalesce(p_name,'')) <> '' then 'n:' || regexp_replace(lower(btrim(p_name)), '\s+', ' ', 'g')
              else '' end $$;
create or replace function counter.cust_resolve(p_key text) returns text language sql stable set search_path = '' as $$
  select coalesce((select a.key from counter.cust_alias a where a.old_key = p_key), p_key) $$;
create or replace function counter.ist_now() returns text language sql stable set search_path = '' as $$
  select to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI:SS') $$;

/* ---------- writing ---------- */
create or replace function counter.ledger_put(p_kind text, p_d jsonb, p_device uuid, p_staff text) returns json
language plpgsql security definer set search_path = '' as $$
declare k text; ok text; n numeric;
begin
  if p_kind = 'customer' then
    k := btrim(coalesce(p_d->>'key','')); ok := btrim(coalesce(p_d->>'old_key',''));
    if k = '' then raise exception 'MISSING_FIELDS' using errcode='P0001'; end if;
    -- a laptop sending its old records for the first time must not overwrite newer details from another device
    if coalesce((p_d->>'only_new')::boolean, false) and exists (select 1 from counter.customers c where c.key = k) then return json_build_object('ok', true); end if;
    insert into counter.customers(key,name,phone,gstin,address,opening,note,updated_at)
    values (k, coalesce(p_d->>'name',''), coalesce(p_d->>'phone',''), coalesce(p_d->>'gstin',''), coalesce(p_d->>'address',''),
            coalesce(nullif(p_d->>'opening','')::numeric,0), coalesce(p_d->>'note',''), now())
    on conflict (key) do update set name=excluded.name, phone=excluded.phone, gstin=excluded.gstin, address=excluded.address,
      opening=excluded.opening, note=excluded.note, updated_at=now();
    if ok <> '' and ok <> k then
      update counter.cust_alias set key = k where key = ok;
      insert into counter.cust_alias(old_key,key) values (ok,k) on conflict (old_key) do update set key = excluded.key;
      update counter.payments set customer_key = k where customer_key = ok;
      update counter.returns set customer_key = k where customer_key = ok;
    end if;
  elsif p_kind = 'payment' then
    n := round(coalesce(nullif(p_d->>'amount','')::numeric,0),2);
    if coalesce(p_d->>'uid','') = '' or coalesce(p_d->>'customer_key','') = '' or n <= 0 then raise exception 'MISSING_FIELDS' using errcode='P0001'; end if;
    insert into counter.payments(uid,customer_key,amount,mode,note,bill_ref,at,staff,device_id,cancelled)
    values (p_d->>'uid', counter.cust_resolve(p_d->>'customer_key'), n, coalesce(p_d->>'mode','cash'), coalesce(p_d->>'note',''), coalesce(p_d->>'bill_ref',''),
            coalesce(nullif(p_d->>'at',''), counter.ist_now()), coalesce(nullif(p_d->>'staff',''), p_staff, ''), p_device, coalesce((p_d->>'cancelled')::boolean,false))
    on conflict (uid) do nothing;
  elsif p_kind = 'payment_cancel' then
    update counter.payments set cancelled = true where uid = p_d->>'uid' and not cancelled;
  elsif p_kind = 'return' then
    if coalesce(p_d->>'uid','') = '' then raise exception 'MISSING_FIELDS' using errcode='P0001'; end if;
    insert into counter.returns(uid,return_no,bill_ref,at,refund_mode,customer_key,customer,total,gst,note,staff,lines,device_id)
    values (p_d->>'uid', coalesce(p_d->>'return_no',''), coalesce(p_d->>'bill_ref',''), coalesce(nullif(p_d->>'at',''), counter.ist_now()),
            coalesce(p_d->>'refund_mode','cash'), counter.cust_resolve(coalesce(p_d->>'customer_key','')), coalesce(p_d->>'customer',''),
            coalesce(nullif(p_d->>'total','')::numeric,0), coalesce(nullif(p_d->>'gst','')::numeric,0), coalesce(p_d->>'note',''),
            coalesce(p_d->>'staff',''), coalesce(p_d->'lines','[]'::jsonb), p_device)
    on conflict (uid) do nothing;
  elsif p_kind = 'supplier' then
    k := btrim(coalesce(p_d->>'key','')); ok := btrim(coalesce(p_d->>'old_key',''));
    if k = '' then raise exception 'MISSING_FIELDS' using errcode='P0001'; end if;
    if coalesce((p_d->>'only_new')::boolean, false) and exists (select 1 from counter.suppliers c where c.key = k) then return json_build_object('ok', true); end if;
    insert into counter.suppliers(key,name,phone,gstin,address,opening)
    values (k, coalesce(p_d->>'name',''), coalesce(p_d->>'phone',''), coalesce(p_d->>'gstin',''), coalesce(p_d->>'address',''), coalesce(nullif(p_d->>'opening','')::numeric,0))
    on conflict (key) do update set name=excluded.name, phone=excluded.phone, gstin=excluded.gstin, address=excluded.address, opening=excluded.opening;
    if ok <> '' and ok <> k then
      update counter.purchases set supplier_key = k where supplier_key = ok;
      update counter.supplier_payments set supplier_key = k where supplier_key = ok;
    end if;
  elsif p_kind = 'purchase' then
    if coalesce(p_d->>'uid','') = '' then raise exception 'MISSING_FIELDS' using errcode='P0001'; end if;
    insert into counter.purchases(uid,purchase_no,supplier_key,supplier,supplier_bill,bill_date,at,items_count,total,gst,paid,paid_mode,note,staff,lines,device_id,cancelled)
    values (p_d->>'uid', coalesce(p_d->>'purchase_no',''), coalesce(p_d->>'supplier_key',''), coalesce(p_d->>'supplier',''), coalesce(p_d->>'supplier_bill',''),
            coalesce(p_d->>'bill_date',''), coalesce(nullif(p_d->>'at',''), counter.ist_now()), coalesce(nullif(p_d->>'items_count','')::int,0),
            coalesce(nullif(p_d->>'total','')::numeric,0), coalesce(nullif(p_d->>'gst','')::numeric,0), coalesce(nullif(p_d->>'paid','')::numeric,0),
            coalesce(p_d->>'paid_mode','cash'), coalesce(p_d->>'note',''), coalesce(p_d->>'staff',''), coalesce(p_d->'lines','[]'::jsonb), p_device,
            coalesce((p_d->>'cancelled')::boolean,false))
    on conflict (uid) do nothing;
  elsif p_kind = 'purchase_cancel' then
    update counter.purchases set cancelled = true where uid = p_d->>'uid' and not cancelled;
  elsif p_kind = 'spay' then
    n := round(coalesce(nullif(p_d->>'amount','')::numeric,0),2);
    if coalesce(p_d->>'uid','') = '' or coalesce(p_d->>'supplier_key','') = '' or n <= 0 then raise exception 'MISSING_FIELDS' using errcode='P0001'; end if;
    insert into counter.supplier_payments(uid,supplier_key,amount,mode,note,at,staff,device_id,cancelled)
    values (p_d->>'uid', p_d->>'supplier_key', n, coalesce(p_d->>'mode','cash'), coalesce(p_d->>'note',''), coalesce(nullif(p_d->>'at',''), counter.ist_now()),
            coalesce(p_d->>'staff',''), p_device, coalesce((p_d->>'cancelled')::boolean,false))
    on conflict (uid) do nothing;
  elsif p_kind = 'spay_cancel' then
    update counter.supplier_payments set cancelled = true where uid = p_d->>'uid' and not cancelled;
  else
    raise exception 'UNKNOWN_KIND' using errcode='P0001';
  end if;
  return json_build_object('ok', true);
end $$;

-- laptops: the device key proves the laptop
create or replace function public.counter_dev_ledger_put(p_key text, p_kind text, p_data jsonb) returns json
language plpgsql security definer set search_path = '' as $$
declare d counter.devices;
begin
  d := counter.dev(p_key);
  return counter.ledger_put(p_kind, p_data, d.id, null);
end $$;

-- everything recorded after "p_after", oldest first; laptops apply it to their own copy
create or replace function public.counter_dev_ledger_since(p_key text, p_after bigint default 0) returns json
language plpgsql security definer set search_path = '' as $$
declare a bigint := coalesce(p_after, 0);
begin
  perform counter.dev(p_key);
  return coalesce((select json_agg(x order by (x->>'seq')::bigint) from (
    select * from (
      select json_build_object('t','customer','seq',seq,'r',row_to_json(c)) x from counter.customers c where seq > a
      union all select json_build_object('t','alias','seq',seq,'r',row_to_json(c)) from counter.cust_alias c where seq > a
      union all select json_build_object('t','payment','seq',seq,'r',row_to_json(c)) from counter.payments c where seq > a
      union all select json_build_object('t','return','seq',seq,'r',row_to_json(c)) from counter.returns c where seq > a
      union all select json_build_object('t','supplier','seq',seq,'r',row_to_json(c)) from counter.suppliers c where seq > a
      union all select json_build_object('t','purchase','seq',seq,'r',row_to_json(c)) from counter.purchases c where seq > a
      union all select json_build_object('t','spay','seq',seq,'r',row_to_json(c)) from counter.supplier_payments c where seq > a
    ) u order by (x->>'seq')::bigint limit 500) q(x)), '[]'::json);
end $$;

/* ---------- udhaar for the phone app ---------- */
-- every customer with a balance: opening + udhaar bills − payments − returns to the account
create or replace function counter.udhaar_rows() returns table(key text, name text, phone text, opening numeric, billed numeric, paid numeric, returned numeric, balance numeric, last_at text)
language sql stable security definer set search_path = '' as $$
  with ub as (
    select counter.cust_resolve(counter.cust_key(b.customer, b.phone)) k, b.total, coalesce(b.bill_time, b.created_at) t, b.customer, b.phone
    from counter.bills b where b.payment = 'udhaar' and b.deleted is not true),
  keys as (select k from ub where k <> '' union select c.key from counter.customers c where c.key not in (select old_key from counter.cust_alias where key <> old_key)),
  agg as (
    select k.k,
      coalesce((select sum(total) from ub where ub.k = k.k), 0) billed,
      coalesce((select sum(amount) from counter.payments p where p.customer_key = k.k and not p.cancelled), 0) paid,
      coalesce((select sum(total) from counter.returns r where r.customer_key = k.k and r.refund_mode = 'account'), 0) returned,
      (select max(t) from ub where ub.k = k.k) last_bill,
      (select max(at) from counter.payments p where p.customer_key = k.k and not p.cancelled) last_pay
    from keys k)
  select a.k, coalesce(nullif(c.name,''), (select ub.customer from ub where ub.k = a.k order by t desc limit 1), a.k),
    coalesce(nullif(c.phone,''), (select ub.phone from ub where ub.k = a.k and ub.phone <> '' order by t desc limit 1), ''),
    coalesce(c.opening,0), a.billed, a.paid, a.returned, round(coalesce(c.opening,0) + a.billed - a.paid - a.returned, 2),
    greatest(to_char(a.last_bill at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI:SS'), a.last_pay)
  from agg a left join counter.customers c on c.key = a.k $$;

create or replace function public.counter_udhaar(p_token text) returns json
language plpgsql security definer set search_path = '' as $$
declare s counter.staff;
begin
  s := counter.who(p_token);
  perform counter.need(s, 'sales');
  return coalesce((select json_agg(row_to_json(u) order by u.balance desc, u.name) from counter.udhaar_rows() u where abs(u.balance) > 0.009 or u.opening <> 0), '[]'::json);
end $$;

-- one customer's account: what they took on udhaar, paid and returned, oldest first
create or replace function public.counter_udhaar_account(p_token text, p_key text) returns json
language plpgsql security definer set search_path = '' as $$
declare s counter.staff; k text;
begin
  s := counter.who(p_token);
  perform counter.need(s, 'sales');
  k := counter.cust_resolve(p_key);
  return json_build_object(
    'customer', (select row_to_json(u) from counter.udhaar_rows() u where u.key = k),
    'rows', coalesce((select json_agg(x order by x->>'at') from (
      select json_build_object('kind','bill','ref',b.id,'at',to_char(coalesce(b.bill_time,b.created_at) at time zone 'Asia/Kolkata','YYYY-MM-DD HH24:MI:SS'),'amount',b.total,'staff',b.staff_name) x
        from counter.bills b where b.payment='udhaar' and b.deleted is not true and counter.cust_resolve(counter.cust_key(b.customer,b.phone)) = k
      union all select json_build_object('kind','payment','ref',p.mode,'at',p.at,'amount',p.amount,'note',p.note,'staff',p.staff,'uid',p.uid)
        from counter.payments p where p.customer_key = k and not p.cancelled
      union all select json_build_object('kind','return','ref',r.return_no,'at',r.at,'amount',r.total,'note',r.bill_ref,'staff',r.staff)
        from counter.returns r where r.customer_key = k and r.refund_mode='account') q), '[]'::json));
end $$;

-- money received on the phone against a customer's udhaar
create or replace function public.counter_udhaar_pay(p_token text, p_key text, p_amount numeric, p_mode text, p_note text, p_uid text) returns json
language plpgsql security definer set search_path = '' as $$
declare s counter.staff;
begin
  s := counter.who(p_token);
  perform counter.need(s, 'bill');
  if coalesce(p_uid,'') = '' or length(p_uid) > 80 then raise exception 'MISSING_FIELDS' using errcode='P0001'; end if;
  if not exists (select 1 from counter.udhaar_rows() u where u.key = counter.cust_resolve(p_key)) then raise exception 'NO_CUSTOMER' using errcode='P0001'; end if;
  perform counter.ledger_put('payment', json_build_object('uid', p_uid, 'customer_key', p_key, 'amount', p_amount,
    'mode', case when p_mode in ('cash','upi','card','bank') then p_mode else 'cash' end, 'note', left(coalesce(p_note,''), 200))::jsonb, null, s.name);
  return public.counter_udhaar_account(p_token, p_key);
end $$;
-- bill numbers in udhaar statements as every device shows them (M12 from phones, L1-15 from laptops)
create or replace function counter.bill_ref(p_source text, p_client_id text, p_id bigint) returns text language sql immutable set search_path = '' as $$
  select case when p_source = 'pc' and p_client_id ~ '^pc-L[0-9]+-' then
    (select case when z.rest like z.code || '-%' then z.rest else z.code || '-' || z.rest end
       from (select substring(p_client_id from '^pc-(L[0-9]+)-') code, substring(p_client_id from '^pc-L[0-9]+-(.*)$') rest) z)
  else 'M' || p_id end $$;
do $$
declare d text;
begin
  d := pg_get_functiondef('public.counter_udhaar_account(text,text)'::regprocedure);
  d := replace(d, '''ref'',b.id,', '''ref'',counter.bill_ref(b.source,b.client_id,b.id),');
  execute d;
end $$;
