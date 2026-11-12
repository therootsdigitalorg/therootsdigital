-- Single-business platform (schema version 5): Authorize.Net card payments + USD settlement → USDC payout.
-- Additive only: no existing table, column or row is changed or deleted. Multi-merchant records stay as history and
-- MULTI_MERCHANT=1 restores the multi-merchant platform. Rollback: supabase/rollbacks/20261114090000_single_business.down.sql
create table if not exists digitalhub.customers (id text primary key, merchant_id text, mode text, status text, k text, created_at bigint not null, doc text not null);
create table if not exists digitalhub.usd_settlements (id text primary key, merchant_id text, mode text, status text, k text, created_at bigint not null, doc text not null);
create table if not exists digitalhub.conversions (id text primary key, merchant_id text, mode text, status text, k text, created_at bigint not null, doc text not null);
create table if not exists digitalhub.crypto_payouts (id text primary key, merchant_id text, mode text, status text, k text, created_at bigint not null, doc text not null);
create index if not exists customers_scope on digitalhub.customers(merchant_id, mode, created_at);
create index if not exists customers_status on digitalhub.customers(status, created_at);
create unique index if not exists customers_k on digitalhub.customers(k);
create index if not exists usd_settlements_scope on digitalhub.usd_settlements(merchant_id, mode, created_at);
create index if not exists usd_settlements_status on digitalhub.usd_settlements(status, created_at);
create unique index if not exists usd_settlements_k on digitalhub.usd_settlements(k);
create index if not exists conversions_scope on digitalhub.conversions(merchant_id, mode, created_at);
create index if not exists conversions_status on digitalhub.conversions(status, created_at);
create index if not exists conversions_k on digitalhub.conversions(k);
create index if not exists crypto_payouts_scope on digitalhub.crypto_payouts(merchant_id, mode, created_at);
create index if not exists crypto_payouts_status on digitalhub.crypto_payouts(status, created_at);
create index if not exists crypto_payouts_k on digitalhub.crypto_payouts(k);
alter table digitalhub.customers enable row level security;
alter table digitalhub.usd_settlements enable row level security;
alter table digitalhub.conversions enable row level security;
alter table digitalhub.crypto_payouts enable row level security;
insert into digitalhub.meta (key, value) values ('schema_version', '5') on conflict (key) do update set value = excluded.value;
