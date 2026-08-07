# Proposal Design Planner

Cloudflare Pages + D1 版本。支持登录、团队隔离、项目编辑锁、竞品链接、图片保存、管理员查看全部团队项目。

## 本版权限规则

- 管理员账号：`Administrator@test.com`
- 管理员密码：`123456`
- 管理员可以查看所有团队项目。
- 普通团队成员可以编辑项目普通内容：项目名称、项目总策划、竞品链接、产品图片、参考图、图片素材、文案、场景描述、尺寸要求、板块增删等。
- 只有管理员可以看到和编辑：AI 提示词、批量更新提示词、复制提示词、一键填入提示词。
- 同一个项目同一时间只允许一个窗口/成员编辑；其他人只能查看。
- 如果项目当前没有被其他人锁定，普通成员保存时会自动获得编辑权，不会再误报“未获得编辑权限”。

## Cloudflare Pages 构建设置

- Framework preset: None
- Build command: `npm run build`
- Build output directory: `dist`
- Root directory: `/`

## D1

需要绑定 D1，变量名必须为：`DB`。

如果尚未初始化数据库，请执行 `schema.sql`。如果已有旧数据库且缺少项目锁表，请执行 `upgrade_project_locks.sql`。

## 重要

上传 GitHub 后，请确认 `wrangler.json` 里的 `database_id` 已替换成真实 D1 Database ID。
