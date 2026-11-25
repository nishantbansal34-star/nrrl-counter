-- NRRL Counter — print labels from a phone: the phone puts a print job on the server, a laptop with a label
-- printer picks it up and prints it. Additive only.
create table if not exists counter.label_printers(
  device_id uuid primary key, name text not null default '', printer text not null default '', sizes jsonb not null default '[]',
  size_id text not null default '', accepts boolean not null default true, seen_at timestamptz not null default now());
create table if not exists counter.print_jobs(
  id bigserial primary key, created_at timestamptz not null default now(), staff_id uuid, staff_name text not null default '',
  device_id uuid not null, items jsonb not null, opts jsonb not null default '{}', labels int not null default 0,
  status text not null default 'new', error text not null default '', taken_at timestamptz, done_at timestamptz);
alter table counter.label_printers enable row level security;
alter table counter.print_jobs enable row level security;
create index if not exists print_jobs_device_new on counter.print_jobs(device_id, id) where status = 'new';

/* ---------- laptops ---------- */
-- "I am here, this is my label printer and these are my label sizes" (every half minute while the app is open)
create or replace function public.counter_dev_printer_put(p_key text, p_info jsonb) returns json
language plpgsql security definer set search_path = '' as $$
declare d counter.devices;
begin
  d := counter.dev(p_key);
  insert into counter.label_printers(device_id, name, printer, sizes, size_id, accepts, seen_at)
  values (d.id, left(coalesce(p_info->>'name', d.name, ''), 80), left(coalesce(p_info->>'printer', ''), 120),
          case when jsonb_typeof(p_info->'sizes') = 'array' then p_info->'sizes' else '[]'::jsonb end,
          left(coalesce(p_info->>'size_id', ''), 20), coalesce((p_info->>'accepts')::boolean, true), now())
  on conflict (device_id) do update set name = excluded.name, printer = excluded.printer, sizes = excluded.sizes,
    size_id = excluded.size_id, accepts = excluded.accepts, seen_at = now();
  return json_build_object('ok', true);
end $$;

-- the oldest waiting job for this laptop, marked as printing so no other copy of the app takes it
create or replace function public.counter_dev_print_take(p_key text) returns json
language plpgsql security definer set search_path = '' as $$
declare d counter.devices; j counter.print_jobs;
begin
  d := counter.dev(p_key);
  update counter.label_printers set seen_at = now() where device_id = d.id;
  select * into j from counter.print_jobs where device_id = d.id and status = 'new' order by id limit 1 for update skip locked;
  if not found then return null; end if;
  if j.created_at < now() - interval '15 minutes' then
    update counter.print_jobs set status = 'failed', error = 'The laptop was not on when this was sent.', done_at = now() where id = j.id;
    return null;
  end if;
  update counter.print_jobs set status = 'printing', taken_at = now() where id = j.id;
  return json_build_object('id', j.id, 'items', j.items, 'opts', j.opts, 'staff_name', j.staff_name);
end $$;

create or replace function public.counter_dev_print_done(p_key text, p_id bigint, p_ok boolean, p_error text, p_labels int) returns json
language plpgsql security definer set search_path = '' as $$
declare d counter.devices;
begin
  d := counter.dev(p_key);
  update counter.print_jobs set status = case when p_ok then 'done' else 'failed' end, error = left(coalesce(p_error, ''), 300),
    labels = greatest(coalesce(p_labels, 0), 0), done_at = now()
  where id = p_id and device_id = d.id and status = 'printing';
  return json_build_object('ok', true);
end $$;

/* ---------- phones ---------- */
-- laptops that can print labels right now (seen in the last 2 minutes)
create or replace function public.counter_label_printers(p_token text) returns json
language plpgsql security definer set search_path = '' as $$
declare s counter.staff;
begin
  s := counter.who(p_token);
  perform counter.need(s, 'labels');
  return coalesce((select json_agg(json_build_object('device_id', p.device_id, 'name', p.name, 'printer', p.printer, 'sizes', p.sizes, 'size_id', p.size_id) order by p.seen_at desc)
    from counter.label_printers p join counter.devices v on v.id = p.device_id
    where p.accepts and p.printer <> '' and not v.revoked and p.seen_at > now() - interval '2 minutes'), '[]'::json);
end $$;

-- p_items: [{code, count}]; p_opts: {size_id, layout, emph}
create or replace function public.counter_print_send(p_token text, p_device uuid, p_items jsonb, p_opts jsonb) returns json
language plpgsql security definer set search_path = '' as $$
declare s counter.staff; total int; jid bigint;
begin
  s := counter.who(p_token);
  perform counter.need(s, 'labels');
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 50 then raise exception 'MISSING_FIELDS' using errcode='P0001'; end if;
  select coalesce(sum(least(greatest(coalesce((x->>'count')::int, 0), 0), 1000)), 0) into total from jsonb_array_elements(p_items) x;
  if total < 1 or total > 2000 then raise exception 'TOO_MANY_LABELS' using errcode='P0001'; end if;
  if not exists (select 1 from counter.label_printers p join counter.devices v on v.id = p.device_id
                 where p.device_id = p_device and p.accepts and not v.revoked) then raise exception 'NO_PRINTER' using errcode='P0001'; end if;
  insert into counter.print_jobs(staff_id, staff_name, device_id, items, opts, labels)
  values (s.id, s.name, p_device,
          (select jsonb_agg(jsonb_build_object('code', left(x->>'code', 64), 'count', least(greatest(coalesce((x->>'count')::int, 0), 0), 1000))) from jsonb_array_elements(p_items) x),
          jsonb_build_object('size_id', left(coalesce(p_opts->>'size_id', ''), 20), 'layout', left(coalesce(p_opts->>'layout', ''), 2), 'emph', left(coalesce(p_opts->>'emph', ''), 12))
            || case when jsonb_typeof(p_opts->'retail') = 'boolean' then jsonb_build_object('retail', p_opts->'retail') else '{}'::jsonb end
            || case when jsonb_typeof(p_opts->'wholesale') = 'boolean' then jsonb_build_object('wholesale', p_opts->'wholesale') else '{}'::jsonb end
            || case when jsonb_typeof(p_opts->'rate') = 'number' then jsonb_build_object('rate', least(greatest((p_opts->>'rate')::numeric, 70), 300)) else '{}'::jsonb end,
          total)
  returning print_jobs.id into jid;
  return json_build_object('id', jid);
end $$;

create or replace function public.counter_print_status(p_token text, p_id bigint) returns json
language plpgsql security definer set search_path = '' as $$
declare s counter.staff;
begin
  s := counter.who(p_token);
  -- 'problem', not 'error': the app treats any answer with an "error" field as a failed call
  return (select json_build_object('id', j.id, 'status', j.status, 'problem', j.error, 'labels', j.labels,
      'waiting_s', extract(epoch from (now() - j.created_at))::int, 'printer', p.name)
    from counter.print_jobs j left join counter.label_printers p on p.device_id = j.device_id
    where j.id = p_id and (j.staff_id = s.id or s.role = 'owner'));
end $$;

create or replace function public.counter_print_cancel(p_token text, p_id bigint) returns json
language plpgsql security definer set search_path = '' as $$
declare s counter.staff;
begin
  s := counter.who(p_token);
  update counter.print_jobs set status = 'cancelled', done_at = now() where id = p_id and status = 'new' and (staff_id = s.id or s.role = 'owner');
  return json_build_object('ok', true);
end $$;
