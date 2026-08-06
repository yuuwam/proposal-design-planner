# Proposal Design Planner｜D1 轮询协作修正版

这个版本修复：

- 云端协作在线人数一直显示 1 人的问题。
- 同团队两个账号同时打开同一项目时，后打开账号保存被覆盖或不同步的问题。
- 保存前会尝试读取最新云端状态，并按项目 / 板块更新时间做合并，减少整份数据互相覆盖。
- 在线人数通过 D1 `collab_presence` 表记录同一项目内的在线成员。

## Cloudflare Pages 构建设置

```text
Framework preset: None
Build command: npm run build
Build output directory: dist
Root directory: /
```

## D1 绑定

变量名必须是：

```text
DB
```

如果使用 `wrangler.jsonc`，把里面的 `database_id` 换成你的真实 D1 Database ID。

## 旧数据库升级

如果你已经执行过旧版 schema，只需要在 D1 Console 里执行：

```sql
CREATE TABLE IF NOT EXISTS collab_presence (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT,
  user_email TEXT,
  last_seen TEXT NOT NULL,
  PRIMARY KEY (workspace_id, project_id, client_id)
);

CREATE INDEX IF NOT EXISTS idx_collab_presence_project ON collab_presence(workspace_id, project_id, last_seen);
```

也可以直接执行文件：`upgrade_collaboration_presence.sql`。

如果是新建数据库，直接执行 `schema.sql`。
