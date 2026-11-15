// API 路由（由 functions/api/[[path]].js 呼叫）
//   1. Cloudflare Access 驗證 → email
//   2. users 表 → 角色（Phase 5），依角色檢查模組權限
//   3. 交給各資源處理
//   4. 新增／修改／刪除成功後寫一筆操作日誌（audit_logs），含修改前後的資料
import { HttpError, errorResponse, json } from './lib/http.js';
import { authenticate } from './lib/auth.js';
import { loadUser, assertCan, permsOf, MODULE_OF } from './lib/perm.js';
import { resources } from './master/resources.js';
import { handleMaster } from './master/crud.js';
import { handlePurchases } from './transaction/purchases.js';
import { handleSales } from './transaction/sales.js';
import { handleRoasts } from './inventory/roasts.js';
import { handleOpening } from './inventory/opening.js';
import { handleInventory } from './inventory/stock.js';
import { handleBank } from './finance/bank.js';
import { handleInvoices } from './finance/invoices.js';
import { handleReturns } from './transaction/returns.js';
import { handleSubscriptions } from './transaction/subscriptions.js';
import { handleCounts } from './inventory/counts.js';
import { handleRecipes } from './master/recipes.js';
import { handleExpenses } from './finance/expenses.js';
import { handleFinance } from './finance/reports.js';
import { handleReconcile } from './finance/reconcile.js';
import { handleBankCodes, handleSupplierAccounts } from './master/bankaccounts.js';
import { handleReports } from './reports/reports.js';
import { handleUsers, handleAuditLogs } from './system/users.js';
import { handleImport, handleBackup } from './system/data.js';

const SUBPATH_OK = new Set(['invoices', 'reconcile', 'import']);

async function route(request, env, user) {
  const url = new URL(request.url);
  const [, , resource, id, extra] = url.pathname.replace(/\/+$/, '').split('/'); // /api/<resource>/<id>[/<extra>]
  if (extra && !SUBPATH_OK.has(resource)) throw new HttpError(404, '找不到此路徑');
  const email = user.email;

  if (resource === 'me') return json({ data: { email, name: user.name, role: user.role, user_id: user.user_id, ...permsOf(user.role), modules: MODULE_OF } });
  if (resources[resource]) return handleMaster(resource, id, request, env);
  if (resource === 'purchases') return handlePurchases(id, request, env, email);
  if (resource === 'sales') return handleSales(id, request, env, email);
  if (resource === 'roast-batches') return handleRoasts(id, request, env, email);
  if (resource === 'opening-stock') return handleOpening(id, request, env, email);
  if (resource === 'returns') return handleReturns(id, request, env, email);
  if (resource === 'invoices') return handleInvoices(id, extra, request, env, email);
  if (resource === 'subscriptions') return handleSubscriptions(id, request, env, email);
  if (resource === 'stock-counts') return handleCounts(id, request, env, email);
  if (resource === 'recipes') return handleRecipes(id, request, env);
  if (resource === 'bank-transactions') return handleBank(id, request, env, email);
  if (resource === 'expenses') return handleExpenses(id, request, env, email);
  if (resource === 'finance') return handleFinance(id, request, env);
  if (resource === 'reconcile') return handleReconcile(id, extra, request, env, email);
  if (resource === 'bank-codes') return handleBankCodes(id, request, env);
  if (resource === 'supplier-accounts') return handleSupplierAccounts(id, request, env);
  if (resource === 'inventory') return handleInventory(id, request, env);
  if (resource === 'reports') return handleReports(id, request, env);
  if (resource === 'users') return handleUsers(id, request, env, user);
  if (resource === 'audit-logs') return handleAuditLogs(id, request, env);
  if (resource === 'import') return handleImport(id, extra, request, env, user);
  if (resource === 'backup') return handleBackup(request, env);
  throw new HttpError(404, '找不到此路徑');
}

// ---------------------------------------------------------------- 操作日誌
const MAX_JSON = 60_000;
const clip = (v) => {
  if (v === null || v === undefined) return null;
  const s = JSON.stringify(v);
  return s.length > MAX_JSON ? s.slice(0, MAX_JSON) + '…(截斷)' : s;
};
const pickId = (d) => {
  if (!d || typeof d !== 'object') return null;
  const k = Object.keys(d).find((x) => x.endsWith('_id'));
  return k ? String(d[k]) : null;
};
const pickSummary = (d) => {
  if (!d || typeof d !== 'object') return null;
  const k = Object.keys(d).find((x) => x.endsWith('_no'));
  return (k && d[k]) || d.name || d.account_name || d.email || null;
};

async function withAudit(request, env, user) {
  const url = new URL(request.url);
  const [, , resource, id] = url.pathname.replace(/\/+$/, '').split('/');
  const method = request.method;
  if (method === 'GET' || resource === 'me') return route(request, env, user);

  // 修改前的資料：路徑帶單筆 id 時，用同一個路由先讀一次
  let before = null;
  if (id && /^[a-z]?\d+$/.test(id) && resource !== 'import') {
    try {
      const r = await route(new Request(new URL(`/api/${resource}/${id}`, url), { method: 'GET', headers: request.headers }), env, user);
      if (r.ok) before = (await r.json()).data ?? null;
    } catch { /* 讀不到就不記 before */ }
  }
  let reqBody = null;
  try { reqBody = await request.clone().json(); } catch { /* 沒有 body */ }

  const res = await route(request, env, user);
  if (!res.ok || reqBody?.dry_run) return res;
  let after = null;
  try { after = await res.clone().json(); } catch { /* 非 JSON */ }

  const action = method === 'DELETE' ? '刪除' : method === 'PUT' || method === 'PATCH' ? '修改' : method === 'POST' && !id ? '新增' : '其他';
  const data = after?.data && !Array.isArray(after.data) ? after.data : null;
  try {
    await env.DB.prepare(
      `INSERT INTO audit_logs (user_email, action, resource, record_id, method, path, summary, before_json, after_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      user.email, action, resource,
      (id && /^[a-z]?\d+$/.test(id) ? id : null) || pickId(data) || pickId(before),
      method, url.pathname,
      pickSummary(data) || pickSummary(before) || (id && !/^\d+$/.test(id) ? id : null),
      clip(before), clip(action === '刪除' ? reqBody : (data ?? after ?? reqBody)),
    ).run();
  } catch { /* 日誌寫入失敗不影響原本的操作 */ }
  return res;
}

export async function handleApi(request, env) {
  try {
    if (!env.DB) throw new HttpError(500, '尚未綁定 D1 資料庫（binding 名稱須為 DB）');
    const email = await authenticate(request, env);
    const user = await loadUser(env.DB, email);
    const url = new URL(request.url);
    const [, , resource, id] = url.pathname.replace(/\/+$/, '').split('/');
    // 匯入：依匯入目標的模組檢查寫入權限
    if (resource === 'import') {
      if (!MODULE_OF[id]) throw new HttpError(404, '這個資料不支援匯入');
      assertCan(user, id, request.method);
    }
    else assertCan(user, resource, request.method);
    return await withAudit(request, env, user);
  } catch (err) {
    return errorResponse(err);
  }
}
