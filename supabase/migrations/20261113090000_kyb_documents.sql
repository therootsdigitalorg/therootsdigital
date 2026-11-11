-- KYB / KYC documents (schema version 4). File contents are encrypted by the app (AES-256-GCM) before storage.
create table if not exists digitalhub.documents (id text primary key, merchant_id text, mode text, status text, k text, created_at bigint not null, doc text not null);
create index if not exists documents_scope on digitalhub.documents(merchant_id, mode, created_at);
create index if not exists documents_status on digitalhub.documents(status, created_at);
create index if not exists documents_k on digitalhub.documents(k);
alter table digitalhub.documents enable row level security;
insert into digitalhub.meta (key, value) values ('schema_version', '4') on conflict (key) do update set value = excluded.value;
