// 使用者管理（管理者）
//   新增使用者後，記得也把對方的 email 加進 Cloudflare Access 的允許名單，對方才登得進來
//   至少要保留一位啟用中的管理者；不能停用或刪除自己

import { HttpError, json, readJson, toInt, nowTW } from '../lib/http.js';
import { ROLES, ROLE_PERMS, MODULE_LABELS, permsOf } from '../lib/perm.js';

async function prepare(db, body, excludeId = null) {
  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'email 格式錯誤');
  const dup = await db.prepare('SELECT user_id FROM users WHERE email = ?').bind(email).first();
  if (dup && dup.user_id !== excludeId) throw new HttpError(409, `${email} 已經在使用者名單中`);
  const role = body.role || '門市';
  if (!ROLES.includes(role)) throw new HttpError(400, `角色必須是：${ROLES.join('／')}`);
  const is_active = body.is_active === undefined ? 1 : (body.is_active === true || body.is_active === 1 || body.is_active === '1' ? 1 : 0);
  return { email, name: String(body.name || '').trim() || null, role, is_active, note: String(body.note || '').trim() || null };
}

async function activeAdmins(db, excludeId) {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = '管理者' AND is_active = 1 AND user_id <> ?").bind(excludeId).first();
  return r.n;
}

export async function handleUsers(id, request, env, me) {
  const db = env.DB;
  const method = request.method;
  if (id === 'roles' && method === 'GET') {
    return json({ data: ROLES.map((r) => ({ role: r, ...permsOf(r) })), modules: MODULE_LABELS, raw: ROLE_PERMS });
  }
  if (!id && method === 'GET') {
    const { results } = await db.prepare('SELECT * FROM users ORDER BY is_active DESC, role, user_id').all();
    return json({ data: results });
  }
  if (!id && method === 'POST') {
    const row = await prepare(db, await readJson(request));
    const res = await db.prepare('INSERT INTO users (email, name, role, is_active, note) VALUES (?, ?, ?, ?, ?)').bind(row.email, row.name, row.role, row.is_active, row.note).run();
    return json({ data: await db.prepare('SELECT * FROM users WHERE user_id = ?').bind(res.meta.last_row_id).first() }, 201);
  }
  if (!id) throw new HttpError(405, '不支援的操作');
  const uid = toInt(id, '使用者');
  const cur = await db.prepare('SELECT * FROM users WHERE user_id = ?').bind(uid).first();
  if (!cur) throw new HttpError(404, '找不到使用者');
  if (method === 'GET') return json({ data: cur });
  if (method === 'PUT') {
    const row = await prepare(db, await readJson(request), uid);
    if (cur.user_id === me.user_id && (row.role !== '管理者' || !row.is_active)) throw new HttpError(400, '不能把自己改成非管理者或停用');
    if (cur.role === '管理者' && (row.role !== '管理者' || !row.is_active) && (await activeAdmins(db, uid)) === 0) throw new HttpError(400, '至少要保留一位啟用中的管理者');
    await db.prepare('UPDATE users SET email = ?, name = ?, role = ?, is_active = ?, note = ?, updated_at = ? WHERE user_id = ?')
      .bind(row.email, row.name, row.role, row.is_active, row.note, nowTW(), uid).run();
    return json({ data: await db.prepare('SELECT * FROM users WHERE user_id = ?').bind(uid).first() });
  }
  if (method === 'DELETE') {
    if (cur.user_id === me.user_id) throw new HttpError(400, '不能刪除自己');
    if (cur.role === '管理者' && cur.is_active && (await activeAdmins(db, uid)) === 0) throw new HttpError(400, '至少要保留一位啟用中的管理者');
    await db.prepare('DELETE FROM users WHERE user_id = ?').bind(uid).run();
    return json({ ok: true });
  }
  throw new HttpError(405, '不支援的操作');
}

export async function handleAuditLogs(id, request, env) {
  const db = env.DB;
  if (request.method !== 'GET') throw new HttpError(405, '不支援的操作');
  if (id) {
    const r = await db.prepare('SELECT * FROM audit_logs WHERE log_id = ?').bind(toInt(id, '日誌')).first();
    if (!r) throw new HttpError(404, '找不到日誌');
    return json({ data: r });
  }
  const sp = new URL(request.url).searchParams;
  const where = [];
  const binds = [];
  if (sp.get('from')) { where.push('created_at >= ?'); binds.push(sp.get('from')); }
  if (sp.get('to')) { where.push('created_at < date(?, \'+1 day\')'); binds.push(sp.get('to')); }
  if (sp.get('user')) { where.push('user_email = ?'); binds.push(sp.get('user')); }
  if (sp.get('resource')) { where.push('resource = ?'); binds.push(sp.get('resource')); }
  if (sp.get('action')) { where.push('action = ?'); binds.push(sp.get('action')); }
  if (sp.get('record_id')) { where.push('record_id = ?'); binds.push(sp.get('record_id')); }
  const q = (sp.get('q') || '').trim();
  if (q) { where.push('(summary LIKE ? OR path LIKE ?)'); binds.push(`%${q}%`, `%${q}%`); }
  const limit = Math.min(Number(sp.get('limit')) || 200, 1000);
  const { results } = await db.prepare(
    `SELECT log_id, user_email, action, resource, record_id, method, path, summary, created_at FROM audit_logs
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY log_id DESC LIMIT ${limit}`,
  ).bind(...binds).all();
  const { results: users } = await db.prepare('SELECT DISTINCT user_email FROM audit_logs ORDER BY user_email').all();
  return json({ data: results, users: users.map((u) => u.user_email) });
}
