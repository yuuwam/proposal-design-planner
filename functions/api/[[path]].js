const COOKIE_NAME = 'pdp_session';
const SESSION_DAYS = 30;
const ITERATIONS = 100000;

export async function onRequest(context) {
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
    if (path === 'state' && request.method === 'GET') return await getState(env, session);
    if (path === 'state' && request.method === 'PUT') return await putState(request, env, session);
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

  const session = await createSession(env, userId);
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
  const session = await createSession(env, user.id);
  const workspace = await firstWorkspace(env, user.id);
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

async function getState(env, session) {
  const row = await env.DB.prepare('SELECT state_json,updated_at,updated_by FROM planner_states WHERE workspace_id=?')
    .bind(session.workspace.id).first();
  return json({ state: row?.state_json ? JSON.parse(row.state_json) : null, updatedAt: row?.updated_at || null, updatedBy: row?.updated_by || null });
}

async function putState(request, env, session) {
  const body = await readJson(request);
  if (!body.state || typeof body.state !== 'object') return json({ message: '缺少 state 数据' }, 400);
  const stateJson = JSON.stringify(body.state);
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO planner_states (workspace_id,state_json,updated_at,updated_by) VALUES (?,?,?,?)
    ON CONFLICT(workspace_id) DO UPDATE SET state_json=excluded.state_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
    .bind(session.workspace.id, stateJson, now, session.user.id).run();
  return json({ ok: true, updatedAt: now });
}

async function joinWorkspace(request, env, session) {
  const body = await readJson(request);
  const inviteCode = clean(body.inviteCode).toUpperCase();
  const workspace = await env.DB.prepare('SELECT * FROM workspaces WHERE invite_code=?').bind(inviteCode).first();
  if (!workspace) return json({ message: '团队码不存在' }, 404);
  await env.DB.prepare('INSERT OR IGNORE INTO workspace_users (workspace_id,user_id,role,created_at) VALUES (?,?,?,?)')
    .bind(workspace.id, session.user.id, 'member', new Date().toISOString()).run();
  return json({ ok: true, workspace: publicWorkspace(workspace) });
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
  const row = await env.DB.prepare(`SELECT s.id session_id,s.expires_at,u.id user_id,u.name,u.email
    FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`).bind(tokenHash).first();
  if (!row || new Date(row.expires_at) < new Date()) throw httpError('登录已过期，请重新登录', 401);
  const workspace = await firstWorkspace(env, row.user_id);
  if (!workspace) throw httpError('当前账号没有团队空间', 403);
  return { user: { id: row.user_id, name: row.name, email: row.email }, workspace };
}

async function firstWorkspace(env, userId) {
  return env.DB.prepare(`SELECT w.* FROM workspaces w JOIN workspace_users wu ON wu.workspace_id=w.id
    WHERE wu.user_id=? ORDER BY wu.created_at ASC LIMIT 1`).bind(userId).first();
}

async function createSession(env, userId) {
  const token = randomHex(32);
  const tokenHash = await sha256Hex(token);
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86400 * 1000).toISOString();
  await env.DB.prepare('INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)')
    .bind(id('ses'), userId, tokenHash, expires, now.toISOString()).run();
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
