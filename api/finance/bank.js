// 銀行收支（入帳／出帳／帳戶互轉）＋ 收付款沖帳
// 規則（ARCHITECTURE.md 8.4）：
//   1. 收款、付款一律手動登錄入帳／出帳，再選要沖銷的單據（payment_allocations）
//      入帳 → 沖銷貨單（收款）或進貨單（供應商退款）
//      出帳 → 沖進貨單／費用（付款）或銷貨單（退款給客戶）
//   2. 一筆收支可沖多張單，一張單也可分多次沖；沖帳合計不可超過收支金額；
//      收付款不可超過單據未沖餘額（淨額 = 原單 − 退貨折讓），退款不可超過應退金額
//   3. 單據收付款狀態依已沖金額自動更新（lib/payment.js）
//   4. 帳戶互轉 = 來源帳戶出帳 ＋ 目的帳戶入帳（各一筆，transfer_txn_id 互指），不可沖帳
//   5. 交易日期不可早於帳戶期初日期
// 收支、沖帳、狀態更新在同一個 D1 batch（單一交易）。

import { HttpError, json, readJson, toInt, isDate, dateRange, nowTW, round } from '../lib/http.js';
import { makeNo, lastSeq, seqStatement } from '../lib/docno.js';
import { DOCS, statusStatement, docBalance, paidExpr, netExpr } from '../lib/payment.js';

export const DIRECTIONS = ['入帳', '出帳'];
export const CATEGORIES = ['銷貨收款', '進貨付款', '費用', '轉帳', '手續費', '利息', '其他'];
const EPS = 0.005;

async function getAccount(db, id, label = '帳戶') {
  const a = await db.prepare('SELECT * FROM bank_accounts WHERE account_id = ?').bind(toInt(id, label)).first();
  if (!a) throw new HttpError(400, `${label}不存在`);
  return a;
}
function checkOpeningDate(acc, date) {
  if (acc.opening_date && date < acc.opening_date) {
    throw new HttpError(400, `交易日期不可早於「${acc.account_name}」的期初日期 ${acc.opening_date}`);
  }
}
const amountOf = (v) => {
  const n = round(Number(v));
  if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, '金額必須大於 0');
  return n;
};

/** 驗證一般收支（非互轉）與沖帳 */
async function prepare(db, body, { excludeTxnId = null } = {}) {
  const acc = await getAccount(db, body.account_id);
  if (!isDate(body.txn_date)) throw new HttpError(400, '交易日期格式錯誤（YYYY-MM-DD）');
  checkOpeningDate(acc, body.txn_date);
  if (!DIRECTIONS.includes(body.direction)) throw new HttpError(400, '方向必須是 入帳／出帳');
  const category = body.category || (body.direction === '入帳' ? '銷貨收款' : '進貨付款');
  if (!CATEGORIES.includes(category)) throw new HttpError(400, `類別必須是：${CATEGORIES.join('／')}`);
  if (category === '轉帳') throw new HttpError(400, '帳戶互轉請用「帳戶互轉」功能');
  const amount = amountOf(body.amount);

  let customer_id = null;
  let supplier_id = null;
  let counterparty = (body.counterparty || '').trim() || null;
  if (body.customer_id) {
    customer_id = toInt(body.customer_id, '客戶');
    const c = await db.prepare('SELECT name FROM customers WHERE customer_id = ?').bind(customer_id).first();
    if (!c) throw new HttpError(400, '客戶不存在');
    counterparty = counterparty || c.name;
  }
  if (body.supplier_id) {
    supplier_id = toInt(body.supplier_id, '供應商');
    const s = await db.prepare('SELECT name FROM suppliers WHERE supplier_id = ?').bind(supplier_id).first();
    if (!s) throw new HttpError(400, '供應商不存在');
    counterparty = counterparty || s.name;
  }

  // ---- 沖帳 ----
  const raw = Array.isArray(body.allocations) ? body.allocations : [];
  const allocations = [];
  const seen = new Set();
  for (const [i, a] of raw.entries()) {
    const amt = round(Number(a.amount));
    if (!amt) continue; // 0 或空白 = 不沖
    const line = i + 1;
    if (!Number.isFinite(amt) || amt < 0) throw new HttpError(400, `第 ${line} 筆沖帳：金額不可為負數`);
    const d = DOCS[a.doc_type];
    if (!d) throw new HttpError(400, `第 ${line} 筆沖帳：單據類型錯誤`);
    if (body.direction === '入帳' && a.doc_type === 'expenses') throw new HttpError(400, '入帳不能沖費用');
    const doc_id = toInt(a.doc_id, `第 ${line} 筆沖帳單據`);
    const key = `${a.doc_type}:${doc_id}`;
    if (seen.has(key)) throw new HttpError(400, '同一張單據請合併成一筆沖帳');
    seen.add(key);
    const bal = await docBalance(db, a.doc_type, doc_id, excludeTxnId);
    if (!bal) throw new HttpError(400, `第 ${line} 筆沖帳：${d.label}不存在`);
    const isPay = body.direction === d.payDir; // 收付款；否則為退款
    if (isPay && amt > bal.remaining + EPS) throw new HttpError(409, `${d.label} ${bal.no} 未沖餘額只剩 ${Math.max(0, bal.remaining)}，不可沖 ${amt}`);
    if (!isPay && amt > bal.refundable + EPS) throw new HttpError(409, `${d.label} ${bal.no} 應退金額只有 ${Math.max(0, bal.refundable)}，不可退 ${amt}`);
    allocations.push({ doc_type: a.doc_type, doc_id, amount: amt });
  }
  const allocated = round(allocations.reduce((s, a) => s + a.amount, 0));
  if (allocated > amount + EPS) throw new HttpError(400, `沖帳合計 ${allocated} 超過收支金額 ${amount}`);

  return {
    acc,
    row: {
      account_id: acc.account_id, txn_date: body.txn_date, direction: body.direction, amount, category,
      customer_id, supplier_id, counterparty,
      description: (body.description || '').trim() || null,
      bank_ref_no: (body.bank_ref_no || '').trim() || null,
    },
    allocations,
  };
}

