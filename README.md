# Proposal Design Planner｜Cloudflare 免费版 D1 同步版（无需 R2）

这是一个中性命名版本，避免使用任何平台品牌名称。适合重新部署为内部产品视觉策划工具。

## 当前版本特点

- 中性项目名：`proposal-design-planner`
- 中性数据库名：`proposal-design-planner-db`
- 登录 / 注册 / 团队码协作
- 多人同步与长期保存
- 仅使用 Cloudflare D1，不使用 R2，不需要绑定银行卡
- 图片压缩后保存到 D1 的 `images` 表
- PBKDF2 迭代次数已调整为 100000，兼容 Cloudflare Pages Functions
- `/api/me` 未登录时正常返回 401 JSON，不会再触发 1101

## 建议重新部署名称

GitHub 仓库名建议：

```text
proposal-design-planner
```

Cloudflare Pages 项目名建议：

```text
proposal-design-planner
```

D1 数据库名建议：

```text
proposal-design-planner-db
```

网站标题：

```text
Proposal Design Planner
```

页面说明已经改为“电商主图 / 详情页策划管理”，不再出现任何平台品牌名称。

## Cloudflare Pages 构建设置

```text
Framework preset: None
Build command: npm run build
Build output directory: dist
Root directory: /
```

## 需要创建的 Cloudflare 资源

只需要创建一个 D1 数据库：

```text
proposal-design-planner-db
```

然后给 Pages 项目添加 D1 绑定：

```text
Binding type: D1 database
Variable name: DB
Database: proposal-design-planner-db
```

不要创建 R2，不要添加 `IMAGES` 绑定。

## 如果 Cloudflare 提示绑定由 wrangler.jsonc 管理

如果 Cloudflare 的 Bindings 页面提示：

```text
Bindings are being managed through wrangler.toml / wrangler.jsonc
```

请打开 GitHub 仓库里的 `wrangler.jsonc`，加入你的真实 D1 Database ID：

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
      "database_id": "这里替换成你的真实 D1 Database ID"
    }
  ]
}
```

如果可以在 Cloudflare 网页中直接添加绑定，也可以保持当前 `wrangler.jsonc` 不变，直接在网页里添加 `DB` 绑定。

## 初始化数据库

进入 D1 数据库的 Console，把 `schema.sql` 的全部内容复制进去执行一次。

如果你之前已经执行过旧版 schema，可以再执行：

```sql
ALTER TABLE images ADD COLUMN data_url TEXT;
```

如果提示 `duplicate column name: data_url`，说明已经加过，可以忽略。

## 测试接口

部署成功后先打开：

```text
https://你的项目.pages.dev/api/health
```

正常应该看到：

```json
{"ok":true,"service":"proposal-design-planner-api","db":true}
```

再打开：

```text
https://你的项目.pages.dev/api/me
```

未登录时正常应该看到：

```json
{"message":"请先登录"}
```

## 重要说明

这个版本是“多人同步”，不是实时多人同屏编辑。一个人修改后会自动保存到云端，另一个人刷新或重新进入后可以看到最新内容。

由于图片存储在 D1 中，适合小团队、轻量项目使用；如果后期图片数量很多，建议再升级到 R2 或其他对象存储。
