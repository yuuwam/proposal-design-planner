-- 清理当前遗留的项目编辑锁，不会删除项目、账号、团队或图片。
DELETE FROM project_locks;
