-- MetaMask USDC gateway (schema version 2). Adds merchant receiving wallets, the transaction-hash binding table
-- (one on-chain transaction can back exactly one payment / refund / fee settlement), fee settlements and API logs.
-- Must stay in step with server/db.js (DOCS, UNIQUE_K) and server/db-pg.js (SCHEMA_VERSION). Same private schema and
-- row-level security without policies: only the app's direct database connection can read these tables.

create table if not exists digitalhub.merchant_wallets (id text primary key, merchant_id text, mode text, status text, k text, created_at bigint not null, doc text not null);
create index if not exists merchant_wallets_scope on digitalhub.merchant_wallets(merchant_id, mode, created_at);
create index if not exists merchant_wallets_status on digitalhub.merchant_wallets(status, created_at);
create index if not exists merchant_wallets_k on digitalhub.merchant_wallets(k);

create table if not exists digitalhub.chain_txs (id text primary key, merchant_id text, mode text, status text, k text, created_at bigint not null, doc text not null);
create index if not exists chain_txs_scope on digitalhub.chain_txs(merchant_id, mode, created_at);
create index if not exists chain_txs_status on digitalhub.chain_txs(status, created_at);
-- k = "<chainId>:<txHash>" — the unique index is the database-level replay protection
create unique index if not exists chain_txs_k on digitalhub.chain_txs(k);

create table if not exists digitalhub.settlements (id text primary key, merchant_id text, mode text, status text, k text, created_at bigint not null, doc text not null);
create index if not exists settlements_scope on digitalhub.settlements(merchant_id, mode, created_at);
create index if not exists settlements_status on digitalhub.settlements(status, created_at);
create index if not exists settlements_k on digitalhub.settlements(k);

create table if not exists digitalhub.api_logs (id text primary key, merchant_id text, mode text, status text, k text, created_at bigint not null, doc text not null);
create index if not exists api_logs_scope on digitalhub.api_logs(merchant_id, mode, created_at);
create index if not exists api_logs_status on digitalhub.api_logs(status, created_at);
create index if not exists api_logs_k on digitalhub.api_logs(k);

alter table digitalhub.merchant_wallets enable row level security;
alter table digitalhub.chain_txs enable row level security;
alter table digitalhub.settlements enable row level security;
alter table digitalhub.api_logs enable row level security;

insert into digitalhub.meta (key, value) values ('schema_version', '2') on conflict (key) do update set value = excluded.value;
