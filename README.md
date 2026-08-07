# Proposal Design Planner｜项目编辑锁版本

这是一个适合 Cloudflare Pages 免费版部署的多人同步版本：

- Pages 发布网站与 API。
- D1 保存账号、团队、项目、图片和编辑锁。
- 不使用 R2，不需要绑定银行卡。
- 同一个团队可以共享项目库。
- 同一个项目同一时间只允许一个窗口/成员编辑，其他人只能查看。
- 项目列表页会显示“可编辑 / 无法编辑”。

## Cloudflare Pages 构建设置

```text
Framework preset: None
Build command: npm run build
Build output directory: dist
Root directory: /
```

## wrangler.jsonc

部署前请打开 `wrangler.jsonc`，把：

```jsonc
"database_id": "请替换成你的真实 D1 Database ID"
```

替换成你自己的 D1 Database ID。

## D1 初始化

如果是新数据库，执行 `schema.sql`。

如果是在现有数据库上升级，只需要执行：

```sql
CREATE TABLE IF NOT EXISTS project_locks (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  locked_by_user_id TEXT NOT NULL,
  locked_by_email TEXT,
  locked_by_name TEXT,
  client_id TEXT NOT NULL,
  locked_at TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, project_id)
);

CREATE INDEX IF NOT EXISTS idx_project_locks_expires ON project_locks(expires_at);
```

也可以直接执行 `upgrade_project_locks.sql`。

## 编辑锁规则

- A 打开项目后获得编辑权限。
- B 打开同一个项目时，项目列表与项目页都会显示“无法编辑”。
- B 可以查看，但不能修改、上传图片、删除板块或保存。
- A 返回项目列表、退出登录、关闭页面，系统会尝试释放锁。
- 如果 A 异常关闭浏览器，锁会在约 10 分钟后自动释放。
- A 持续编辑时，系统会自动续期。