const COLS = ['account_id', 'txn_date', 'direction', 'amount', 'category', 'customer_id', 'supplier_id', 'counterparty', 'description', 'bank_ref_no'];

function insertTxn(db, txnNo, row, user, transferNo = null) {
  return db.prepare(
    `INSERT INTO bank_transactions (txn_no, ${COLS.join(', ')}, transfer_txn_id, created_by)
     VALUES (?, ${COLS.map(() => '?').join(', ')}, ${transferNo ? '(SELECT txn_id FROM bank_transactions WHERE txn_no = ?)' : 'NULL'}, ?)`,
  ).bind(txnNo, ...COLS.map((c) => row[c] ?? null), ...(transferNo ? [transferNo] : []), user);
}

function allocStatements(db, txnNo, allocations) {
  return allocations.map((a) => db.prepare(
    'INSERT INTO payment_allocations (txn_id, doc_type, doc_id, amount) VALUES ((SELECT txn_id FROM bank_transactions WHERE txn_no = ?), ?, ?, ?)',
  ).bind(txnNo, a.doc_type, a.doc_id, a.amount));
}

/** 受影響單據（舊沖帳＋新沖帳）的狀態重算語句 */
function statusStatements(db, ...lists) {
  const byType = {};
  for (const list of lists) for (const a of list) (byType[a.doc_type] ||= []).push(a.doc_id);
  return Object.entries(byType).map(([t, ids]) => statusStatement(db, t, ids)).filter(Boolean);
}

async function nextNos(db, date, count) {
  const ymd = date.replaceAll('-', '');
  let last = await lastSeq(db, 'T', ymd);
  const nos = Array.from({ length: count }, () => makeNo('T', ymd, ++last));
  return { nos, ymd, last };
}

