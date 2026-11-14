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

export async function handleApi(request, env) {
  try {
    if (!env.DB) throw new HttpError(500, '尚未綁定 D1 資料庫（binding 名稱須為 DB）');
    const user = await authenticate(request, env);
    const url = new URL(request.url);
    const [, , resource, id, extra] = url.pathname.replace(/\/+$/, '').split('/'); // /api/<resource>/<id>
    if (extra) throw new HttpError(404, '找不到此路徑');

    if (resource === 'me') return json({ data: { email: user } });
    if (resources[resource]) return await handleMaster(resource, id, request, env);
    if (resource === 'purchases') return await handlePurchases(id, request, env, user);
    if (resource === 'sales') return await handleSales(id, request, env, user);
    if (resource === 'roast-batches') return await handleRoasts(id, request, env, user);
    if (resource === 'opening-stock') return await handleOpening(id, request, env, user);
    if (resource === 'inventory') return await handleInventory(id, request, env);
    throw new HttpError(404, '找不到此路徑');
  } catch (err) {
    return errorResponse(err);
  }
}
