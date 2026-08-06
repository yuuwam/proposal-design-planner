-- 如果旧版本已经把同一批项目错误复制到了多个团队，可以用这些 SQL 检查和清理。

-- 1. 查看所有团队
SELECT id, name, invite_code, created_at FROM workspaces ORDER BY created_at;

-- 2. 查看哪些团队已经保存了项目状态
SELECT workspace_id, length(state_json) AS json_size, updated_at FROM planner_states ORDER BY updated_at DESC;

-- 3. 清空某一个团队的项目状态：把下面的 TEAM_ID_HERE 换成对应团队 id
-- DELETE FROM planner_states WHERE workspace_id = 'TEAM_ID_HERE';

-- 4. 如果你准备全部重新开始，清空所有团队的项目状态
-- DELETE FROM planner_states;
