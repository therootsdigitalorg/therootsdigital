-- Rollback of 20261114090000_single_business.sql. NOT applied automatically.
-- 1. Take a backup first:  npm run backup   (or Super Admin → Settings → Download backup)
-- 2. Set MULTI_MERCHANT=1 so the application no longer uses these tables.
-- 3. The tables below may hold financial records (settlements, conversions, USDC payouts). Retention policy: keep them.
--    This script therefore only RENAMES them out of the way; nothing is dropped. Drop them manually only after your
--    retention period, with an explicit, reviewed migration.
alter table if exists digitalhub.customers rename to customers_archived_v5;
alter table if exists digitalhub.usd_settlements rename to usd_settlements_archived_v5;
alter table if exists digitalhub.conversions rename to conversions_archived_v5;
alter table if exists digitalhub.crypto_payouts rename to crypto_payouts_archived_v5;
insert into digitalhub.meta (key, value) values ('schema_version', '4') on conflict (key) do update set value = excluded.value;
