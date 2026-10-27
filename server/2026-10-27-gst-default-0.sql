-- NRRL Counter — new items without a GST rate get 0% (was 18%). Existing items keep their rate.
alter table counter.items alter column gst set default 0;
do $$
declare f text; d text;
begin
  foreach f in array array['public.counter_item_save(text,jsonb,text)', 'public.counter_dev_items_put(text,jsonb,boolean)', 'public.counter_items_import(text,jsonb)'] loop
    d := pg_get_functiondef(f::regprocedure);
    d := replace(d, '''gst'','''')::numeric,18)', '''gst'','''')::numeric,0)');
    execute d;
  end loop;
end $$;
