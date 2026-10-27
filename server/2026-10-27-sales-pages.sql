-- NRRL Counter — Sales screen in pages: totals for the whole range on the server, bills 50 at a time. Additive only.
create index if not exists bills_time_idx on counter.bills ((coalesce(bill_time, created_at)) desc, id desc);

create or replace function public.counter_sales(p_token text, p_from timestamptz default null, p_to timestamptz default null,
  p_before_t timestamptz default null, p_before_id bigint default null, p_limit int default 50) returns json
language plpgsql security definer set search_path = '' as $$
declare s counter.staff; f timestamptz; t timestamptz; today timestamptz; lim int := least(greatest(coalesce(p_limit, 50), 1), 200); summ json := null; page json;
begin
  s := counter.who(p_token);
  perform counter.need(s, 'sales');
  today := date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata';
  f := coalesce(p_from, today);
  t := coalesce(p_to, now() + interval '1 minute');
  if not counter.can(s, 'reports') then f := greatest(f, today); end if;
  if p_before_t is null then
    select json_build_object('count', count(*), 'total', coalesce(sum(total), 0),
      'by_payment', coalesce((select json_object_agg(payment, v) from (select payment, sum(total) v from counter.bills
          where coalesce(bill_time, created_at) >= f and coalesce(bill_time, created_at) < t and deleted is not true group by payment) p), '{}'::json),
      'by_staff', coalesce((select json_object_agg(staff_name, v) from (select staff_name, sum(total) v from counter.bills
          where coalesce(bill_time, created_at) >= f and coalesce(bill_time, created_at) < t and deleted is not true group by staff_name) p), '{}'::json))
      into summ
      from counter.bills where coalesce(bill_time, created_at) >= f and coalesce(bill_time, created_at) < t and deleted is not true;
  end if;
  select coalesce(json_agg(row_to_json(x) order by x.created_at desc, x.id desc), '[]'::json) into page from (
    select id, coalesce(bill_time, created_at) created_at, staff_name, mode, payment, customer, phone, lines, subtotal, discount, total, gst, deleted as voided, source
    from counter.bills
    where coalesce(bill_time, created_at) >= f and coalesce(bill_time, created_at) < t
      and (p_before_t is null or (coalesce(bill_time, created_at), id) < (p_before_t, p_before_id))
    order by coalesce(bill_time, created_at) desc, id desc limit lim) x;
  return json_build_object('summary', summ, 'bills', page, 'more', json_array_length(page) = lim);
end $$;
