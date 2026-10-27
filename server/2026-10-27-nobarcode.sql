-- NRRL Counter — items that never get a barcode (loose items): shown as buttons on the bill screen. Additive only.
alter table counter.items add column if not exists nobarcode boolean not null default false;

create or replace function public.counter_items(p_token text) returns json
language plpgsql security definer set search_path = '' as $$
declare s counter.staff; see boolean;
begin
  s := counter.who(p_token); see := counter.can(s, 'stock');
  return coalesce((select json_agg(json_build_object('code',code,'name',name,'retail',retail,'wholesale',wholesale,'wholesale_unit',wholesale_unit,'wholesale_qty',wholesale_qty,'stock',case when see then stock end,'unit',unit,'gst',gst,'hsn',hsn,'nobarcode',nobarcode) order by name) from counter.items where not removed), '[]'::json);
end $$;

create or replace function public.counter_items_since(p_token text, p_since timestamptz) returns json
language plpgsql security definer set search_path = '' as $$
declare s counter.staff; see boolean;
begin
  s := counter.who(p_token); see := counter.can(s, 'stock');
  return json_build_object('now', now() - interval '30 seconds', 'items', coalesce((select json_agg(json_build_object(
      'code',code,'name',name,'retail',retail,'wholesale',wholesale,'wholesale_unit',wholesale_unit,'wholesale_qty',wholesale_qty,
      'stock',case when see then stock end,'unit',unit,'gst',gst,'hsn',hsn,'removed',removed,'nobarcode',nobarcode))
    from counter.items where (p_since is null and not removed) or (p_since is not null and updated_at > p_since)), '[]'::json));
end $$;

create or replace function public.counter_item_save(p_token text, p_item jsonb, p_old_code text default null) returns json
language plpgsql security definer set search_path = '' as $$
declare s counter.staff; c text := btrim(p_item->>'code'); ex boolean := false; see boolean;
begin
  s := counter.who(p_token);
  see := counter.can(s, 'stock');
  if c is null or c = '' or btrim(coalesce(p_item->>'name','')) = '' then raise exception 'MISSING_FIELDS' using errcode='P0001'; end if;
  if coalesce(nullif(p_item->>'retail','')::numeric,0) <= 0 then raise exception 'NEED_PRICE' using errcode='P0001'; end if;
  select not removed into ex from counter.items where code = c;
  ex := coalesce(ex,false);
  if ex or p_old_code is not null then perform counter.need(s, 'edit'); else perform counter.need(s, 'add'); end if;
  if p_old_code is not null and p_old_code <> c then
    if ex then raise exception 'CODE_TAKEN' using errcode='P0001'; end if;
    update counter.items set removed = true, code = code || '~old~' || extract(epoch from now())::bigint where code = c and removed;
    update counter.items set code = c where code = p_old_code;
  elsif p_old_code is null and ex then
    raise exception 'CODE_TAKEN' using errcode='P0001';
  end if;
  insert into counter.items(code,name,retail,wholesale,wholesale_unit,wholesale_qty,stock,unit,gst,hsn,nobarcode,updated_at,updated_by,removed)
  values (c, btrim(p_item->>'name'), (p_item->>'retail')::numeric, coalesce(nullif(p_item->>'wholesale','')::numeric,0),
          coalesce(p_item->>'wholesale_unit',''), coalesce(nullif(p_item->>'wholesale_qty','')::numeric,1),
          case when see then nullif(p_item->>'stock','')::numeric end, coalesce(nullif(p_item->>'unit',''),'pcs'), coalesce(nullif(p_item->>'gst','')::numeric,18),
          coalesce(p_item->>'hsn',''), coalesce((p_item->>'nobarcode')::boolean,false), now(), s.name, false)
  on conflict (code) do update set name=excluded.name, retail=excluded.retail, wholesale=excluded.wholesale,
     wholesale_unit=case when p_item ? 'wholesale_unit' then excluded.wholesale_unit else counter.items.wholesale_unit end,
     wholesale_qty=case when p_item ? 'wholesale_qty' then excluded.wholesale_qty else counter.items.wholesale_qty end,
     nobarcode=case when p_item ? 'nobarcode' then excluded.nobarcode else counter.items.nobarcode end,
     stock=case when see then excluded.stock else counter.items.stock end, unit=excluded.unit, gst=excluded.gst, hsn=excluded.hsn, updated_at=now(), updated_by=s.name, removed=false;
  return json_build_object('ok', true);
end $$;

create or replace function public.counter_dev_items_since(p_key text, p_since timestamptz) returns json
language plpgsql security definer set search_path = '' as $$
declare n timestamptz := clock_timestamp();
begin
  perform counter.dev(p_key);
  return json_build_object('now', n, 'items', coalesce((select json_agg(json_build_object('code',code,'name',name,'retail',retail,'wholesale',wholesale,
    'wholesale_unit',wholesale_unit,'wholesale_qty',wholesale_qty,'cost',cost,'min_stock',min_stock,'stock',stock,'unit',unit,'gst',gst,'hsn',hsn,'removed',removed,'nobarcode',nobarcode))
    from counter.items where code not like '%~old~%' and (p_since is null or updated_at > p_since - interval '2 seconds')), '[]'::json));
end $$;

create or replace function public.counter_dev_items_put(p_key text, p_items jsonb, p_force_stock boolean default false) returns json
language plpgsql security definer set search_path = '' as $$
declare d counter.devices; r jsonb; n int := 0;
begin
  d := counter.dev(p_key);
  for r in select * from jsonb_array_elements(p_items) loop
    if btrim(coalesce(r->>'code','')) = '' then continue; end if;
    insert into counter.items(code,name,retail,wholesale,wholesale_unit,wholesale_qty,cost,min_stock,stock,unit,gst,hsn,nobarcode,removed,updated_at,updated_by)
    values (btrim(r->>'code'), coalesce(nullif(btrim(r->>'name'),''),btrim(r->>'code')), coalesce(nullif(r->>'retail','')::numeric,0), coalesce(nullif(r->>'wholesale','')::numeric,0),
      coalesce(r->>'wholesale_unit',''), coalesce(nullif(r->>'wholesale_qty','')::numeric,1), coalesce(nullif(r->>'cost','')::numeric,0), nullif(r->>'min_stock','')::numeric,
      nullif(r->>'stock','')::numeric, coalesce(nullif(r->>'unit',''),'pcs'), coalesce(nullif(r->>'gst','')::numeric,18), coalesce(r->>'hsn',''),
      coalesce((r->>'nobarcode')::boolean,false), coalesce((r->>'removed')::boolean,false), now(), d.name)
    on conflict (code) do update set name=excluded.name, retail=excluded.retail, wholesale=excluded.wholesale, wholesale_unit=excluded.wholesale_unit,
      wholesale_qty=excluded.wholesale_qty, cost=excluded.cost, min_stock=excluded.min_stock, unit=excluded.unit, gst=excluded.gst, hsn=excluded.hsn,
      nobarcode=case when r ? 'nobarcode' then excluded.nobarcode else counter.items.nobarcode end,
      removed=excluded.removed, updated_at=now(), updated_by=d.name,
      stock = case when p_force_stock or counter.items.stock is null then excluded.stock else counter.items.stock end;
    n := n + 1;
  end loop;
  return json_build_object('ok', true, 'n', n);
end $$;
