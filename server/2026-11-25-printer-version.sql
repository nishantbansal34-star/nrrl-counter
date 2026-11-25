-- the laptop tells the phones which NRRL Billing version it runs, so a phone can say when it is too old
-- for options chosen on the phone. Additive only.
alter table counter.label_printers add column if not exists app_version text not null default '';
