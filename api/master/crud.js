// 主檔通用 CRUD（供應商、客戶＋喜好、生豆品項、包材、產品、熟豆品項）
import { HttpError, json, readJson, toInt, isDate, nowTW } from '../lib/http.js';
import { resources, PREF_FIELDS } from './resources.js';

/** 依欄位定義清洗輸入值；partial=true 時只處理有送來的欄位 */
export function clean(fields, body, { partial = false } = {}) {
  const out = {};
  for (const [name, f] of Object.entries(fields)) {
    let v = body[name];
    const missing = v === undefined;
    if (missing && partial) continue;
    if (typeof v === 'string') v = v.trim();
    if (v === '' || v === undefined) v = null;

    if (v === null) {
      if (f.required) throw new HttpError(400, `「${name}」為必填`);
      out[name] = f.default ?? null;
      continue;
    }
    switch (f.type) {
      case 'text': out[name] = String(v); break;
      case 'number': {
        const n = Number(v);
        if (!Number.isFinite(n)) throw new HttpError(400, `「${name}」必須是數字`);
        out[name] = n; break;
      }
      case 'int': case 'fk': {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `「${name}」必須是整數`);
        out[name] = n; break;
      }
      case 'bool': out[name] = v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0; break;
      case 'date':
        if (!isDate(v)) throw new HttpError(400, `「${name}」日期格式錯誤（YYYY-MM-DD）`);
        out[name] = v; break;
      case 'enum':
        if (!f.values.includes(v)) throw new HttpError(400, `「${name}」必須是：${f.values.join('／')}`);
        out[name] = v; break;
    }
  }
  return out;
}

/** 主檔自訂檢核（resources.js 的 validate） */
function check(r, row) {
  const msg = r.validate?.(row);
  if (msg) throw new HttpError(400, msg);
}

async function getOne(db, r, id) {
  const row = await db
    .prepare(`SELECT t.*${r.joinCols ? ', ' + r.joinCols : ''} FROM ${r.table} t ${r.joins || ''} WHERE t.${r.pk} = ?`)
    .bind(id).first();
  if (!row) throw new HttpError(404, `找不到${r.label}`);
  if (r.table === 'customers') {
    const prefs = await db.prepare('SELECT * FROM customer_preferences WHERE customer_id = ? ORDER BY pref_id').bind(id).all();
    row.preferences = prefs.results;
  }
  return row;
}

function prefStatements(db, customerIdExpr, customerIdBind, prefs) {
  if (!Array.isArray(prefs)) throw new HttpError(400, 'preferences 必須是陣列');
  const cols = Object.keys(PREF_FIELDS);
  return prefs
    .map((p) => clean(PREF_FIELDS, p || {}))
    .filter((p) => Object.values(p).some((v) => v !== null)) // 全空的列略過
    .map((p) => db
      .prepare(`INSERT INTO customer_preferences (customer_id, ${cols.join(', ')}) VALUES (${customerIdExpr}, ${cols.map(() => '?').join(', ')})`)
      .bind(...customerIdBind, ...cols.map((c) => p[c])));
}

export async function handleMaster(resourceKey, id, request, env) {
  const r = resources[resourceKey];
  const db = env.DB;
  const url = new URL(request.url);
  const method = request.method;

  // ---- 列表 ----
  if (!id && method === 'GET') {
    const where = [];
    const binds = [];
    const q = (url.searchParams.get('q') || '').trim();
    if (q) {
      where.push('(' + r.search.map((c) => `t.${c} LIKE ?`).join(' OR ') + ')');
      r.search.forEach(() => binds.push(`%${q}%`));
    }
    const active = url.searchParams.get('active');
    if (active === '1' || active === '0') { where.push('t.is_active = ?'); binds.push(Number(active)); }
    const sql = `SELECT t.*${r.joinCols ? ', ' + r.joinCols : ''} FROM ${r.table} t ${r.joins || ''}
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.is_active DESC, t.${r.pk}`;
    const { results } = await db.prepare(sql).bind(...binds).all();
    return json({ data: results });
  }

  // ---- 新增 ----
  if (!id && method === 'POST') {
    const body = await readJson(request);
    const data = clean(r.fields, body);
    r.normalize?.(data);
    check(r, data);
    const cols = Object.keys(data);
    const insert = db
      .prepare(`INSERT INTO ${r.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .bind(...cols.map((c) => data[c]));
    if (r.table === 'customers' && body.preferences !== undefined) {
      // 同一個 batch（交易）內：先新增客戶，再新增喜好
      const stmts = [insert, ...prefStatements(db, '(SELECT MAX(customer_id) FROM customers)', [], body.preferences)];
      await db.batch(stmts);
      const row = await db.prepare('SELECT MAX(customer_id) AS id FROM customers').first();
      return json({ data: await getOne(db, r, row.id) }, 201);
    }
    const res = await insert.run();
    return json({ data: await getOne(db, r, res.meta.last_row_id) }, 201);
  }

  if (!id) throw new HttpError(405, '不支援的操作');
  const pk = toInt(id);

  if (method === 'GET') return json({ data: await getOne(db, r, pk) });

  // ---- 修改 ----
  if (method === 'PUT' || method === 'PATCH') {
    const current = await getOne(db, r, pk);
    const body = await readJson(request);
    const data = clean(r.fields, body, { partial: method === 'PATCH' });
    r.normalize?.(data);
    check(r, { ...current, ...data });
    const cols = Object.keys(data);
    const stmts = [];
    if (cols.length) {
      stmts.push(db
        .prepare(`UPDATE ${r.table} SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE ${r.pk} = ?`)
        .bind(...cols.map((c) => data[c]), nowTW(), pk));
    }
    if (r.table === 'customers' && body.preferences !== undefined) {
      stmts.push(db.prepare('DELETE FROM customer_preferences WHERE customer_id = ?').bind(pk));
      stmts.push(...prefStatements(db, '?', [pk], body.preferences));
    }
    if (stmts.length) await db.batch(stmts);
    return json({ data: await getOne(db, r, pk) });
  }

  // ---- 刪除：已被單據使用 → 拒絕，請改為停用 ----
  if (method === 'DELETE') {
    await getOne(db, r, pk);
    for (const [table, col, label] of r.refs) {
      const used = await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`).bind(pk).first();
      if (used.n > 0) {
        throw new HttpError(409, `此${r.label}已被 ${used.n} 筆${label}使用，無法刪除，請改為「停用」`);
      }
    }
    if (r.table === 'packaging_items') {
      const mv = await db.prepare("SELECT COUNT(*) AS n FROM inventory_movements WHERE item_type = '包材' AND item_ref_id = ?").bind(pk).first();
      if (mv.n > 0) throw new HttpError(409, '此包材已有庫存異動，無法刪除，請改為「停用」');
    }
    await db.prepare(`DELETE FROM ${r.table} WHERE ${r.pk} = ?`).bind(pk).run();
    return json({ ok: true });
  }

  throw new HttpError(405, '不支援的操作');
}
