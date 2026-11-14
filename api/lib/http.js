// 共用 HTTP 工具

export class HttpError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export function errorResponse(err) {
  if (err instanceof HttpError) {
    return json({ error: err.message, detail: err.detail ?? null }, err.status);
  }
  const msg = String(err?.message || err);
  // D1 / SQLite 常見錯誤轉成中文訊息
  if (/UNIQUE constraint failed/i.test(msg)) {
    return json({ error: '資料重複（編號或料號已存在）', detail: msg }, 409);
  }
  if (/FOREIGN KEY constraint failed/i.test(msg)) {
    return json({ error: '關聯資料不存在或仍被使用', detail: msg }, 409);
  }
  if (/CHECK constraint failed/i.test(msg)) {
    return json({ error: '欄位值不符合規則', detail: msg }, 400);
  }
  console.error(err);
  return json({ error: '伺服器錯誤', detail: msg }, 500);
}

export async function readJson(request) {
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HttpError(400, '請求內容必須是 JSON 物件');
  }
}

export function toInt(v, name = 'id') {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${name} 格式錯誤`);
  return n;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** 台灣時間今天 YYYY-MM-DD */
export function todayTW() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 台灣時間現在 YYYY-MM-DD HH:MM:SS */
export function nowTW() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

/** 讀取並檢查日期區間參數 from / to */
export function dateRange(url) {
  const from = url.searchParams.get('from') || null;
  const to = url.searchParams.get('to') || null;
  if (from && !isDate(from)) throw new HttpError(400, '起日格式錯誤，請用 YYYY-MM-DD');
  if (to && !isDate(to)) throw new HttpError(400, '迄日格式錯誤，請用 YYYY-MM-DD');
  if (from && to && from > to) throw new HttpError(400, '起日不可晚於迄日');
  return { from, to };
}

export const round = (n, d = 2) => {
  const f = 10 ** d;
  return Math.round((Number(n) + Number.EPSILON) * f) / f;
};