async function getTxn(db, id) {
  const t = await db.prepare(
    `SELECT t.*, a.account_name, a.account_type, c.name AS customer_name, s.name AS supplier_name,
            o.txn_no AS transfer_txn_no, o.account_id AS transfer_account_id, oa.account_name AS transfer_account_name
     FROM bank_transactions t
     JOIN bank_accounts a ON a.account_id = t.account_id
     LEFT JOIN customers c ON c.customer_id = t.customer_id
     LEFT JOIN suppliers s ON s.supplier_id = t.supplier_id
     LEFT JOIN bank_transactions o ON o.txn_id = t.transfer_txn_id
     LEFT JOIN bank_accounts oa ON oa.account_id = o.account_id
     WHERE t.txn_id = ?`,
  ).bind(id).first();
  if (!t) throw new HttpError(404, '找不到這筆收支');
  const { results } = await db.prepare(
    `SELECT a.allocation_id, a.doc_type, a.doc_id, a.amount,
            COALESCE(s.sale_no, p.purchase_no, e.expense_no) AS doc_no,
            COALESCE(s.sale_date, p.purchase_date, e.expense_date) AS doc_date,
            COALESCE(s.total_amount, p.total_amount, e.amount) AS doc_total
     FROM payment_allocations a
     LEFT JOIN sales s ON a.doc_type = 'sales' AND s.sale_id = a.doc_id
     LEFT JOIN purchases p ON a.doc_type = 'purchases' AND p.purchase_id = a.doc_id
     LEFT JOIN expenses e ON a.doc_type = 'expenses' AND e.expense_id = a.doc_id
     WHERE a.txn_id = ? ORDER BY a.allocation_id`,
  ).bind(id).all();
  t.allocations = results;
  t.allocated = round(results.reduce((s, a) => s + a.amount, 0));
  t.unallocated = round(t.amount - t.allocated);
  return t;
}

