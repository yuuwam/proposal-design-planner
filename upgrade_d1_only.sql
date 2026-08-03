-- 如果你已经执行过旧版 schema.sql，再执行这一句即可。
-- 如果执行时报 duplicate column name: data_url，说明已经加过，可以忽略。
ALTER TABLE images ADD COLUMN data_url TEXT;
