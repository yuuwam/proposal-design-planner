# Proposal Design Planner｜项目编辑锁稳定版

本版本用于 Cloudflare Pages + D1 免费版部署。

## 本次重点

- 同一个团队可以多人登录和查看项目。
- 同一个项目同一时间只允许一个页面/成员编辑。
- 第一个进入项目的人获得编辑权，可以编辑和保存。
- 后进入同一项目的人只能查看，前端会禁止输入、上传、删除、保存。
- 后进入者尝试输入或操作时，页面中央弹窗提示“项目正在被编辑”。
- 编辑者返回项目列表、退出项目或关闭页面时会释放项目锁。
- 异常关闭时，项目锁约 10 分钟后自动释放。
- 不同项目之间互不影响，可以分别由不同成员同时编辑。
- 后端保存接口会再次校验项目锁，没有编辑权时拒绝写入，避免前端异常导致覆盖。

## Cloudflare Pages 构建设置

Framework preset: None
Build command: npm run build
Build output directory: dist
Root directory: /

## D1 绑定

wrangler.json 里需要填写真实 D1 Database ID：

```json
"database_id": "你的真实 D1 Database ID"
```

绑定名必须保持为：

```text
DB
```

## D1 表升级

如果已经执行过项目锁 SQL，无需重复执行。如果没有，执行：

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

CREATE INDEX IF NOT EXISTS idx_project_locks_expires 
ON project_locks(expires_at);
```



## 管理员账号

内置管理员登录信息：

- 账号：Administrator@test.com
- 密码：123456

管理员权限：

- 可查看所有团队的项目，不受团队隔离限制。
- 项目列表卡片会显示项目所属团队。
- 只有管理员可以看到并编辑“AI 提示词”和“批量更新提示词”板块。
- 普通账号不显示 AI 提示词、复制提示词、一键填入提示词、批量更新提示词等入口。

管理员账号会在第一次用以上账号密码登录时自动创建，不需要手动执行 SQL 创建账号。
