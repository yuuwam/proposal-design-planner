
export class ProjectRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.clients = new Map();
  }

  async fetch(request) {
    const upgrade = request.headers.get('Upgrade') || '';
    if (upgrade.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const clientId = request.headers.get('x-client-id') || randomHex(8);
    const userId = request.headers.get('x-user-id') || '';
    const userName = request.headers.get('x-user-name') || '团队成员';
    const userEmail = request.headers.get('x-user-email') || '';
    const workspaceId = request.headers.get('x-workspace-id') || '';
    const projectId = request.headers.get('x-project-id') || '';
    this.clients.set(clientId, {
      clientId, userId, userName, userEmail, workspaceId, projectId,
      editing: null, joinedAt: Date.now(), lastSeen: Date.now(), ws: server
    });

    this.send(server, { type: 'welcome', clientId, users: this.users(), serverTime: new Date().toISOString() });
    this.broadcast({ type: 'presence', users: this.users(), serverTime: new Date().toISOString() }, clientId);

    server.addEventListener('message', event => { this.onMessage(clientId, event.data).catch(err => this.send(server, { type: 'error', message: err?.message || '实时同步保存失败' })); });
    server.addEventListener('close', () => this.close(clientId));
    server.addEventListener('error', () => this.close(clientId));
    return new Response(null, { status: 101, webSocket: client });
  }

  async onMessage(clientId, raw) {
    const client = this.clients.get(clientId);
    if (!client) return;
    client.lastSeen = Date.now();
    let msg = null;
    try { msg = JSON.parse(String(raw || '{}')); } catch { return; }
    const now = new Date().toISOString();
    if (msg.type === 'ping') {
      this.send(client.ws, { type: 'pong', serverTime: now });
      return;
    }
    if (msg.type === 'editing:start') {
      client.editing = {
        fieldKey: String(msg.fieldKey || ''),
        label: String(msg.label || '正在编辑'),
        updatedAt: now
      };
      this.broadcast({ type: 'presence', users: this.users(), serverTime: now });
      return;
    }
    if (msg.type === 'editing:end') {
      client.editing = null;
      this.broadcast({ type: 'presence', users: this.users(), serverTime: now });
      return;
    }
    if (msg.type === 'state:update' && msg.state && typeof msg.state === 'object') {
      await this.persistState(client, msg.state, msg.updatedAt || now);
      this.broadcast({
        type: 'state:update',
        state: msg.state,
        updatedAt: msg.updatedAt || now,
        from: this.publicClient(client)
      }, clientId);
      this.send(client.ws, { type: 'state:saved', updatedAt: msg.updatedAt || now });
      return;
    }
  }

  close(clientId) {
    if (this.clients.delete(clientId)) {
      this.broadcast({ type: 'presence', users: this.users(), serverTime: new Date().toISOString() });
    }
  }

  send(ws, data) {
    try { ws.send(JSON.stringify(data)); } catch {}
  }

  broadcast(data, exceptClientId = '') {
    for (const [clientId, client] of this.clients) {
      if (exceptClientId && clientId === exceptClientId) continue;
      this.send(client.ws, data);
    }
  }

  publicClient(client) {
    return {
      clientId: client.clientId,
      userId: client.userId,
      userName: client.userName,
      userEmail: client.userEmail,
      editing: client.editing,
      joinedAt: client.joinedAt,
      lastSeen: client.lastSeen
    };
  }

  async persistState(client, state, updatedAt) {
    if (!this.env.DB || !client.workspaceId || !state || typeof state !== 'object') return;
    const stateJson = JSON.stringify(state);
    await this.env.DB.prepare(`INSERT INTO planner_states (workspace_id,state_json,updated_at,updated_by) VALUES (?,?,?,?)
      ON CONFLICT(workspace_id) DO UPDATE SET state_json=excluded.state_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
      .bind(client.workspaceId, stateJson, updatedAt || new Date().toISOString(), client.userId || null).run();
  }


  users() {
    return [...this.clients.values()].map(client => this.publicClient(client));
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return handleApi({ request, env, ctx });
    return env.ASSETS.fetch(request);
  }
};

const COOKIE_NAME = 'pdp_session';
const SESSION_DAYS = 30;
const ITERATIONS = 100000;

async function handleApi(context) {
  const { request, env } = context;
  try {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/?/, '');
    if (!env.DB) return json({ message: 'D1 binding DB 未配置' }, 500);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
    if (path === 'health') return json({ ok: true, service: 'proposal-design-planner-api', db: !!env.DB });
    if (path === 'auth/register' && request.method === 'POST') return await register(request, env);
    if (path === 'auth/login' && request.method === 'POST') return await login(request, env);
    if (path === 'auth/logout' && request.method === 'POST') return await logout(request, env);
    if (path === 'me' && request.method === 'GET') return await me(request, env);

    const session = await requireSession(request, env);
    if (path === 'realtime') return await realtime(request, env, session, url);
    if (path === 'state' && request.method === 'GET') return await getState(env, session);
    if (path === 'state' && request.method === 'PUT') return await putState(request, env, session);
    if (path === 'presence' && request.method === 'POST') return await updatePresence(request, env, session);
    if (path === 'project-locks' && request.method === 'GET') return await listProjectLocks(env, session, url);
    if (path === 'project-locks/acquire' && request.method === 'POST') return await acquireProjectLock(request, env, session);
    if (path === 'project-locks/heartbeat' && request.method === 'POST') return await heartbeatProjectLock(request, env, session);
    if (path === 'project-locks/release' && request.method === 'POST') return await releaseProjectLock(request, env, session);
    if (path === 'workspace/join' && request.method === 'POST') return await joinWorkspace(request, env, session);
    if (path === 'images' && request.method === 'POST') return await uploadImage(request, env, session);
    if (path === 'images' && request.method === 'GET') return await getImage(request, env, session, url.searchParams.get('key'));
    if (path === 'images' && request.method === 'DELETE') return await deleteImage(request, env, session, url.searchParams.get('key'));

    return json({ message: '接口不存在' }, 404);
  } catch (err) {
    console.error(err);
    return json({ message: err.message || '服务器错误' }, err.status || 500);
  }
}

async function register(request, env) {
  const body = await readJson(request);
  const name = clean(body.name) || '新用户';
  const email = clean(body.email).toLowerCase();
  const password = String(body.password || '');
  const inviteCode = clean(body.inviteCode).toUpperCase();
  if (!email || !email.includes('@')) return json({ message: '请填写有效邮箱' }, 400);
  if (password.length < 6) return json({ message: '密码至少 6 位' }, 400);

  const exists = await env.DB.prepare('SELECT id FROM users WHERE lower(email)=lower(?)').bind(email).first();
  if (exists) return json({ message: '这个邮箱已经注册，请直接登录' }, 409);

  let workspace = null;
  if (inviteCode) {
    workspace = await env.DB.prepare('SELECT * FROM workspaces WHERE invite_code=?').bind(inviteCode).first();
    if (!workspace) return json({ message: '团队码不存在，请检查后重试' }, 404);
  }
  const userId = id('usr');
  const salt = randomHex(16);
  const hash = await hashPassword(password, salt);
  const now = new Date().toISOString();
  await env.DB.prepare('INSERT INTO users (id,name,email,password_salt,password_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .bind(userId, name, email, salt, hash, now, now).run();

  if (!workspace) {
    workspace = { id: id('wsp'), name: `${name}的团队`, invite_code: makeInviteCode(), created_at: now, updated_at: now };
    await env.DB.prepare('INSERT INTO workspaces (id,name,invite_code,created_at,updated_at) VALUES (?,?,?,?,?)')
      .bind(workspace.id, workspace.name, workspace.invite_code, now, now).run();
  }
  await env.DB.prepare('INSERT OR IGNORE INTO workspace_users (workspace_id,user_id,role,created_at) VALUES (?,?,?,?)')
    .bind(workspace.id, userId, inviteCode ? 'member' : 'owner', now).run();

  // 关键：注册后会话必须绑定当前 workspace，避免同一账号或浏览器串到其他团队。
  // 新团队创建后立即写入一份空项目库，不能从浏览器缓存复制旧项目。
  await ensureEmptyPlannerState(env, workspace.id, userId);
  const session = await createSession(env, userId, workspace.id);
  return json({ user: publicUser({ id: userId, name, email }), workspace: publicWorkspace(workspace) }, 200, sessionCookie(session.token));
}

async function login(request, env) {
  const body = await readJson(request);
  const email = clean(body.email).toLowerCase();
  const password = String(body.password || '');
  const user = await env.DB.prepare('SELECT * FROM users WHERE lower(email)=lower(?)').bind(email).first();
  if (!user) return json({ message: '邮箱或密码不正确' }, 401);
  const ok = await verifyPassword(password, user.password_salt, user.password_hash);
  if (!ok) return json({ message: '邮箱或密码不正确' }, 401);
  const workspace = await firstWorkspace(env, user.id);
  if (!workspace) return json({ message: '当前账号没有团队空间' }, 403);
  const session = await createSession(env, user.id, workspace.id);
  return json({ user: publicUser(user), workspace: publicWorkspace(workspace) }, 200, sessionCookie(session.token));
}

async function logout(request, env) {
  const token = readCookie(request, COOKIE_NAME);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha256Hex(token)).run();
  return json({ ok: true }, 200, `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`);
}

async function me(request, env) {
  const session = await requireSession(request, env);
  return json({ user: publicUser(session.user), workspace: publicWorkspace(session.workspace) });
}

async function realtime(request, env, session, url) {
  const upgrade = request.headers.get('Upgrade') || '';
  if (upgrade.toLowerCase() !== 'websocket') return json({ message: '需要 WebSocket 连接' }, 426);
  if (!env.PROJECT_ROOM) return json({ message: 'Durable Object binding PROJECT_ROOM 未配置' }, 500);
  const projectId = clean(url.searchParams.get('projectId'));
  const clientId = clean(url.searchParams.get('clientId')) || randomHex(8);
  if (!projectId) return json({ message: '缺少 projectId' }, 400);
  const roomId = env.PROJECT_ROOM.idFromName(`${session.workspace.id}:${projectId}`);
  const room = env.PROJECT_ROOM.get(roomId);
  const headers = new Headers(request.headers);
  headers.set('x-client-id', clientId);
  headers.set('x-user-id', session.user.id);
  headers.set('x-user-name', encodeHeader(session.user.name || '团队成员'));
  headers.set('x-user-email', encodeHeader(session.user.email || ''));
  headers.set('x-workspace-id', session.workspace.id);
  headers.set('x-project-id', projectId);
  return room.fetch(new Request(request.url, { method: request.method, headers }));
}

function encodeHeader(value) {
  return String(value || '').replace(/[\r\n]/g, ' ').slice(0, 160);
}


async function ensurePresenceTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS collab_presence (
    workspace_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    user_name TEXT,
    user_email TEXT,
    last_seen TEXT NOT NULL,
    PRIMARY KEY (workspace_id, project_id, client_id)
  )`).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_collab_presence_project ON collab_presence(workspace_id,project_id,last_seen)').run();
}

async function updatePresence(request, env, session) {
  const body = await readJson(request);
  const projectId = clean(body.projectId);
  const clientId = clean(body.clientId) || randomHex(8);
  if (!projectId) return json({ message: '缺少 projectId' }, 400);
  const now = new Date().toISOString();
  const stale = new Date(Date.now() - 22000).toISOString();
  async function writePresence() {
    await env.DB.prepare(`INSERT INTO collab_presence (workspace_id,project_id,client_id,user_id,user_name,user_email,last_seen)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(workspace_id,project_id,client_id) DO UPDATE SET user_id=excluded.user_id,user_name=excluded.user_name,user_email=excluded.user_email,last_seen=excluded.last_seen`)
      .bind(session.workspace.id, projectId, clientId, session.user.id, session.user.name || '', session.user.email || '', now).run();
    await env.DB.prepare('DELETE FROM collab_presence WHERE last_seen<?').bind(stale).run();
  }
  try {
    await writePresence();
  } catch (err) {
    if (String(err.message || '').includes('no such table') || String(err.message || '').includes('collab_presence')) {
      await ensurePresenceTable(env);
      await writePresence();
    } else {
      throw err;
    }
  }
  const rows = await env.DB.prepare(`SELECT client_id,user_id,user_name,user_email,last_seen FROM collab_presence
    WHERE workspace_id=? AND project_id=? AND last_seen>=? ORDER BY last_seen DESC`)
    .bind(session.workspace.id, projectId, stale).all();
  const users = (rows.results || []).map(row => ({
    clientId: row.client_id,
    userId: row.user_id,
    userName: row.user_name,
    userEmail: row.user_email,
    lastSeen: row.last_seen
  }));
  return json({ ok: true, users, serverTime: now });
}

const PROJECT_LOCK_TTL_MS = 10 * 60 * 1000;

async function ensureProjectLocksTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS project_locks (
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
  )`).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_project_locks_expires ON project_locks(expires_at)').run();
}

async function cleanupExpiredProjectLocks(env) {
  await ensureProjectLocksTable(env);
  await env.DB.prepare('DELETE FROM project_locks WHERE expires_at<=?').bind(new Date().toISOString()).run();
}

function publicLock(row, clientId) {
  if (!row) return null;
  const active = new Date(String(row.expires_at || '')).getTime() > Date.now();
  const canEdit = !active || String(row.client_id || '') === String(clientId || '');
  return {
    projectId: row.project_id,
    canEdit,
    lockedByUserId: row.locked_by_user_id,
    lockedByEmail: row.locked_by_email,
    lockedByName: row.locked_by_name,
    clientId: row.client_id,
    lockedAt: row.locked_at,
    lastSeen: row.last_seen,
    expiresAt: row.expires_at
  };
}

async function listProjectLocks(env, session, url) {
  const clientId = clean(url.searchParams.get('clientId'));
  await cleanupExpiredProjectLocks(env);
  const rows = await env.DB.prepare('SELECT * FROM project_locks WHERE workspace_id=?').bind(session.workspace.id).all();
  const locks = {};
  for (const row of rows.results || []) locks[row.project_id] = publicLock(row, clientId);
  return json({ ok: true, locks, serverTime: new Date().toISOString() });
}

async function acquireProjectLock(request, env, session) {
  const body = await readJson(request);
  const projectId = clean(body.projectId);
  const clientId = clean(body.clientId);
  if (!projectId || !clientId) return json({ message: '缺少 projectId 或 clientId' }, 400);
  await cleanupExpiredProjectLocks(env);
  const existing = await env.DB.prepare('SELECT * FROM project_locks WHERE workspace_id=? AND project_id=?')
    .bind(session.workspace.id, projectId).first();
  if (existing && String(existing.client_id || '') !== clientId && new Date(existing.expires_at).getTime() > Date.now()) {
    return json({ ok: false, canEdit: false, lock: publicLock(existing, clientId), message: '当前项目正在被其他窗口或成员编辑' });
  }
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + PROJECT_LOCK_TTL_MS).toISOString();
  await env.DB.prepare(`INSERT INTO project_locks (workspace_id,project_id,locked_by_user_id,locked_by_email,locked_by_name,client_id,locked_at,last_seen,expires_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(workspace_id,project_id) DO UPDATE SET locked_by_user_id=excluded.locked_by_user_id,locked_by_email=excluded.locked_by_email,locked_by_name=excluded.locked_by_name,client_id=excluded.client_id,last_seen=excluded.last_seen,expires_at=excluded.expires_at`)
    .bind(session.workspace.id, projectId, session.user.id, session.user.email || '', session.user.name || '', clientId, existing?.locked_at || now, now, expiresAt).run();
  const row = await env.DB.prepare('SELECT * FROM project_locks WHERE workspace_id=? AND project_id=?').bind(session.workspace.id, projectId).first();
  return json({ ok: true, canEdit: true, lock: publicLock(row, clientId) });
}

async function heartbeatProjectLock(request, env, session) {
  const body = await readJson(request);
  const projectId = clean(body.projectId);
  const clientId = clean(body.clientId);
  if (!projectId || !clientId) return json({ message: '缺少 projectId 或 clientId' }, 400);
  await cleanupExpiredProjectLocks(env);
  const row = await env.DB.prepare('SELECT * FROM project_locks WHERE workspace_id=? AND project_id=?')
    .bind(session.workspace.id, projectId).first();
  if (!row) return json({ ok: false, canEdit: false, message: '项目编辑锁不存在' });
  if (String(row.client_id || '') !== clientId) return json({ ok: false, canEdit: false, lock: publicLock(row, clientId), message: '当前项目正在被其他窗口或成员编辑' });
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + PROJECT_LOCK_TTL_MS).toISOString();
  await env.DB.prepare('UPDATE project_locks SET last_seen=?,expires_at=? WHERE workspace_id=? AND project_id=? AND client_id=?')
    .bind(now, expiresAt, session.workspace.id, projectId, clientId).run();
  const updated = await env.DB.prepare('SELECT * FROM project_locks WHERE workspace_id=? AND project_id=?').bind(session.workspace.id, projectId).first();
  return json({ ok: true, canEdit: true, lock: publicLock(updated, clientId) });
}

async function releaseProjectLock(request, env, session) {
  const body = await readJson(request);
  const projectId = clean(body.projectId);
  const clientId = clean(body.clientId);
  if (!projectId || !clientId) return json({ ok: true });
  await ensureProjectLocksTable(env);
  await env.DB.prepare('DELETE FROM project_locks WHERE workspace_id=? AND project_id=? AND client_id=?')
    .bind(session.workspace.id, projectId, clientId).run();
  return json({ ok: true });
}

async function assertProjectEditable(env, session, projectId, clientId) {
  if (!projectId) return;
  await cleanupExpiredProjectLocks(env);
  const row = await env.DB.prepare('SELECT * FROM project_locks WHERE workspace_id=? AND project_id=?')
    .bind(session.workspace.id, projectId).first();
  if (!row) return;
  if (String(row.client_id || '') !== String(clientId || '') && new Date(row.expires_at).getTime() > Date.now()) {
    const err = new Error('当前项目正在被其他窗口或成员编辑，无法保存');
    err.status = 423;
    throw err;
  }
}

async function getState(env, session) {
  const row = await env.DB.prepare('SELECT state_json,updated_at,updated_by FROM planner_states WHERE workspace_id=?')
    .bind(session.workspace.id).first();
  return json({ state: row?.state_json ? JSON.parse(row.state_json) : null, updatedAt: row?.updated_at || null, updatedBy: row?.updated_by || null });
}

async function putState(request, env, session) {
  const body = await readJson(request);
  if (!body.state || typeof body.state !== 'object') return json({ message: '缺少 state 数据' }, 400);
  await assertProjectEditable(env, session, clean(body.projectId), clean(body.clientId));
  const stateJson = JSON.stringify(body.state);
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO planner_states (workspace_id,state_json,updated_at,updated_by) VALUES (?,?,?,?)
    ON CONFLICT(workspace_id) DO UPDATE SET state_json=excluded.state_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
    .bind(session.workspace.id, stateJson, now, session.user.id).run();
  return json({ ok: true, updatedAt: now, updatedBy: session.user.id });
}

async function ensureEmptyPlannerState(env, workspaceId, userId) {
  const now = new Date().toISOString();
  const empty = JSON.stringify({ version: 7, view: 'projects', selectedProjectId: '', activeTab: 'main', projects: [] });
  await env.DB.prepare(`INSERT OR IGNORE INTO planner_states (workspace_id,state_json,updated_at,updated_by) VALUES (?,?,?,?)`)
    .bind(workspaceId, empty, now, userId || null).run();
}

async function joinWorkspace(request, env, session) {
  const body = await readJson(request);
  const inviteCode = clean(body.inviteCode).toUpperCase();
  const workspace = await env.DB.prepare('SELECT * FROM workspaces WHERE invite_code=?').bind(inviteCode).first();
  if (!workspace) return json({ message: '团队码不存在' }, 404);
  await env.DB.prepare('INSERT OR IGNORE INTO workspace_users (workspace_id,user_id,role,created_at) VALUES (?,?,?,?)')
    .bind(workspace.id, session.user.id, 'member', new Date().toISOString()).run();
  await ensureEmptyPlannerState(env, workspace.id, session.user.id);
  // 加入团队后直接切换当前会话到目标团队，避免仍读取原团队。
  const newSession = await createSession(env, session.user.id, workspace.id);
  return json({ ok: true, workspace: publicWorkspace(workspace) }, 200, sessionCookie(newSession.token));
}

async function uploadImage(request, env, session) {
  const body = await readJson(request);
  const name = clean(body.name) || 'image';
  const dataUrl = String(body.dataUrl || '');
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return json({ message: '图片格式不正确' }, 400);
  const contentType = match[1];
  const bytes = base64ToBytes(match[2]);
  // D1 单行最大约 2MB；前端会先压缩到 1MB 内，base64 后仍可放入一行。
  if (bytes.byteLength > 1024 * 1024) return json({ message: '图片太大，请压缩到 1MB 以内' }, 413);
  const imageId = id('img');
  const now = new Date().toISOString();
  const insert = () => env.DB.prepare('INSERT INTO images (id,workspace_id,object_key,name,content_type,bytes,created_by,created_at,data_url) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(imageId, session.workspace.id, imageId, name, contentType, bytes.byteLength, session.user.id, now, dataUrl).run();
  try {
    await insert();
  } catch (err) {
    // 兼容已经执行过旧版 schema 的数据库：第一次上传图片时自动补 data_url 字段。
    if (String(err.message || '').includes('data_url')) {
      await env.DB.prepare('ALTER TABLE images ADD COLUMN data_url TEXT').run();
      await insert();
    } else {
      throw err;
    }
  }
  return json({ key: imageId, url: `/api/images?key=${encodeURIComponent(imageId)}`, bytes: bytes.byteLength, contentType, storedIn: 'd1' });
}

async function getImage(request, env, session, key) {
  key = String(key || '');
  if (!key) return json({ message: '缺少图片 key' }, 400);
  const row = await env.DB.prepare('SELECT data_url,content_type FROM images WHERE workspace_id=? AND object_key=?')
    .bind(session.workspace.id, key).first();
  if (!row || !row.data_url) return json({ message: '图片不存在' }, 404);
  const match = String(row.data_url).match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return json({ message: '图片数据损坏' }, 500);
  const bytes = base64ToBytes(match[2]);
  return new Response(bytes, {
    headers: {
      'Content-Type': row.content_type || match[1],
      'Cache-Control': 'private, max-age=86400'
    }
  });
}

async function deleteImage(request, env, session, key) {
  key = String(key || '');
  if (!key) return json({ message: '缺少图片 key' }, 400);
  await env.DB.prepare('DELETE FROM images WHERE workspace_id=? AND object_key=?').bind(session.workspace.id, key).run();
  return json({ ok: true });
}

async function requireSession(request, env) {
  const token = readCookie(request, COOKIE_NAME);
  if (!token) throw httpError('请先登录', 401);
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(`SELECT s.id session_id,s.expires_at,s.workspace_id,u.id user_id,u.name,u.email
    FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`).bind(tokenHash).first();
  if (!row || new Date(row.expires_at) < new Date()) throw httpError('登录已过期，请重新登录', 401);

  let workspace = null;
  if (row.workspace_id) {
    workspace = await env.DB.prepare(`SELECT w.* FROM workspaces w
      JOIN workspace_users wu ON wu.workspace_id=w.id
      WHERE w.id=? AND wu.user_id=? LIMIT 1`).bind(row.workspace_id, row.user_id).first();
  }
  if (!workspace) workspace = await firstWorkspace(env, row.user_id);
  if (!workspace) throw httpError('当前账号没有团队空间', 403);
  return { user: { id: row.user_id, name: row.name, email: row.email }, workspace };
}

async function firstWorkspace(env, userId) {
  return env.DB.prepare(`SELECT w.* FROM workspaces w JOIN workspace_users wu ON wu.workspace_id=w.id
    WHERE wu.user_id=? ORDER BY wu.created_at ASC LIMIT 1`).bind(userId).first();
}

async function createSession(env, userId, workspaceId) {
  const token = randomHex(32);
  const tokenHash = await sha256Hex(token);
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86400 * 1000).toISOString();
  try {
    await env.DB.prepare('INSERT INTO sessions (id,user_id,workspace_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?,?)')
      .bind(id('ses'), userId, workspaceId || null, tokenHash, expires, now.toISOString()).run();
  } catch (err) {
    // 兼容还没执行迁移 SQL 的旧库。旧库仍可登录，但建议执行 upgrade_workspace_session.sql。
    await env.DB.prepare('INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)')
      .bind(id('ses'), userId, tokenHash, expires, now.toISOString()).run();
  }
  return { token, expires };
}

function sessionCookie(token) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${SESSION_DAYS * 86400}`;
}
function publicUser(user) { return user ? { id: user.id, name: user.name, email: user.email } : null; }
function publicWorkspace(workspace) { return workspace ? { id: workspace.id, name: workspace.name, inviteCode: workspace.invite_code } : null; }
function clean(value) { return String(value || '').trim(); }
function id(prefix) { return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`; }
function makeInviteCode() { return randomHex(4).toUpperCase(); }
function httpError(message, status) { const e = new Error(message); e.status = status; return e; }
async function readJson(request) { try { return await request.json(); } catch { return {}; } }
function json(data, status = 200, setCookie = null) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (setCookie) headers['Set-Cookie'] = setCookie;
  return new Response(JSON.stringify(data), { status, headers });
}
function readCookie(request, name) {
  const cookie = request.headers.get('Cookie') || '';
  const part = cookie.split(';').map(v => v.trim()).find(v => v.startsWith(name + '='));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : '';
}
function randomHex(bytes) {
  const a = new Uint8Array(bytes); crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: hexToBytes(saltHex), iterations: ITERATIONS }, key, 256);
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function verifyPassword(password, salt, expected) {
  const actual = await hashPassword(password, salt);
  return timingSafeEqual(actual, expected);
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0; for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function base64ToBytes(base64) {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function extFromType(type) {
  if (type.includes('png')) return 'png';
  if (type.includes('webp')) return 'webp';
  if (type.includes('gif')) return 'gif';
  return 'jpg';
}
