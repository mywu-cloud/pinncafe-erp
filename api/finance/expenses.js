// 費用支出（房租、瓦斯、電費…）
//   只記費用、不動帳戶；付款請到「銀行收支」登錄出帳並沖銷這筆費用（payment_allocations）
//   收付款狀態依沖帳自動更新。已沖帳的費用仍可修改；金額改得比已付少 → 標示溢付。
//   有沖帳的費用不可刪除（請先刪除沖帳）。
//   allocate_to_roast：是否攤入烘焙成本，Phase 3 只記標記（Phase 5 成本報表再攤提）

import { HttpError, json, readJson, toInt, isDate, dateRange, nowTW, round } from '../lib/http.js';
import { makeNo, seqOf, lastSeq, seqStatement } from '../lib/docno.js';
import { statusStatement, docPayments, paidExpr } from '../lib/payment.js';

async function prepare(db, body, { excludeId = null, keepNo = null } = {}) {
  if (!isDate(body.expense_date)) throw new HttpError(400, '費用日期格式錯誤（YYYY-MM-DD）');
  const category_id = toInt(body.category_id, '費用類別');
  const cat = await db.prepare('SELECT category_id, allocate_to_roast FROM expense_categories WHERE category_id = ?').bind(category_id).first();
  if (!cat) throw new HttpError(400, '費用類別不存在');
  const amount = round(Number(body.amount));
  if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, '金額必須大於 0');
  if (body.due_date && !isDate(body.due_date)) throw new HttpError(400, '應付日期格式錯誤（YYYY-MM-DD）');
  const flag = body.allocate_to_roast;
  const allocate_to_roast = flag === undefined || flag === null || flag === ''
    ? cat.allocate_to_roast
    : (flag === true || flag === 1 || flag === '1' || flag === 'true' ? 1 : 0);

  const ymd = body.expense_date.replaceAll('-', '');
  let expense_no = (body.expense_no || '').trim() || keepNo || null;
  let eLast = await lastSeq(db, 'E', ymd);
  if (!expense_no) expense_no = makeNo('E', ymd, ++eLast);
  else {
    const dup = await db.prepare('SELECT expense_id FROM expenses WHERE expense_no = ?').bind(expense_no).first();
    if (dup && dup.expense_id !== excludeId) throw new HttpError(409, `費用編號 ${expense_no} 已存在`);
    eLast = Math.max(eLast, seqOf(expense_no, 'E', ymd));
  }
  return {
    row: {
      expense_no, expense_date: body.expense_date, category_id, amount,
      vendor: (body.vendor || '').trim() || null,
      invoice_no: (body.invoice_no || '').trim() || null,
      allocate_to_roast, due_date: body.due_date || null,
      note: (body.note || '').trim() || null,
    },
    ymd, eLast,
  };
}

const COLS = ['expense_no', 'expense_date', 'category_id', 'amount', 'vendor', 'invoice_no', 'allocate_to_roast', 'due_date', 'note'];

async function getExpense(db, id) {
  const e = await db.prepare(
    `SELECT e.*, c.name AS category_name FROM expenses e JOIN expense_categories c ON c.category_id = e.category_id WHERE e.expense_id = ?`,
  ).bind(id).first();
  if (!e) throw new HttpError(404, '找不到這筆費用');
  Object.assign(e, await docPayments(db, 'expenses', id));
  e.overpaid = round(Math.max(0, e.paid_amount - e.amount));
  return e;
}

export async function handleExpenses(id, request, env, user) {
  const db = env.DB;
  const url = new URL(request.url);
  const method = request.method;

  if (!id && method === 'GET') {
    const { from, to } = dateRange(url);
    const sp = url.searchParams;
    const where = [];
    const binds = [];
    if (from) { where.push('e.expense_date >= ?'); binds.push(from); }
    if (to) { where.push('e.expense_date <= ?'); binds.push(to); }
    if (sp.get('category_id')) { where.push('e.category_id = ?'); binds.push(toInt(sp.get('category_id'), '費用類別')); }
    if (sp.get('payment_status')) { where.push('e.payment_status = ?'); binds.push(sp.get('payment_status')); }
    if (sp.get('allocate_to_roast') === '1') where.push('e.allocate_to_roast = 1');
    const q = (sp.get('q') || '').trim();
    if (q) { where.push('(e.vendor LIKE ? OR e.note LIKE ? OR e.invoice_no LIKE ? OR e.expense_no LIKE ?)'); binds.push(...Array(4).fill(`%${q}%`)); }
    const { results } = await db.prepare(
      `SELECT e.*, c.name AS category_name,
              ${paidExpr('expenses', 'e.expense_id')} AS paid_amount
       FROM expenses e JOIN expense_categories c ON c.category_id = e.category_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY e.expense_date DESC, e.expense_id DESC`,
    ).bind(...binds).all();
    for (const r of results) { r.paid_amount = round(r.paid_amount); r.unpaid_amount = round(Math.max(0, r.amount - r.paid_amount)); }
    const summary = {
      count: results.length,
      amount: round(results.reduce((s, r) => s + r.amount, 0)),
      unpaid_amount: round(results.reduce((s, r) => s + r.unpaid_amount, 0)),
      roast_amount: round(results.filter((r) => r.allocate_to_roast).reduce((s, r) => s + r.amount, 0)),
    };
    return json({ from, to, data: results, summary });
  }

  if (!id && method === 'POST') {
    const p = await prepare(db, await readJson(request));
    await db.batch([
      db.prepare(`INSERT INTO expenses (${COLS.join(', ')}, created_by) VALUES (${COLS.map(() => '?').join(', ')}, ?)`)
        .bind(...COLS.map((c) => p.row[c]), user),
      seqStatement(db, 'E', p.ymd, p.eLast),
    ]);
    const row = await db.prepare('SELECT expense_id FROM expenses WHERE expense_no = ?').bind(p.row.expense_no).first();
    return json({ data: await getExpense(db, row.expense_id) }, 201);
  }

  if (!id) throw new HttpError(405, '不支援的操作');
  const eid = toInt(id, '費用');
  if (method === 'GET') return json({ data: await getExpense(db, eid) });

  if (method === 'PUT') {
    const cur = await getExpense(db, eid);
    const p = await prepare(db, await readJson(request), { excludeId: eid, keepNo: cur.expense_no });
    await db.batch([
      db.prepare(`UPDATE expenses SET ${COLS.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE expense_id = ?`)
        .bind(...COLS.map((c) => p.row[c]), nowTW(), eid),
      statusStatement(db, 'expenses', [eid]),
      seqStatement(db, 'E', p.ymd, p.eLast),
    ]);
    return json({ data: await getExpense(db, eid) });
  }

  if (method === 'DELETE') {
    const cur = await getExpense(db, eid);
    if (cur.payments.length) throw new HttpError(409, `這筆費用已有 ${cur.payments.length} 筆付款沖帳（${cur.payments.map((x) => x.txn_no).join('、')}），請先到銀行收支刪除沖帳`);
    await db.prepare('DELETE FROM expenses WHERE expense_id = ?').bind(eid).run();
    return json({ ok: true });
  }
  throw new HttpError(405, '不支援的操作');
}
