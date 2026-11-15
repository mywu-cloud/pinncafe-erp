// 銀行對帳
//   1. 每個帳戶設定一次 CSV 欄位對應（哪一欄是日期／存入／支出／摘要／序號／餘額），存在 bank_import_profiles
//   2. 前端讀 CSV（支援 UTF-8／Big5）依對應轉成明細後送來匯入；以 dedupe_key 避免重複匯入
//   3. 自動配對建議：同帳戶、同方向、金額相同、日期相差 ≤ 5 天的「未對帳」收支；銀行序號相同優先
//   4. 確認配對 → 對帳單明細「已對帳」、收支 reconciled = 1；已對帳的收支不能改金額、日期、帳戶、方向或刪除
//   5. 對帳單上有、系統沒有的 → 前端「建立收支」後再配對；不需要的明細可標「忽略」
// 路徑：/api/reconcile/{account_id}[/profile｜/import｜/match｜/unmatch｜/ignore｜/mark｜/lines]

import { HttpError, json, readJson, toInt, isDate, dateRange, round } from '../lib/http.js';
import { balances } from './bank.js';

const MATCH_DAYS = 5;
const days = (a, b) => Math.abs(Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000;

async function accountOf(db, id) {
  const a = await db.prepare('SELECT * FROM bank_accounts WHERE account_id = ?').bind(toInt(id, '帳戶')).first();
  if (!a) throw new HttpError(404, '帳戶不存在');
  return a;
}

function suggest(lines, txns) {
  const used = new Set();
  const out = [];
  for (const l of lines.filter((x) => x.status === '未對帳')) {
    const cands = txns.filter((t) => !used.has(t.txn_id) && t.direction === l.direction && Math.abs(t.amount - l.amount) < 0.005 && days(t.txn_date, l.txn_date) <= MATCH_DAYS);
    if (!cands.length) continue;
    cands.sort((a, b) => (Number(!!l.ref_no && b.bank_ref_no === l.ref_no) - Number(!!l.ref_no && a.bank_ref_no === l.ref_no)) || days(a.txn_date, l.txn_date) - days(b.txn_date, l.txn_date));
    used.add(cands[0].txn_id);
    out.push({ line_id: l.line_id, txn_id: cands[0].txn_id, exact: days(cands[0].txn_date, l.txn_date) === 0 });
  }
  return out;
}

export async function handleReconcile(id, sub, request, env, user) {
  const db = env.DB;
  const method = request.method;
  if (!id) {
    // 各帳戶對帳概況
    if (method !== 'GET') throw new HttpError(405, '不支援的操作');
    const { results } = await db.prepare(
      `SELECT a.account_id, a.account_name, a.account_type,
              (SELECT COUNT(*) FROM bank_transactions t WHERE t.account_id = a.account_id AND t.reconciled = 0) AS open_txns,
              (SELECT COUNT(*) FROM bank_statement_lines l WHERE l.account_id = a.account_id AND l.status = '未對帳') AS open_lines,
              (SELECT MAX(txn_date) FROM bank_statement_lines l WHERE l.account_id = a.account_id) AS last_statement_date,
              (SELECT MAX(txn_date) FROM bank_transactions t WHERE t.account_id = a.account_id AND t.reconciled = 1) AS last_reconciled_date
       FROM bank_accounts a WHERE a.is_active = 1 ORDER BY a.account_id`,
    ).all();
    return json({ data: results });
  }
  const acc = await accountOf(db, id);
  const aid = acc.account_id;

  if (sub === 'profile') {
    if (method === 'GET') {
      const r = await db.prepare('SELECT mapping FROM bank_import_profiles WHERE account_id = ?').bind(aid).first();
      return json({ data: r ? JSON.parse(r.mapping) : null });
    }
    if (method === 'PUT') {
      const body = await readJson(request);
      await db.prepare(
        `INSERT INTO bank_import_profiles (account_id, mapping) VALUES (?, ?)
         ON CONFLICT(account_id) DO UPDATE SET mapping = excluded.mapping, updated_at = datetime('now','+8 hours')`,
      ).bind(aid, JSON.stringify(body.mapping || {})).run();
      return json({ ok: true });
    }
  }

  if (sub === 'import' && method === 'POST') {
    const body = await readJson(request);
    const lines = Array.isArray(body.lines) ? body.lines : [];
    if (!lines.length) throw new HttpError(400, '沒有可匯入的明細');
    if (lines.length > 3000) throw new HttpError(400, '一次最多匯入 3000 筆');
    const batch = body.batch || new Date().toISOString();
    const stmts = [];
    const seen = new Map();
    for (const [i, l] of lines.entries()) {
      const line = i + 1;
      if (!isDate(l.txn_date)) throw new HttpError(400, `第 ${line} 筆：日期無法辨識（${l.txn_date ?? ''}），請檢查日期欄位與格式`);
      if (!['入帳', '出帳'].includes(l.direction)) throw new HttpError(400, `第 ${line} 筆：無法判斷存入或支出`);
      const amount = round(Number(l.amount));
      if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, `第 ${line} 筆：金額錯誤`);
      const desc = String(l.description ?? '').trim().slice(0, 300) || null;
      const ref = String(l.ref_no ?? '').trim().slice(0, 100) || null;
      const balance = l.balance === '' || l.balance === null || l.balance === undefined || !Number.isFinite(Number(l.balance)) ? null : round(Number(l.balance));
      // 防重複：日期＋方向＋金額＋（序號，沒有序號用摘要＋餘額）；同一份檔案內完全相同的明細加流水號
      let key = [l.txn_date, l.direction, amount.toFixed(2), ref || `${desc || ''}|${balance ?? ''}`].join('|');
      const n = (seen.get(key) || 0) + 1;
      seen.set(key, n);
      if (n > 1) key += `#${n}`;
      stmts.push(db.prepare(
        `INSERT OR IGNORE INTO bank_statement_lines (account_id, txn_date, direction, amount, description, ref_no, balance, dedupe_key, import_batch, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(aid, l.txn_date, l.direction, amount, desc, ref, balance, key, batch, user));
    }
    const res = await db.batch(stmts);
    const inserted = res.reduce((s, r) => s + (r.meta?.changes || 0), 0);
    return json({ inserted, skipped: lines.length - inserted, batch });
  }

  if (sub === 'match' && method === 'POST') {
    const body = await readJson(request);
    const pairs = Array.isArray(body.pairs) ? body.pairs : [];
    if (!pairs.length) throw new HttpError(400, '沒有要配對的明細');
    const stmts = [];
    const usedTxn = new Set();
    for (const p of pairs) {
      const l = await db.prepare('SELECT * FROM bank_statement_lines WHERE line_id = ? AND account_id = ?').bind(toInt(p.line_id, '對帳單明細'), aid).first();
      const t = await db.prepare('SELECT * FROM bank_transactions WHERE txn_id = ? AND account_id = ?').bind(toInt(p.txn_id, '收支'), aid).first();
      if (!l || !t) throw new HttpError(400, '明細或收支不屬於這個帳戶');
      if (l.status !== '未對帳') throw new HttpError(409, `對帳單明細（${l.txn_date} ${l.amount}）已經處理過`);
      if (t.reconciled || usedTxn.has(t.txn_id)) throw new HttpError(409, `收支 ${t.txn_no} 已經對帳`);
      if (l.direction !== t.direction || Math.abs(l.amount - t.amount) >= 0.005) throw new HttpError(400, `收支 ${t.txn_no}（${t.direction} ${t.amount}）與對帳單（${l.direction} ${l.amount}）方向或金額不同`);
      usedTxn.add(t.txn_id);
      stmts.push(db.prepare("UPDATE bank_statement_lines SET status = '已對帳', matched_txn_id = ? WHERE line_id = ?").bind(t.txn_id, l.line_id));
      stmts.push(db.prepare('UPDATE bank_transactions SET reconciled = 1 WHERE txn_id = ?').bind(t.txn_id));
    }
    await db.batch(stmts);
    return json({ ok: true, matched: pairs.length });
  }

  if (sub === 'unmatch' && method === 'POST') {
    const body = await readJson(request);
    const stmts = [];
    if (body.line_id) {
      const l = await db.prepare('SELECT * FROM bank_statement_lines WHERE line_id = ? AND account_id = ?').bind(toInt(body.line_id, '明細'), aid).first();
      if (!l) throw new HttpError(404, '找不到明細');
      if (l.matched_txn_id) stmts.push(db.prepare('UPDATE bank_transactions SET reconciled = 0 WHERE txn_id = ?').bind(l.matched_txn_id));
      stmts.push(db.prepare("UPDATE bank_statement_lines SET status = '未對帳', matched_txn_id = NULL WHERE line_id = ?").bind(l.line_id));
    } else if (body.txn_id) {
      const tid = toInt(body.txn_id, '收支');
      stmts.push(db.prepare('UPDATE bank_transactions SET reconciled = 0 WHERE txn_id = ? AND account_id = ?').bind(tid, aid));
      stmts.push(db.prepare("UPDATE bank_statement_lines SET status = '未對帳', matched_txn_id = NULL WHERE matched_txn_id = ?").bind(tid));
    } else throw new HttpError(400, '請指定 line_id 或 txn_id');
    await db.batch(stmts);
    return json({ ok: true });
  }

  if (sub === 'ignore' && method === 'POST') {
    const body = await readJson(request);
    const l = await db.prepare('SELECT * FROM bank_statement_lines WHERE line_id = ? AND account_id = ?').bind(toInt(body.line_id, '明細'), aid).first();
    if (!l) throw new HttpError(404, '找不到明細');
    if (l.status === '已對帳') throw new HttpError(409, '已對帳的明細請先取消配對');
    await db.prepare('UPDATE bank_statement_lines SET status = ? WHERE line_id = ?').bind(body.ignore === false ? '未對帳' : '忽略', l.line_id).run();
    return json({ ok: true });
  }

  // 沒有對帳單的帳戶（例：現金）直接標記收支已核對
  if (sub === 'mark' && method === 'POST') {
    const body = await readJson(request);
    const ids = (Array.isArray(body.txn_ids) ? body.txn_ids : [body.txn_id]).map(Number).filter(Boolean);
    if (!ids.length) throw new HttpError(400, '請指定收支');
    const val = body.reconciled === false ? 0 : 1;
    await db.batch(ids.map((t) => db.prepare('UPDATE bank_transactions SET reconciled = ? WHERE txn_id = ? AND account_id = ?').bind(val, t, aid)));
    return json({ ok: true });
  }

  if (sub === 'lines' && method === 'DELETE') {
    // 刪除未對帳的明細（匯入錯誤時用）；可指定 batch
    const sp = new URL(request.url).searchParams;
    const batch = sp.get('batch');
    const r = await db.prepare(`DELETE FROM bank_statement_lines WHERE account_id = ? AND status <> '已對帳' ${batch ? 'AND import_batch = ?' : sp.get('line_id') ? 'AND line_id = ?' : ''}`)
      .bind(aid, ...(batch ? [batch] : sp.get('line_id') ? [toInt(sp.get('line_id'), '明細')] : [])).run();
    return json({ ok: true, deleted: r.meta.changes });
  }

  if (!sub && method === 'GET') {
    const url = new URL(request.url);
    const { from, to } = dateRange(url);
    const w = ['account_id = ?'];
    const b = [aid];
    if (from) { w.push('txn_date >= ?'); b.push(from); }
    if (to) { w.push('txn_date <= ?'); b.push(to); }
    const { results: lines } = await db.prepare(
      `SELECT l.*, t.txn_no AS matched_txn_no FROM bank_statement_lines l LEFT JOIN bank_transactions t ON t.txn_id = l.matched_txn_id
       WHERE ${w.map((x) => 'l.' + x).join(' AND ')} ORDER BY l.txn_date, l.line_id`,
    ).bind(...b).all();
    // 系統收支：區間內全部 ＋ 區間外前後 MATCH_DAYS 天未對帳的（給配對用）
    const pad = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
    const { results: txns } = await db.prepare(
      `SELECT t.txn_id, t.txn_no, t.txn_date, t.direction, t.amount, t.category, t.counterparty, t.description, t.bank_ref_no, t.reconciled
       FROM bank_transactions t WHERE t.account_id = ? ${from ? 'AND t.txn_date >= ?' : ''} ${to ? 'AND t.txn_date <= ?' : ''}
       ORDER BY t.txn_date, t.txn_id`,
    ).bind(aid, ...(from ? [pad(from, -MATCH_DAYS)] : []), ...(to ? [pad(to, MATCH_DAYS)] : [])).all();
    const open = txns.filter((t) => !t.reconciled);
    const suggestions = suggest(lines, open);
    const lastWithBal = [...lines].reverse().find((l) => l.balance !== null);
    let check = null;
    if (lastWithBal) {
      const bal = (await balances(db, lastWithBal.txn_date)).find((x) => x.account_id === aid);
      check = { date: lastWithBal.txn_date, statement_balance: lastWithBal.balance, system_balance: bal?.balance ?? null, diff: bal ? round(lastWithBal.balance - bal.balance) : null };
    }
    const inRange = (t) => (!from || t.txn_date >= from) && (!to || t.txn_date <= to);
    return json({
      account: acc, from, to, lines, txns: txns.filter((t) => inRange(t) || !t.reconciled), suggestions, check,
      summary: {
        lines: lines.length, matched: lines.filter((l) => l.status === '已對帳').length, ignored: lines.filter((l) => l.status === '忽略').length,
        open_lines: lines.filter((l) => l.status === '未對帳').length, open_txns: txns.filter((t) => inRange(t) && !t.reconciled).length,
      },
    });
  }
  throw new HttpError(405, '不支援的操作');
}