/** 帳戶在某日（不含）之前的餘額 */
async function balanceBefore(db, acc, date) {
  const r = await db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN direction = '入帳' THEN amount ELSE -amount END), 0) AS net
     FROM bank_transactions WHERE account_id = ? ${date ? 'AND txn_date < ?' : ''}`,
  ).bind(acc.account_id, ...(date ? [date] : [])).first();
  return round(acc.opening_balance + r.net);
}

/** 各帳戶截至某日（含）的餘額 */
export async function balances(db, asOf) {
  const { results } = await db.prepare(
    `SELECT a.account_id, a.account_name, a.account_type, a.bank_name, a.account_no_masked, a.opening_balance, a.opening_date, a.is_active,
            COALESCE(SUM(CASE WHEN t.direction = '入帳' THEN t.amount END), 0) AS in_amount,
            COALESCE(SUM(CASE WHEN t.direction = '出帳' THEN t.amount END), 0) AS out_amount
     FROM bank_accounts a
     LEFT JOIN bank_transactions t ON t.account_id = a.account_id ${asOf ? 'AND t.txn_date <= ?' : ''}
     GROUP BY a.account_id ORDER BY a.is_active DESC, a.account_id`,
  ).bind(...(asOf ? [asOf] : [])).all();
  for (const r of results) {
    r.in_amount = round(r.in_amount);
    r.out_amount = round(r.out_amount);
    r.balance = round(r.opening_balance + r.in_amount - r.out_amount);
  }
  return results;
}

export async function handleBank(id, request, env, user) {
  const db = env.DB;
  const url = new URL(request.url);
  const sp = url.searchParams;
  const method = request.method;

  // ---- 可沖帳的未結單據 ----
  //   入帳：未收清的銷貨單（可依客戶）＋ 供應商應退款的進貨單（可依供應商）
  //   出帳：未付清的進貨單（可依供應商）＋ 未付清的費用 ＋ 應退客戶的銷貨單（可依客戶）
  //   exclude_txn_id：修改收支時，把它自己的沖帳加回去；mine = 這筆收支原本沖的金額
  if (id === 'open-docs' && method === 'GET') {
    const dir = sp.get('direction');
    if (!DIRECTIONS.includes(dir)) throw new HttpError(400, 'direction 必須是 入帳／出帳');
    const ex = sp.get('exclude_txn_id') ? toInt(sp.get('exclude_txn_id'), '收支') : -1;
    const cid = sp.get('customer_id');
    const sid = sp.get('supplier_id');
    const mine = (t, pk) => `COALESCE((SELECT SUM(a.amount) FROM payment_allocations a WHERE a.doc_type = '${t}' AND a.doc_id = ${pk} AND a.txn_id = ${ex}), 0)`;
    // kind：pay = 收付款（餘額 = 淨額 − 已收付）；refund = 退款（餘額 = 已收付 − 淨額）
    const query = async (t, kind, extraWhere, binds) => {
      const d = DOCS[t];
      const net = netExpr(t, 'x');
      const paid = paidExpr(t, `x.${d.pk}`, { excludeTxn: ex });
      const bal = kind === 'pay' ? `(${net} - ${paid})` : `(${paid} - ${net})`;
      const sel = {
        sales: `x.sale_no AS doc_no, x.sale_date AS doc_date, x.due_date, COALESCE(c.name, '散客') AS party, x.payment_method AS info FROM sales x LEFT JOIN customers c ON c.customer_id = x.customer_id`,
        purchases: `x.purchase_no AS doc_no, x.purchase_date AS doc_date, x.due_date, s.name AS party, x.invoice_no AS info FROM purchases x JOIN suppliers s ON s.supplier_id = x.supplier_id`,
        expenses: `x.expense_no AS doc_no, x.expense_date AS doc_date, x.due_date, COALESCE(x.vendor, '') AS party, c.name AS info FROM expenses x JOIN expense_categories c ON c.category_id = x.category_id`,
      }[t];
      const { results } = await db.prepare(
        `SELECT '${t}' AS doc_type, '${kind}' AS kind, x.${d.pk} AS doc_id, ${net} AS total, ${paid} AS paid, ${bal} AS remaining, ${mine(t, `x.${d.pk}`)} AS mine, ${sel}
         WHERE (${bal} > 0.005 OR ${mine(t, `x.${d.pk}`)} > 0) ${extraWhere}
         ORDER BY doc_date, x.${d.pk}`,
      ).bind(...binds).all();
      return results;
    };
    const custWhere = cid === 'none' ? 'AND x.customer_id IS NULL' : cid ? 'AND x.customer_id = ?' : '';
    const custBind = cid && cid !== 'none' ? [toInt(cid, '客戶')] : [];
    const supWhere = sid ? 'AND x.supplier_id = ?' : '';
    const supBind = sid ? [toInt(sid, '供應商')] : [];
    const docs = [];
    if (dir === '入帳') {
      docs.push(...await query('sales', 'pay', custWhere, custBind));
      if (!cid) docs.push(...await query('purchases', 'refund', supWhere, supBind));
    } else {
      if (!cid) docs.push(...await query('purchases', 'pay', supWhere, supBind));
      if (sp.get('include_expenses') !== '0' && !sid && !cid) docs.push(...await query('expenses', 'pay', '', []));
      if (!sid) docs.push(...await query('sales', 'refund', custWhere, custBind));
    }
    for (const d of docs) {
      d.total = round(d.total); d.paid = round(d.paid); d.mine = round(d.mine); d.remaining = round(Math.max(0, d.remaining));
      d.label = d.kind === 'refund' ? (d.doc_type === 'sales' ? '退款給客戶' : '供應商退款') : DOCS[d.doc_type].label;
    }
    return json({ data: docs });
  }

  // ---- 各帳戶餘額 ----
  if (id === 'balances' && method === 'GET') {
    const asOf = sp.get('as_of') || null;
    if (asOf && !isDate(asOf)) throw new HttpError(400, '日期格式錯誤');
    const data = await balances(db, asOf);
    return json({ as_of: asOf, data, total: round(data.reduce((s, r) => s + r.balance, 0)) });
  }

  // ---- 收支查詢（日期區間、帳戶、類別、方向、沖帳狀況）----
  //   指定單一帳戶時回傳期初餘額、期末餘額與每筆之後的餘額（依日期由舊到新）
  if (!id && method === 'GET') {
    const { from, to } = dateRange(url);
    const where = [];
    const binds = [];
    if (from) { where.push('t.txn_date >= ?'); binds.push(from); }
    if (to) { where.push('t.txn_date <= ?'); binds.push(to); }
    const accId = sp.get('account_id') ? toInt(sp.get('account_id'), '帳戶') : null;
    if (accId) { where.push('t.account_id = ?'); binds.push(accId); }
    if (sp.get('category')) { where.push('t.category = ?'); binds.push(sp.get('category')); }
    if (sp.get('direction')) { where.push('t.direction = ?'); binds.push(sp.get('direction')); }
    if (sp.get('customer_id')) { where.push('t.customer_id = ?'); binds.push(toInt(sp.get('customer_id'), '客戶')); }
    if (sp.get('supplier_id')) { where.push('t.supplier_id = ?'); binds.push(toInt(sp.get('supplier_id'), '供應商')); }
    const { results } = await db.prepare(
      `SELECT t.*, a.account_name, o.account_id AS transfer_account_id, oa.account_name AS transfer_account_name,
              COALESCE((SELECT SUM(x.amount) FROM payment_allocations x WHERE x.txn_id = t.txn_id), 0) AS allocated,
              (SELECT GROUP_CONCAT(COALESCE(s.sale_no, p.purchase_no, e.expense_no), '、')
                 FROM payment_allocations x
                 LEFT JOIN sales s ON x.doc_type = 'sales' AND s.sale_id = x.doc_id
                 LEFT JOIN purchases p ON x.doc_type = 'purchases' AND p.purchase_id = x.doc_id
                 LEFT JOIN expenses e ON x.doc_type = 'expenses' AND e.expense_id = x.doc_id
                 WHERE x.txn_id = t.txn_id) AS doc_nos
       FROM bank_transactions t
       JOIN bank_accounts a ON a.account_id = t.account_id
       LEFT JOIN bank_transactions o ON o.txn_id = t.transfer_txn_id
       LEFT JOIN bank_accounts oa ON oa.account_id = o.account_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY t.txn_date, t.txn_id
       LIMIT 5000`,
    ).bind(...binds).all();
    for (const r of results) { r.allocated = round(r.allocated); r.unallocated = round(r.amount - r.allocated); }
    const alloc = sp.get('alloc'); // open：只看還沒沖完的收款／付款
    const data = alloc === 'open' ? results.filter((r) => r.category !== '轉帳' && r.unallocated > EPS && ['銷貨收款', '進貨付款', '費用'].includes(r.category)) : results;
    const summary = {
      count: data.length,
      in_amount: round(data.filter((r) => r.direction === '入帳').reduce((s, r) => s + r.amount, 0)),
      out_amount: round(data.filter((r) => r.direction === '出帳').reduce((s, r) => s + r.amount, 0)),
    };
    if (accId) {
      const acc = await getAccount(db, accId);
      let bal = await balanceBefore(db, acc, from);
      summary.opening_balance = bal;
      for (const r of data) { bal = round(bal + (r.direction === '入帳' ? r.amount : -r.amount)); r.balance = bal; }
      // 有其他篩選（類別、方向…）時逐筆餘額不完整，期末餘額另外算
      const filtered = !!(alloc || sp.get('category') || sp.get('direction') || sp.get('customer_id') || sp.get('supplier_id'));
      summary.closing_balance = filtered ? await balanceBefore(db, acc, to ? dayAfter(to) : null) : bal;
      summary.running_balance = !filtered;
    }
    return json({ from, to, data, summary });
  }

  // ---- 新增 ----
  if (!id && method === 'POST') {
    const body = await readJson(request);
    // 帳戶互轉：出帳（來源）＋ 入帳（目的）
    if (body.category === '轉帳') {
      const from = await getAccount(db, body.account_id, '轉出帳戶');
      const toAcc = await getAccount(db, body.to_account_id, '轉入帳戶');
      if (from.account_id === toAcc.account_id) throw new HttpError(400, '轉出與轉入帳戶不可相同');
      if (!isDate(body.txn_date)) throw new HttpError(400, '交易日期格式錯誤（YYYY-MM-DD）');
      checkOpeningDate(from, body.txn_date); checkOpeningDate(toAcc, body.txn_date);
      const amount = amountOf(body.amount);
      const description = (body.description || '').trim() || null;
      const { nos, ymd, last } = await nextNos(db, body.txn_date, 2);
      const base = { txn_date: body.txn_date, amount, category: '轉帳', description, bank_ref_no: (body.bank_ref_no || '').trim() || null };
      await db.batch([
        insertTxn(db, nos[0], { ...base, account_id: from.account_id, direction: '出帳', counterparty: toAcc.account_name }, user),
        insertTxn(db, nos[1], { ...base, account_id: toAcc.account_id, direction: '入帳', counterparty: from.account_name }, user, nos[0]),
        db.prepare('UPDATE bank_transactions SET transfer_txn_id = (SELECT txn_id FROM bank_transactions WHERE txn_no = ?) WHERE txn_no = ?').bind(nos[1], nos[0]),
        seqStatement(db, 'T', ymd, last),
      ]);
      const row = await db.prepare('SELECT txn_id FROM bank_transactions WHERE txn_no = ?').bind(nos[0]).first();
      return json({ data: await getTxn(db, row.txn_id) }, 201);
    }
    const p = await prepare(db, body);
    const { nos, ymd, last } = await nextNos(db, p.row.txn_date, 1);
    await db.batch([
      insertTxn(db, nos[0], p.row, user),
      ...allocStatements(db, nos[0], p.allocations),
      ...statusStatements(db, p.allocations),
      seqStatement(db, 'T', ymd, last),
    ]);
    const row = await db.prepare('SELECT txn_id FROM bank_transactions WHERE txn_no = ?').bind(nos[0]).first();
    return json({ data: await getTxn(db, row.txn_id) }, 201);
  }

  if (!id) throw new HttpError(405, '不支援的操作');
  const tid = toInt(id, '收支');
  if (method === 'GET') return json({ data: await getTxn(db, tid) });

  // ---- 修改 ----
  if (method === 'PUT') {
    const cur = await getTxn(db, tid);
    const body = await readJson(request);
    if (cur.transfer_txn_id) {
      // 帳戶互轉：兩筆一起改（日期、金額、帳戶、摘要）
      const isOut = cur.direction === '出帳';
      const fromId = body.account_id ?? (isOut ? cur.account_id : cur.transfer_account_id);
      const toId = body.to_account_id ?? (isOut ? cur.transfer_account_id : cur.account_id);
      const from = await getAccount(db, fromId, '轉出帳戶');
      const toAcc = await getAccount(db, toId, '轉入帳戶');
      if (from.account_id === toAcc.account_id) throw new HttpError(400, '轉出與轉入帳戶不可相同');
      if (!isDate(body.txn_date)) throw new HttpError(400, '交易日期格式錯誤（YYYY-MM-DD）');
      checkOpeningDate(from, body.txn_date); checkOpeningDate(toAcc, body.txn_date);
      const amount = amountOf(body.amount);
      const description = (body.description || '').trim() || null;
      const outId = isOut ? cur.txn_id : cur.transfer_txn_id;
      const inId = isOut ? cur.transfer_txn_id : cur.txn_id;
      const upd = 'UPDATE bank_transactions SET account_id = ?, txn_date = ?, amount = ?, counterparty = ?, description = ?, updated_at = ? WHERE txn_id = ?';
      await db.batch([
        db.prepare(upd).bind(from.account_id, body.txn_date, amount, toAcc.account_name, description, nowTW(), outId),
        db.prepare(upd).bind(toAcc.account_id, body.txn_date, amount, from.account_name, description, nowTW(), inId),
      ]);
      return json({ data: await getTxn(db, tid) });
    }
    if (body.category === '轉帳') throw new HttpError(400, '一般收支不能改成帳戶互轉，請刪除後重新登錄');
    const p = await prepare(db, body, { excludeTxnId: tid });
    await db.batch([
      db.prepare(`UPDATE bank_transactions SET ${COLS.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE txn_id = ?`)
        .bind(...COLS.map((c) => p.row[c] ?? null), nowTW(), tid),
      db.prepare('DELETE FROM payment_allocations WHERE txn_id = ?').bind(tid),
      ...allocStatements(db, cur.txn_no, p.allocations),
      ...statusStatements(db, cur.allocations, p.allocations),
    ]);
    return json({ data: await getTxn(db, tid) });
  }

  // ---- 刪除（互轉兩筆一起刪；沖帳一併刪除並重算單據狀態）----
  if (method === 'DELETE') {
    const cur = await getTxn(db, tid);
    const ids = [tid, cur.transfer_txn_id].filter(Boolean);
    await db.batch([
      db.prepare(`DELETE FROM payment_allocations WHERE txn_id IN (${ids.map(() => '?').join(',')})`).bind(...ids),
      db.prepare(`UPDATE bank_transactions SET transfer_txn_id = NULL WHERE txn_id IN (${ids.map(() => '?').join(',')})`).bind(...ids),
      db.prepare(`DELETE FROM bank_transactions WHERE txn_id IN (${ids.map(() => '?').join(',')})`).bind(...ids),
      ...statusStatements(db, cur.allocations),
    ]);
    return json({ ok: true });
  }

  throw new HttpError(405, '不支援的操作');
}

function dayAfter(d) {
  const t = new Date(d + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}
