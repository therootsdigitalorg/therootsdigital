-- Digital Hub schema v2: Cash App Pay.
-- Adds the Cash App API call log and the local sandbox simulator store. The app also applies this
-- automatically on boot (server/db-pg.js, SCHEMA_VERSION = 2); this file keeps `supabase db push` in step.
-- No Cash App credentials are stored in the database: they live only in server environment variables.

create table if not exists digitalhub.api_logs (id text primary key, merchant_id text, mode text, status text, k text, created_at bigint not null, doc text not null);
create index if not exists api_logs_scope on digitalhub.api_logs(merchant_id, mode, created_at);
create index if not exists api_logs_status on digitalhub.api_logs(status, created_at);
create index if not exists api_logs_k on digitalhub.api_logs(k);

create table if not exists digitalhub.cashapp_sim (id text primary key, merchant_id text, mode text, status text, k text, created_at bigint not null, doc text not null);
create index if not exists cashapp_sim_scope on digitalhub.cashapp_sim(merchant_id, mode, created_at);
create index if not exists cashapp_sim_status on digitalhub.cashapp_sim(status, created_at);
create unique index if not exists cashapp_sim_k on digitalhub.cashapp_sim(k);

-- Same lockdown as every other table: RLS on with no policies, so the Supabase anon / authenticated
-- roles see nothing. Only the server's direct Postgres connection can read or write.
alter table digitalhub.api_logs enable row level security;
alter table digitalhub.cashapp_sim enable row level security;

insert into digitalhub.meta (key, value) values ('schema_version', '2') on conflict (key) do update set value = excluded.value;
