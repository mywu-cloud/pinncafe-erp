// 收付款狀態：一律由 payment_allocations（沖帳）加總決定，不手動修改
//   銷貨：未收／部分收款／已收清；進貨、費用：未付／部分付款／已付清
//
//   Phase 4 起：
//   * 單據淨額 = 原單合計 − 退貨／折讓（銷貨單扣銷貨退回＋銷貨折讓；進貨單扣進貨退出）
//   * 已收（付）= 正向沖帳 − 退款沖帳
//       銷貨單：入帳沖帳 = 收款、出帳沖帳 = 退款給客戶
//       進貨單：出帳沖帳 = 付款、入帳沖帳 = 供應商退款
//   * 已收（付）> 淨額 → 應退款（銷貨單 = 應退客戶；進貨單 = 供應商應退）
//   淨額為 0 的單據直接視為已收清／已付清。

import { round } from './http.js';

export const DOCS = {
  sales: { table: 'sales', pk: 'sale_id', no: 'sale_no', date: 'sale_date', label: '銷貨單', status: ['未收', '部分收款', '已收清'], payDir: '入帳', returns: "'銷貨退回','銷貨折讓'", returnKey: 'sale_id' },
  purchases: { table: 'purchases', pk: 'purchase_id', no: 'purchase_no', date: 'purchase_date', label: '進貨單', status: ['未付', '部分付款', '已付清'], payDir: '出帳', returns: "'進貨退出'", returnKey: 'purchase_id' },
  expenses: { table: 'expenses', pk: 'expense_id', no: 'expense_no', date: 'expense_date', label: '費用', amount: 'amount', status: ['未付', '部分付款', '已付清'], payDir: '出帳' },
};
export const totalCol = (d) => d.amount || 'total_amount';

/** 退貨／折讓合計 SQL（pkExpr 為單據主鍵運算式） */
export function returnsExpr(docType, pkExpr) {
  const d = DOCS[docType];
  if (!d.returns) return '0';
  return `COALESCE((SELECT SUM(r.total_amount) FROM returns r WHERE r.${d.returnKey} = ${pkExpr} AND r.return_type IN (${d.returns})), 0)`;
}

/** 淨額 SQL（alias 為單據資料表別名） */
export function netExpr(docType, alias) {
  const d = DOCS[docType];
  return `(${alias}.${totalCol(d)} - ${returnsExpr(docType, `${alias}.${d.pk}`)})`;
}

/**
 * 已收（付）淨額 SQL：正向沖帳 − 退款沖帳
 *   opts.asOf：只算收支日期 ≤ 這個參數（傳 SQL 參數占位，如 '?1'）
 *   opts.excludeTxn：排除某筆收支（SQL 運算式或數字）
 */
export function paidExpr(docType, pkExpr, { asOf = null, excludeTxn = null } = {}) {
  const d = DOCS[docType];
  return `COALESCE((SELECT SUM(CASE WHEN t.direction = '${d.payDir}' THEN a.amount ELSE -a.amount END)
            FROM payment_allocations a JOIN bank_transactions t ON t.txn_id = a.txn_id
            WHERE a.doc_type = '${docType}' AND a.doc_id = ${pkExpr}
            ${asOf ? `AND t.txn_date <= ${asOf}` : ''}
            ${excludeTxn !== null ? `AND a.txn_id <> ${excludeTxn}` : ''}), 0)`;
}

/** 重算單據收付款狀態的 UPDATE 語句（ids 省略 = 整張表） */
export function statusStatement(db, docType, ids = null) {
  const d = DOCS[docType];
  const [none, part, full] = d.status;
  const paid = paidExpr(docType, `${d.table}.${d.pk}`);
  const net = netExpr(docType, d.table);
  const list = ids ? [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))] : null;
  if (list && !list.length) return null;
  return db.prepare(
    `UPDATE ${d.table} SET payment_status = CASE
       WHEN ${net} <= 0.005 THEN '${full}'
       WHEN ${paid} <= 0.005 THEN '${none}'
       WHEN ${paid} + 0.005 >= ${net} THEN '${full}'
       ELSE '${part}' END
     ${list ? `WHERE ${d.pk} IN (${list.map(() => '?').join(',')})` : ''}`,
  ).bind(...(list || []));
}

/** 單據目前的淨額、已收付、退貨（excludeTxnId：排除某筆收支的沖帳） */
export async function docBalance(db, docType, id, excludeTxnId = null) {
  const d = DOCS[docType];
  const r = await db.prepare(
    `SELECT ${d.no} AS no, ${totalCol(d)} AS total, ${returnsExpr(docType, `x.${d.pk}`)} AS returned,
            ${paidExpr(docType, `x.${d.pk}`, { excludeTxn: excludeTxnId === null ? null : Number(excludeTxnId) })} AS paid
     FROM ${d.table} x WHERE x.${d.pk} = ?`,
  ).bind(id).first();
  if (!r) return null;
  r.returned = round(r.returned);
  r.net = round(r.total - r.returned);
  r.paid = round(r.paid);
  r.remaining = round(r.net - r.paid);     // > 0：尚未收付
  r.refundable = round(r.paid - r.net);    // > 0：應退款
  return r;
}

/** 單據的沖帳明細與已收付淨額（含退款） */
export async function docPayments(db, docType, id) {
  const d = DOCS[docType];
  const { results } = await db.prepare(
    `SELECT a.allocation_id, a.amount, t.txn_id, t.txn_no, t.txn_date, t.direction, ba.account_name,
            CASE WHEN t.direction = '${d.payDir}' THEN 0 ELSE 1 END AS is_refund
     FROM payment_allocations a
     JOIN bank_transactions t ON t.txn_id = a.txn_id
     JOIN bank_accounts ba ON ba.account_id = t.account_id
     WHERE a.doc_type = ? AND a.doc_id = ? ORDER BY t.txn_date, t.txn_id`,
  ).bind(docType, id).all();
  const paid = results.reduce((s, r) => s + (r.is_refund ? -r.amount : r.amount), 0);
  return { payments: results, paid_amount: round(paid) };
}

/** 單據的退貨／折讓清單與合計 */
export async function docReturns(db, docType, id) {
  const d = DOCS[docType];
  if (!d.returns) return { returns: [], returned_amount: 0 };
  const { results } = await db.prepare(
    `SELECT return_id, return_no, return_date, return_type, total_amount, restock, reason FROM returns
     WHERE ${d.returnKey} = ? AND return_type IN (${d.returns}) ORDER BY return_date, return_id`,
  ).bind(id).all();
  return { returns: results, returned_amount: round(results.reduce((s, r) => s + r.total_amount, 0)) };
}
