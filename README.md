# Proposal Design Planner｜项目级实时协作（软编辑提示，不再锁死输入）版（方案 A）

这是中性命名的 Cloudflare 免费版部署包，已从“多人同步”升级为“项目级实时协作（软编辑提示，不再锁死输入）”。

## 当前版本能力

- 登录 / 注册 / 团队码协作。
- 不同团队项目完全隔离。
- 同一团队成员打开同一个项目后，会进入同一个实时协作房间。
- A 修改文案、尺寸、场景、提示词、项目名称等内容，B 页面无需刷新即可收到更新。
- 页面显示实时协作状态和在线人数。
- 简单编辑锁：当别人正在编辑某个输入框时，当前页面会标记该输入框，避免两个人同时改同一个字段。
- 项目最终数据仍保存到 Cloudflare D1，适合长期保存。
- 图片继续压缩到 1MB 内并保存到 D1，不需要 R2，不需要绑定银行卡。

## 使用的 Cloudflare 资源

需要：

```text
Cloudflare Pages
Cloudflare D1
Cloudflare Durable Objects
```

不需要：

```text
R2
银行卡
付费版 Cloudflare
```

> Durable Objects 用来做“每个项目一个实时房间”；D1 用来保存最终项目数据、账号、团队和图片。

## Cloudflare Pages 构建设置

```text
Framework preset: None
Build command: npm run build
Build output directory: dist
Root directory: /
```

## 初始化 D1

新建 D1 数据库：

```text
proposal-design-planner-db
```

进入 D1 Console，复制 `schema.sql` 的全部内容执行一次。

执行后用：

```sql
/tables
```

应看到：

```text
users
workspaces
workspace_users
sessions
planner_states
images
```

## 重要：配置 wrangler.jsonc

本版本是 Cloudflare Pages 兼容版，只需要 D1 绑定，不需要 R2，也不需要 Durable Objects。

打开 D1 数据库的 Overview / Settings，复制真实的 Database ID，然后打开 GitHub 仓库里的 `wrangler.jsonc`，把这一行：

```jsonc
"database_id": "请替换成你的真实 D1 Database ID"
```

替换成真实 ID，例如：

```jsonc
"database_id": "12345678-abcd-1234-abcd-123456789000"
```

不要改 `binding` 名称，必须保持：

```text
DB
```

## wrangler.jsonc 应包含

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "proposal-design-planner",
  "compatibility_date": "2026-07-29",
  "pages_build_output_dir": "dist",
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "proposal-design-planner-db",
      "database_id": "这里替换成你的 D1 Database ID"
    }
  ]
}
```

## 测试接口

部署成功后打开：

```text
https://你的项目.pages.dev/api/health
```

正常应显示：

```json
{"ok":true,"service":"proposal-design-planner-api","db":true}
```

未登录状态打开：

```text
https://你的项目.pages.dev/api/me
```

应显示：

```json
{"message":"请先登录"}
```

## 实时协作测试

1. A 用户注册，不填团队码，创建新团队。
2. A 用户进入系统后复制顶部团队码。
3. B 用户注册时填写 A 的团队码。
4. A 和 B 打开同一个项目。
5. A 修改文案、尺寸、提示词。
6. B 的页面无需刷新，会自动更新。
7. 如果 A 正在编辑某个输入框，B 端同一字段会出现锁定提示。

## 注意事项

这个版本是“项目级实时协作（软编辑提示，不再锁死输入）”，不是完整飞书 / 腾讯文档级 CRDT 文档协同。

适合：

- 小团队同时整理同一个策划项目。
- 一个项目多人分工编辑不同板块。
- 别人修改后当前页面自动更新。
- 有简单编辑锁，减少互相覆盖。

暂不支持：

- 两个人同时在同一个文本框里逐字合并输入。
- 离线编辑后自动合并。
- 完整版本历史与冲突恢复。

如果后期需要完全接近飞书 / 腾讯文档，需要继续升级到字段级版本历史或 CRDT / Yjs 协同模型。


## 团队隔离增强版说明

本版本修复“不同团队看到同一批项目”的问题：

- 登录 session 会绑定明确的 workspace_id。
- 新团队第一次进入时，云端初始化为空项目库。
- 已登录云端时不再读取浏览器本地缓存作为新团队数据源，避免同一台电脑切换账号/团队时串数据。

如果使用旧 D1 数据库，请在 D1 Console 执行：

```sql
ALTER TABLE sessions ADD COLUMN workspace_id TEXT;
UPDATE sessions
SET workspace_id = (
  SELECT wu.workspace_id
  FROM workspace_users wu
  WHERE wu.user_id = sessions.user_id
  ORDER BY wu.created_at ASC
  LIMIT 1
)
WHERE workspace_id IS NULL;
```

如果之前已经发生串数据，建议备份后执行：

```sql
DELETE FROM planner_states;
```

这只清空项目内容，不删除用户和团队。


## 本版修复
- 页面左下角显示当前登录账号邮箱和团队码。
- 实时协作改为软编辑提示：其他成员正在编辑时只高亮提示，不再把输入框变成只读。
- WebSocket 实时消息会同时写入 D1，避免多人同时打开同一个项目时出现“后打开的人无法保存”的问题。
- 收到远程更新时会保留当前正在输入的字段内容，同时同步其他字段。


## 重要修复：Cloudflare Pages 构建失败

本版本已移除 `wrangler.jsonc` 中 Pages 不支持的 `migrations` 配置，也移除了同项目 Durable Object 绑定。Cloudflare Pages 的 Wrangler 配置不支持 `migrations`；如果 Pages 绑定 Durable Object，必须指定外部 Worker 的 `script_name`。因此本包改为 D1 轮询同步版，部署更简单，只需要 D1 绑定 `DB`。

如果后续要做真正 WebSocket + Durable Object，需要额外创建一个单独 Worker 来承载 Durable Object，再让 Pages 通过 `script_name` 绑定它。
