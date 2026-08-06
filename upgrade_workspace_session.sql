-- 团队隔离增强迁移：让每个登录会话绑定一个明确的团队空间。
-- 如果提示 duplicate column name: workspace_id，说明已经执行过，可忽略。
ALTER TABLE sessions ADD COLUMN workspace_id TEXT;

-- 给旧会话补一个默认团队，避免旧登录态报错。
UPDATE sessions
SET workspace_id = (
  SELECT wu.workspace_id
  FROM workspace_users wu
  WHERE wu.user_id = sessions.user_id
  ORDER BY wu.created_at ASC
  LIMIT 1
)
WHERE workspace_id IS NULL;

-- 可选：清空之前串团队时写错的项目数据。
-- 如果你想保留现有项目，不要执行下面这句。
-- DELETE FROM planner_states;
