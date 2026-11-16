-- NRRL Counter — label settings shared from the laptops to the phone app (layout, wholesale code prefix/multiplier). Additive only.
create table if not exists counter.app_settings(key text primary key, value text not null default '', updated_at timestamptz not null default now());
alter table counter.app_settings enable row level security;

create or replace function public.counter_dev_settings_put(p_key text, p_settings jsonb) returns json
language plpgsql security definer set search_path = '' as $$
declare k text;
begin
  perform counter.dev(p_key);
  for k in select jsonb_object_keys(p_settings) loop
    if k in ('wcode_prefix','wcode_mult','label_layout','label_style','label_shop','label_price','label_wcode','label_rate_size') then
      insert into counter.app_settings(key, value, updated_at) values (k, left(coalesce(p_settings->>k, ''), 40), now())
      on conflict (key) do update set value = excluded.value, updated_at = now();
    end if;
  end loop;
  return json_build_object('ok', true);
end $$;

create or replace function public.counter_label_settings(p_token text) returns json
language plpgsql security definer set search_path = '' as $$
begin
  perform counter.who(p_token);
  return coalesce((select json_object_agg(key, value) from counter.app_settings), '{}'::json);
end $$;
