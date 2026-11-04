-- Digital Hub Payments schema. Private schema (not exposed by Supabase's REST API) with row-level
-- security on every table and no policies, so only the app's direct database connection can use it.
-- Must stay in step with server/db-pg.js, which creates the same schema if this migration was not run.

create schema if not exists digitalhub;

create table if not exists digitalhub.merchants (id text primary key, merchant_id text, mode text, status text, k text, created_at bigint not null, doc text not null);
create index if not exists merchants_scope on digitalhub.merchants(merchant_id, mode, created_at);
create index if not exists merchants_status on digitalhub.merchants(status, created_at);
create index if not exists merchants_k on digitalhub.merchants(k);

create table if not exists digitalhub.users (id text primary key, merchant_id text, mode text, status text, k text, created_at bigint not null, doc text not null);
create index if not exists users_scope on digitalhub.users(merchant_id, mode, created_at);
create index if not exists users_status on digitalhub.users(status, created_at);
create unique index if not exists users_k on digitalhub.users(k);

create table if not exists digitalhub.sessions (id text primary key, merchant_id text, mode text, status text, k text, created_at bigint not null, doc text not null);
create index if not exists sessions_scope on digitalhub.sessions(merchant_id, mode, created_at);
create index if not exists sessions_status on digitalhub.sessions(status, created_at);
create unique index if not exists sessions_k on digitalhub.sessions(k);

create table if not exists digitalhub.api_keys (id text primary key, merchant_id text, mode text, status text, k text, created_at bigint not null, doc text not null);
create index if not exists api_keys_scope on digitalhub.api_keys(merchant_id, mode, created_at);
create index if not exists api_keys_status on digitalhub.api_keys(status, created_at);
create unique index if not exists api_keys_k on digitalhub.api_keys(k);

create table if not exists digitalhub.checkout_sessions (id text primary key, merchant_id text, mode text, status text, k text, created_at bigint not null, doc text not null);
create index if not exists checkout_sessions_scope on digitalhub.checkout_sessions(merchant_id, mode, created_at);
create index if not exists checkout_sessions_status on digitalhub.checkout_sessions(status, created_at);
create index if not exists checkout_sessions_k on digitalhub.checkout_sessions(k);

create table if not exists digitalhub.payments (id text primary key, merchant_id text, mode text, status text, k text, created_at bigint not null, doc text not null);
create index if not exists payments_scope on digitalhub.payments(merchant_id, mode, created_at);
create index if not exists payments_status on digitalhub.payments(status, created_at);
create index if not exists payments_k on digitalhub.payments(k);

create table if not exists digitalhub.refunds (id text primary key, merchant_id text, mode text, status text, k text, created_at bigint not null, doc text not null);
create index if not exists refunds_scope on digitalhub.refunds(merchant_id, mode, created_at);
create index if not exists refunds_status on digitalhub.refunds(status, created_at);
create index if not exists refunds_k on digitalhub.refunds(k);

create table if not exists digitalhub.disputes (id text primary key, merchant_id text, mode text, status text, k text, created_at bigint not null, doc text not null);
create index if not exists disputes_scope on digitalhub.disputes(merchant_id, mode, created_at);
create index if not exists disputes_status on digitalhub.disputes(status, created_at);
create index if not exists disputes_k on digitalhub.disputes(k);

create table if not exists digitalhub.payouts (id text primary key, merchant_id text, mode text, status text, k text, created_at bigint not null, doc text not null);
create index if not exists payouts_scope on digitalhub.payouts(merchant_id, mode, created_at);
create index if not exists payouts_status on digitalhub.payouts(status, created_at);
create index if not exists payouts_k on digitalhub.payouts(k);

create table if not exists digitalhub.links (id text primary key, merchant_id text, mode text, status text, k text, created_at bigint not null, doc text not null);
create index if not exists links_scope on digitalhub.links(merchant_id, mode, created_at);
create index if not exists links_status on digitalhub.links(status, created_at);
create unique index if not exists links_k on digitalhub.links(k);

create table if not exists digitalhub.wallets (id text primary key, merchant_id text, mode text, status text, k text, created_at bigint not null, doc text not null);
create index if not exists wallets_scope on digitalhub.wallets(merchant_id, mode, created_at);
create index if not exists wallets_status on digitalhub.wallets(status, created_at);
create index if not exists wallets_k on digitalhub.wallets(k);

create table if not exists digitalhub.banks (id text primary key, merchant_id text, mode text, status text, k text, created_at bigint not null, doc text not null);
create index if not exists banks_scope on digitalhub.banks(merchant_id, mode, created_at);
create index if not exists banks_status on digitalhub.banks(status, created_at);
create index if not exists banks_k on digitalhub.banks(k);

create table if not exists digitalhub.webhook_endpoints (id text primary key, merchant_id text, mode text, status text, k text, created_at bigint not null, doc text not null);
create index if not exists webhook_endpoints_scope on digitalhub.webhook_endpoints(merchant_id, mode, created_at);
create index if not exists webhook_endpoints_status on digitalhub.webhook_endpoints(status, created_at);
create index if not exists webhook_endpoints_k on digitalhub.webhook_endpoints(k);

create table if not exists digitalhub.deliveries (id text primary key, merchant_id text, mode text, status text, k text, created_at bigint not null, doc text not null);
create index if not exists deliveries_scope on digitalhub.deliveries(merchant_id, mode, created_at);
create index if not exists deliveries_status on digitalhub.deliveries(status, created_at);
create index if not exists deliveries_k on digitalhub.deliveries(k);

create table if not exists digitalhub.events (id text primary key, merchant_id text, mode text, status text, k text, created_at bigint not null, doc text not null);
create index if not exists events_scope on digitalhub.events(merchant_id, mode, created_at);
create index if not exists events_status on digitalhub.events(status, created_at);
create index if not exists events_k on digitalhub.events(k);

create table if not exists digitalhub.provider_events (id text primary key, merchant_id text, mode text, status text, k text, created_at bigint not null, doc text not null);
create index if not exists provider_events_scope on digitalhub.provider_events(merchant_id, mode, created_at);
create index if not exists provider_events_status on digitalhub.provider_events(status, created_at);
create unique index if not exists provider_events_k on digitalhub.provider_events(k);

create table if not exists digitalhub.provider_requests (id text primary key, merchant_id text, mode text, status text, k text, created_at bigint not null, doc text not null);
create index if not exists provider_requests_scope on digitalhub.provider_requests(merchant_id, mode, created_at);
create index if not exists provider_requests_status on digitalhub.provider_requests(status, created_at);
create index if not exists provider_requests_k on digitalhub.provider_requests(k);

create table if not exists digitalhub.adjustments (id text primary key, merchant_id text, mode text, status text, k text, created_at bigint not null, doc text not null);
create index if not exists adjustments_scope on digitalhub.adjustments(merchant_id, mode, created_at);
create index if not exists adjustments_status on digitalhub.adjustments(status, created_at);
create index if not exists adjustments_k on digitalhub.adjustments(k);

create table if not exists digitalhub.alerts (id text primary key, merchant_id text, mode text, status text, k text, created_at bigint not null, doc text not null);
create index if not exists alerts_scope on digitalhub.alerts(merchant_id, mode, created_at);
create index if not exists alerts_status on digitalhub.alerts(status, created_at);
create index if not exists alerts_k on digitalhub.alerts(k);

create table if not exists digitalhub.audit (id text primary key, merchant_id text, mode text, status text, k text, created_at bigint not null, doc text not null);
create index if not exists audit_scope on digitalhub.audit(merchant_id, mode, created_at);
create index if not exists audit_status on digitalhub.audit(status, created_at);
create index if not exists audit_k on digitalhub.audit(k);

-- Append-only double-entry ledger
create table if not exists digitalhub.journals (key text primary key, mode text not null, ref text, memo text, at bigint not null);
create table if not exists digitalhub.ledger (
  id bigserial primary key,
  journal_key text not null references digitalhub.journals(key),
  mode text not null,
  account text not null,
  merchant_id text,
  currency text not null,
  amount bigint not null,
  ref text,
  at bigint not null
);
create index if not exists ledger_m on digitalhub.ledger(merchant_id, mode, account, currency);
create index if not exists ledger_ref on digitalhub.ledger(ref);
create table if not exists digitalhub.idempotency (merchant_id text not null, mode text not null, key text not null, fingerprint text not null, status integer, response text, created_at bigint not null, primary key (merchant_id, mode, key));
create table if not exists digitalhub.meta (key text primary key, value text not null);

create or replace function digitalhub.ledger_append_only() returns trigger language plpgsql as $fn$ begin raise exception 'ledger is append-only'; end $fn$;
drop trigger if exists ledger_no_change on digitalhub.ledger;
create trigger ledger_no_change before update or delete on digitalhub.ledger for each row execute function digitalhub.ledger_append_only();

alter table digitalhub.merchants enable row level security;
alter table digitalhub.users enable row level security;
alter table digitalhub.sessions enable row level security;
alter table digitalhub.api_keys enable row level security;
alter table digitalhub.checkout_sessions enable row level security;
alter table digitalhub.payments enable row level security;
alter table digitalhub.refunds enable row level security;
alter table digitalhub.disputes enable row level security;
alter table digitalhub.payouts enable row level security;
alter table digitalhub.links enable row level security;
alter table digitalhub.wallets enable row level security;
alter table digitalhub.banks enable row level security;
alter table digitalhub.webhook_endpoints enable row level security;
alter table digitalhub.deliveries enable row level security;
alter table digitalhub.events enable row level security;
alter table digitalhub.provider_events enable row level security;
alter table digitalhub.provider_requests enable row level security;
alter table digitalhub.adjustments enable row level security;
alter table digitalhub.alerts enable row level security;
alter table digitalhub.audit enable row level security;
alter table digitalhub.journals enable row level security;
alter table digitalhub.ledger enable row level security;
alter table digitalhub.idempotency enable row level security;
alter table digitalhub.meta enable row level security;

-- Tells the app the schema is ready (see SCHEMA_VERSION in server/db-pg.js)
insert into digitalhub.meta (key, value) values ('schema_version', '1') on conflict (key) do update set value = excluded.value;
