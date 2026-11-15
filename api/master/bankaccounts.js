// 銀行代碼（bank_codes）與供應商匯款帳戶（supplier_bank_accounts）
//   - 銀行代碼：3 碼總機構代號；表格為空時自動寫入內建清單；內建代碼不能刪除，只能停用或改名
//   - 供應商匯款帳戶：一家可多個，一個預設；已用於付款的帳戶不能刪除（改停用）
//   - 帳號只存數字（去掉空白、橫線）
import { HttpError, json, readJson, toInt, nowTW } from '../lib/http.js';
import { BUILTIN_BANK_CODES, BANK_CATEGORIES } from '../lib/bankcodes.js';

export const normalizeAccountNo = (v) => String(v ?? '').replace(/[\s\-－‐]/g, '');
export function checkAccountNo(no, label = '帳號') {
  if (!/^\d{6,16}$/.test(no)) throw new HttpError(400, `${label}只能是 6～16 位數字（空白、橫線會自動去掉）`);
}
const text = (v, max = 100) => String(v ?? '').trim().slice(0, max) || null;

export async function ensureBankCodes(db) {
  const r = await db.prepare('SELECT COUNT(*) AS n FROM bank_codes').first();
  if (r.n) return false;
  await restoreBuiltin(db);
  return true;
}
async function restoreBuiltin(db) {
  const stmts = BUILTIN_BANK_CODES.map(([code, name, cat]) =>
    db.prepare('INSERT OR IGNORE INTO bank_codes (code, name, category, is_builtin) VALUES (?, ?, ?, 1)').bind(code, name, cat));
  const res = await db.batch(stmts);
  return res.reduce((s, x) => s + (x.meta?.changes || 0), 0);
}
export async function bankName(db, code) {
  if (!code) return null;
  return (await db.prepare('SELECT name FROM bank_codes WHERE code = ?').bind(code).first())?.name ?? null;
}

