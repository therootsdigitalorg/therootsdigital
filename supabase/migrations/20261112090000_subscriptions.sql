-- Subscriptions billed as recurring invoices (schema version 3). Same document layout, private schema and RLS as the rest.
create table if not exists digitalhub.subscriptions (id text primary key, merchant_id text, mode text, status text, k text, created_at bigint not null, doc text not null);
create index if not exists subscriptions_scope on digitalhub.subscriptions(merchant_id, mode, created_at);
create index if not exists subscriptions_status on digitalhub.subscriptions(status, created_at);
create index if not exists subscriptions_k on digitalhub.subscriptions(k);
alter table digitalhub.subscriptions enable row level security;
insert into digitalhub.meta (key, value) values ('schema_version', '3') on conflict (key) do update set value = excluded.value;
