// API 路由（由 functions/api/[[path]].js 呼叫）
import { HttpError, errorResponse, json } from './lib/http.js';
import { authenticate } from './lib/auth.js';
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

export async function handleApi(request, env) {
  try {
    if (!env.DB) throw new HttpError(500, '尚未綁定 D1 資料庫（binding 名稱須為 DB）');
    const user = await authenticate(request, env);
    const url = new URL(request.url);
    const [, , resource, id, extra] = url.pathname.replace(/\/+$/, '').split('/'); // /api/<resource>/<id>
    if (extra && resource !== 'invoices') throw new HttpError(404, '找不到此路徑');

    if (resource === 'me') return json({ data: { email: user } });
    if (resources[resource]) return await handleMaster(resource, id, request, env);
    if (resource === 'purchases') return await handlePurchases(id, request, env, user);
    if (resource === 'sales') return await handleSales(id, request, env, user);
    if (resource === 'roast-batches') return await handleRoasts(id, request, env, user);
    if (resource === 'opening-stock') return await handleOpening(id, request, env, user);
    if (resource === 'returns') return await handleReturns(id, request, env, user);
    if (resource === 'invoices') return await handleInvoices(id, extra, request, env, user);
    if (resource === 'subscriptions') return await handleSubscriptions(id, request, env, user);
    if (resource === 'stock-counts') return await handleCounts(id, request, env, user);
    if (resource === 'recipes') return await handleRecipes(id, request, env);
    if (resource === 'bank-transactions') return await handleBank(id, request, env, user);
    if (resource === 'expenses') return await handleExpenses(id, request, env, user);
    if (resource === 'finance') return await handleFinance(id, request, env);
    if (resource === 'inventory') return await handleInventory(id, request, env);
    throw new HttpError(404, '找不到此路徑');
  } catch (err) {
    return errorResponse(err);
  }
}