export async function handleBankCodes(id, request, env) {
  const db = env.DB;
  const method = request.method;
  if (!id && method === 'GET') {
    await ensureBankCodes(db);
    const sp = new URL(request.url).searchParams;
    const w = []; const b = [];
    if (sp.get('active') === '1') w.push('is_active = 1');
    if (sp.get('active') === '0') w.push('is_active = 0');
    if (sp.get('q')) { w.push('(code LIKE ? OR name LIKE ?)'); b.push(`%${sp.get('q')}%`, `%${sp.get('q')}%`); }
    if (sp.get('category')) { w.push('category = ?'); b.push(sp.get('category')); }
    const { results } = await db.prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM bank_accounts a WHERE a.bank_code = c.code) + (SELECT COUNT(*) FROM supplier_bank_accounts s WHERE s.bank_code = c.code) AS used
       FROM bank_codes c ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY c.code`,
    ).bind(...b).all();
    return json({ data: results, categories: BANK_CATEGORIES });
  }
  if (id === 'restore' && method === 'POST') {
    return json({ ok: true, inserted: await restoreBuiltin(db) });
  }
  if (!id && method === 'POST') {
    const body = await readJson(request);
    const code = String(body.code ?? '').trim();
    if (!/^\d{3}$/.test(code)) throw new HttpError(400, '銀行代號必須是 3 位數字');
    const name = text(body.name);
    if (!name) throw new HttpError(400, '請輸入銀行名稱');
    const cat = BANK_CATEGORIES.includes(body.category) ? body.category : '其他';
    if (await db.prepare('SELECT 1 FROM bank_codes WHERE code = ?').bind(code).first()) throw new HttpError(409, `代號 ${code} 已存在，請直接修改`);
    await db.prepare('INSERT INTO bank_codes (code, name, category, note) VALUES (?, ?, ?, ?)').bind(code, name, cat, text(body.note, 300)).run();
    return json({ data: await db.prepare('SELECT * FROM bank_codes WHERE code = ?').bind(code).first() }, 201);
  }
  if (!id) throw new HttpError(405, '不支援的操作');
  const cur = await db.prepare('SELECT * FROM bank_codes WHERE code = ?').bind(id).first();
  if (!cur) throw new HttpError(404, '找不到這個銀行代號');
  if (method === 'GET') return json({ data: cur });
  if (method === 'PUT') {
    const body = await readJson(request);
    const name = text(body.name) ?? cur.name;
    const cat = BANK_CATEGORIES.includes(body.category) ? body.category : cur.category;
    const active = body.is_active === undefined ? cur.is_active : (body.is_active === true || body.is_active === 1 || body.is_active === '1' ? 1 : 0);
    await db.prepare('UPDATE bank_codes SET name = ?, category = ?, is_active = ?, note = ?, updated_at = ? WHERE code = ?')
      .bind(name, cat, active, body.note === undefined ? cur.note : text(body.note, 300), nowTW(), id).run();
    return json({ data: await db.prepare('SELECT * FROM bank_codes WHERE code = ?').bind(id).first() });
  }
  if (method === 'DELETE') {
    if (cur.is_builtin) throw new HttpError(409, '內建代號不能刪除，不用的話請改為停用');
    const used = await db.prepare('SELECT (SELECT COUNT(*) FROM bank_accounts WHERE bank_code = ?) + (SELECT COUNT(*) FROM supplier_bank_accounts WHERE bank_code = ?) AS n').bind(id, id).first();
    if (used.n) throw new HttpError(409, `代號 ${id} 已有 ${used.n} 個帳戶使用，不能刪除，請改為停用`);
    await db.prepare('DELETE FROM bank_codes WHERE code = ?').bind(id).run();
    return json({ ok: true });
  }
  throw new HttpError(405, '不支援的操作');
}

const SBA_SELECT = `SELECT s.*, c.name AS bank_name, p.name AS supplier_name,
  (SELECT COUNT(*) FROM bank_transactions t WHERE t.payee_account_id = s.sba_id) AS used
  FROM supplier_bank_accounts s LEFT JOIN bank_codes c ON c.code = s.bank_code JOIN suppliers p ON p.supplier_id = s.supplier_id`;

/** 收款帳戶的文字說明（付款時存一份快照在收支上） */
export const payeeText = (a) => [`(${a.bank_code}) ${a.bank_name || ''}`.trim(), a.branch_name, a.account_holder && `戶名 ${a.account_holder}`, `帳號 ${a.account_no}`].filter(Boolean).join('　');

async function cleanSba(db, body, cur = {}) {
  const v = (k) => (body[k] === undefined ? cur[k] : body[k]);
  const code = String(v('bank_code') ?? '').trim();
  if (!/^\d{3}$/.test(code)) throw new HttpError(400, '請選擇銀行代號');
  if (!(await db.prepare('SELECT 1 FROM bank_codes WHERE code = ?').bind(code).first())) throw new HttpError(400, `銀行代號 ${code} 不在對照表中，請先到「主檔 → 銀行代碼」新增`);
  const no = normalizeAccountNo(v('account_no'));
  checkAccountNo(no);
  const branchCode = text(v('branch_code'), 10);
  if (branchCode && !/^\d{4}$/.test(branchCode)) throw new HttpError(400, '分行代號是 4 位數字（可留空）');
  const bool = (x, d) => (x === undefined || x === null || x === '' ? d : x === true || x === 1 || x === '1' || x === 'true' ? 1 : 0);
  return {
    bank_code: code, branch_name: text(v('branch_name')), branch_code: branchCode, account_no: no,
    account_holder: text(v('account_holder')), is_default: bool(body.is_default, cur.is_default ?? 0), is_active: bool(body.is_active, cur.is_active ?? 1),
    note: text(v('note'), 300),
  };
}

export async function handleSupplierAccounts(id, request, env) {
  const db = env.DB;
  const method = request.method;
  const sp = new URL(request.url).searchParams;
  if (!id && method === 'GET') {
    const w = []; const b = [];
    if (sp.get('supplier_id')) { w.push('s.supplier_id = ?'); b.push(toInt(sp.get('supplier_id'), '供應商')); }
    if (sp.get('active') === '1') w.push('s.is_active = 1');
    const { results } = await db.prepare(`${SBA_SELECT} ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY s.supplier_id, s.is_default DESC, s.sba_id`).bind(...b).all();
    for (const r of results) r.label = payeeText(r);
    return json({ data: results });
  }
  // 新增後若供應商沒有預設帳戶，第一個啟用的帳戶自動成為預設；設了預設就把同供應商其他帳戶取消預設
  const fixDefault = (supplierId, sbaId, isDefault) => [
    ...(isDefault ? [db.prepare('UPDATE supplier_bank_accounts SET is_default = 0 WHERE supplier_id = ? AND sba_id <> ?').bind(supplierId, sbaId)] : []),
    db.prepare(`UPDATE supplier_bank_accounts SET is_default = 1 WHERE sba_id = (SELECT sba_id FROM supplier_bank_accounts WHERE supplier_id = ? AND is_active = 1 ORDER BY sba_id LIMIT 1)
      AND NOT EXISTS (SELECT 1 FROM supplier_bank_accounts WHERE supplier_id = ? AND is_default = 1 AND is_active = 1)`).bind(supplierId, supplierId),
  ];
  if (!id && method === 'POST') {
    const body = await readJson(request);
    const supplierId = toInt(body.supplier_id, '供應商');
    if (!(await db.prepare('SELECT 1 FROM suppliers WHERE supplier_id = ?').bind(supplierId).first())) throw new HttpError(400, '供應商不存在');
    const r = await cleanSba(db, body);
    const ins = await db.prepare(
      `INSERT INTO supplier_bank_accounts (supplier_id, bank_code, branch_name, branch_code, account_no, account_holder, is_default, is_active, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(supplierId, r.bank_code, r.branch_name, r.branch_code, r.account_no, r.account_holder, r.is_default, r.is_active, r.note).run();
    const sbaId = ins.meta.last_row_id;
    await db.batch(fixDefault(supplierId, sbaId, r.is_default));
    return json({ data: await db.prepare(`${SBA_SELECT} WHERE s.sba_id = ?`).bind(sbaId).first() }, 201);
  }
  if (!id) throw new HttpError(405, '不支援的操作');
  const sbaId = toInt(id, '匯款帳戶');
  const cur = await db.prepare(`${SBA_SELECT} WHERE s.sba_id = ?`).bind(sbaId).first();
  if (!cur) throw new HttpError(404, '找不到這個匯款帳戶');
  if (method === 'GET') return json({ data: cur });
  if (method === 'PUT') {
    const r = await cleanSba(db, await readJson(request), cur);
    await db.batch([
      db.prepare(`UPDATE supplier_bank_accounts SET bank_code = ?, branch_name = ?, branch_code = ?, account_no = ?, account_holder = ?, is_default = ?, is_active = ?, note = ?, updated_at = ? WHERE sba_id = ?`)
        .bind(r.bank_code, r.branch_name, r.branch_code, r.account_no, r.account_holder, r.is_active ? r.is_default : 0, r.is_active, r.note, nowTW(), sbaId),
      ...fixDefault(cur.supplier_id, sbaId, r.is_active && r.is_default),
    ]);
    return json({ data: await db.prepare(`${SBA_SELECT} WHERE s.sba_id = ?`).bind(sbaId).first() });
  }
  if (method === 'DELETE') {
    if (cur.used) throw new HttpError(409, `這個帳戶已用於 ${cur.used} 筆付款，不能刪除，請改為停用`);
    await db.batch([db.prepare('DELETE FROM supplier_bank_accounts WHERE sba_id = ?').bind(sbaId), ...fixDefault(cur.supplier_id, -1, 0)]);
    return json({ ok: true });
  }
  throw new HttpError(405, '不支援的操作');
}
