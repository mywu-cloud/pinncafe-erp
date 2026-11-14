// 咖啡烘豆進銷存 — 後台管理（Phase 1＋2）
// 純 JavaScript，無建置步驟。顏色慣例：紅 = 增加／入庫，綠 = 減少／出庫。
'use strict';

// ---------------------------------------------------------------- 工具
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, d = 0) => (n === null || n === undefined || n === '' ? '' : Number(n).toLocaleString('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d }));
const kg = (n) => fmt(n, 2);
const money = (n) => fmt(n, 0);
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const monthStart = () => today().slice(0, 8) + '01';

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON */ }
  if (!res.ok) {
    const err = new Error(data?.error || `發生錯誤（${res.status}）`);
    err.status = res.status;
    err.detail = data?.detail ?? null; // 例：銷貨熟豆不足 { code: 'SHORTAGE', shortages }
    throw err;
  }
  return data;
}

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isErr ? 5000 : 2200);
}
const fail = (e) => toast(e.message || String(e), true);

function openModal(html, wide = false) {
  const box = $('#modalBox');
  box.className = 'modal-box' + (wide ? ' wide' : '');
  box.innerHTML = html;
  $('#modal').hidden = false;
  return box;
}
function closeModal() { $('#modal').hidden = true; $('#modalBox').innerHTML = ''; }

const qs = (obj) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== '' && v !== null && v !== undefined) p.set(k, v);
  const s = p.toString();
  return s ? '?' + s : '';
};

// 下拉選單用的主檔快取
const cache = {};
async function lookup(resource, force = false) {
  if (!cache[resource] || force) cache[resource] = (await api('/' + resource)).data;
  return cache[resource];
}
const options = (rows, idKey, selected, { blank = '（未選擇）', label = (r) => r.name } = {}) =>
  (blank === null ? '' : `<option value="">${esc(blank)}</option>`) +
  rows.filter((r) => r.is_active || r[idKey] === selected)
    .map((r) => `<option value="${r[idKey]}" ${r[idKey] === selected ? 'selected' : ''}>${esc(label(r))}</option>`).join('');

// ---------------------------------------------------------------- 主檔定義
const ROAST = ['淺焙', '中焙', '中深焙', '深焙'];
const GRIND = ['原豆', '手沖', '義式', '法壓', '冷萃'];
const MASTERS = {
  suppliers: {
    title: '供應商', pk: 'supplier_id',
    cols: [['name', '名稱'], ['contact_name', '聯絡人'], ['phone', '電話'], ['country', '國家'], ['payment_terms', '付款條件']],
    fields: [
      ['name', '名稱', 'text', { required: true }], ['tax_id', '統一編號'], ['contact_name', '聯絡人'], ['phone', '電話'],
      ['email', 'Email'], ['country', '國家'], ['payment_terms', '付款條件（現結／月結 30 天）'],
      ['address', '地址', 'text', { full: true }], ['bank_info', '匯款資訊', 'text', { full: true }], ['note', '備註', 'textarea', { full: true }],
    ],
  },
  customers: {
    title: '客戶', pk: 'customer_id',
    cols: [['name', '姓名／公司'], ['customer_type', '類型'], ['price_level', '價格等級'], ['phone', '電話'], ['payment_terms', '付款條件']],
    fields: [
      ['name', '姓名／公司名', 'text', { required: true }],
      ['customer_type', '客戶類型', 'enum', { values: ['零售', '批發', '咖啡廳', '電商'], noBlank: true }],
      ['price_level', '價格等級', 'enum', { values: ['零售價', '批發價', 'VIP'], noBlank: true }],
      ['tax_id', '統一編號'], ['phone', '電話'], ['email', 'Email'], ['line_id', 'LINE ID'],
      ['payment_terms', '付款條件（現結／月結）'], ['credit_limit', '信用額度', 'number'], ['birthday', '生日', 'date'], ['source', '客戶來源'],
      ['shipping_address', '收件地址', 'text', { full: true }], ['note', '備註', 'textarea', { full: true }],
    ],
  },
  'green-beans': {
    title: '生豆品項', pk: 'bean_id',
    cols: [['name', '品名'], ['country', '國家'], ['region', '產區'], ['process', '處理法'], ['default_supplier_name', '常用供應商'], ['safety_stock_kg', '安全庫存 kg', 'num']],
    fields: [
      ['name', '品名', 'text', { required: true, full: true }], ['country', '國家'], ['region', '產區'], ['farm', '莊園／處理廠'],
      ['process', '處理法', 'enum', { values: ['水洗', '日曬', '蜜處理', '厭氧', '其他'] }], ['variety', '品種'], ['altitude', '海拔'], ['crop_year', '產季'],
      ['cupping_score', '杯測分數', 'number'], ['default_supplier_id', '常用供應商', 'fk', { resource: 'suppliers', idKey: 'supplier_id' }],
      ['safety_stock_kg', '安全庫存量（kg）', 'number'], ['note', '備註', 'textarea', { full: true }],
    ],
  },
  'packaging-items': {
    title: '包材', pk: 'packaging_id',
    cols: [['name', '名稱'], ['unit', '單位'], ['unit_cost', '參考單價', 'num2'], ['supplier_name', '供應商'], ['safety_stock', '安全庫存', 'num']],
    fields: [
      ['name', '名稱', 'text', { required: true, full: true }], ['unit', '單位'], ['unit_cost', '參考單價', 'number'],
      ['supplier_id', '供應商', 'fk', { resource: 'suppliers', idKey: 'supplier_id' }], ['safety_stock', '安全庫存', 'number'],
      ['note', '備註', 'textarea', { full: true }],
    ],
  },
  products: {
    title: '產品', pk: 'product_id',
    cols: [['sku', '料號'], ['name', '產品名稱'], ['category', '類別'], ['roasted_bean_name', '使用熟豆'], ['net_weight_g', '淨重 g', 'num'], ['retail_price', '零售價', 'num'], ['wholesale_price', '批發價', 'num']],
    fields: [
      ['sku', '料號／條碼'], ['name', '產品名稱', 'text', { required: true }],
      ['category', '類別', 'enum', { values: ['單品豆', '綜合豆', '濾掛', '禮盒', '器具', '其他'], noBlank: true }],
      ['roasted_bean_id', '使用熟豆品項（銷貨時扣此熟豆庫存）', 'fk', { resource: 'roasted-beans', idKey: 'roasted_bean_id', blank: '不扣熟豆（器具、禮盒等）' }],
      ['net_weight_g', '每包淨重（g）', 'number'], ['roast_level', '烘焙度', 'enum', { values: ROAST }],
      ['retail_price', '零售價', 'number'], ['wholesale_price', '批發價', 'number'], ['shelf_life_days', '賞味期（天，烘焙日起算）', 'number'],
      ['note', '備註', 'textarea', { full: true }],
    ],
    hint: '同一鍋熟豆可以包成不同規格：例如「招牌綜合 250g」與「招牌綜合 1kg」都選同一個熟豆品項，銷貨時依「數量 × 每包淨重」扣熟豆庫存。',
  },
  'roasted-beans': {
    title: '熟豆品項', pk: 'roasted_bean_id',
    cols: [['name', '名稱'], ['roast_level', '烘焙度'], ['shelf_life_days', '賞味期（天）', 'num'], ['safety_stock_kg', '安全庫存 kg', 'num']],
    fields: [
      ['name', '名稱', 'text', { required: true, full: true }], ['roast_level', '烘焙度', 'enum', { values: ROAST }],
      ['shelf_life_days', '賞味期（天，烘焙日起算）', 'number'], ['safety_stock_kg', '安全庫存量（kg）', 'number'],
      ['note', '備註', 'textarea', { full: true }],
    ],
    hint: '熟豆品項 = 烘焙批次的產出（例：招牌綜合 中深焙）。建立後到「產品」主檔指定每個產品使用哪個熟豆品項。',
  },
};

// ---------------------------------------------------------------- 主檔頁
async function pageMaster(key) {
  const m = MASTERS[key];
  $('#main').innerHTML = `
    <h2>${m.title}</h2>
    <div class="toolbar">
      <label>搜尋<input id="q" placeholder="關鍵字"></label>
      <label>狀態<select id="active"><option value="1">啟用中</option><option value="">全部</option><option value="0">已停用</option></select></label>
      <button id="search">查詢</button><span class="spacer"></span>
      <button id="add" class="primary">＋ 新增${m.title}</button>
    </div>
    <div class="card"><div class="table-wrap" id="list"></div></div>`;

  const load = async () => {
    try {
      const { data } = await api(`/${key}${qs({ q: $('#q').value.trim(), active: $('#active').value })}`);
      $('#list').innerHTML = data.length ? `<table><thead><tr>${m.cols.map(([, l, t]) => `<th class="${t ? 'num' : ''}">${l}</th>`).join('')}<th>狀態</th></tr></thead><tbody>
        ${data.map((r) => `<tr class="clickable ${r.is_active ? '' : 'inactive'}" data-id="${r[m.pk]}">
          ${m.cols.map(([c, , t]) => `<td class="${t ? 'num' : ''}">${t === 'num2' ? esc(fmt(r[c], 2)) : t ? esc(fmt(r[c])) : esc(r[c])}</td>`).join('')}
          <td>${r.is_active ? '<span class="tag">啟用</span>' : '<span class="tag warn">停用</span>'}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">沒有資料</div>';
      $$('#list tr.clickable').forEach((tr) => tr.onclick = () => masterForm(key, Number(tr.dataset.id), load));
    } catch (e) { fail(e); }
  };
  $('#search').onclick = load;
  $('#q').onkeydown = (e) => e.key === 'Enter' && load();
  $('#active').onchange = load;
  $('#add').onclick = () => masterForm(key, null, load);
  load();
}

function prefRow(p = {}) {
  const sel = (name, values) => `<select data-k="${name}"><option value=""></option>${values.map((v) => `<option ${p[name] === v ? 'selected' : ''}>${v}</option>`).join('')}</select>`;
  const inp = (name) => `<input data-k="${name}" value="${esc(p[name])}">`;
  return `<tr>${[sel('roast_level', ROAST), inp('flavor_notes'), sel('grind_size', GRIND), inp('brew_method'), inp('favorite_products'), inp('dislikes'), inp('note')].map((h) => `<td>${h}</td>`).join('')}
    <td><button type="button" class="link" data-del>刪除</button></td></tr>`;
}

async function masterForm(key, id, reload) {
  const m = MASTERS[key];
  try {
    const row = id ? (await api(`/${key}/${id}`)).data : { is_active: 1 };
    const fkData = {};
    for (const [, , type, o] of m.fields) if (type === 'fk') fkData[o.resource] = await lookup(o.resource, true);

    const input = ([name, label, type = 'text', o = {}]) => {
      const v = row[name];
      let ctl;
      if (type === 'enum') ctl = `<select name="${name}">${o.noBlank ? '' : '<option value=""></option>'}${o.values.map((x) => `<option ${v === x ? 'selected' : ''}>${x}</option>`).join('')}</select>`;
      else if (type === 'fk') ctl = `<select name="${name}">${options(fkData[o.resource], o.idKey, v, o.blank ? { blank: o.blank } : {})}</select>`;
      else if (type === 'textarea') ctl = `<textarea name="${name}" rows="2">${esc(v)}</textarea>`;
      else ctl = `<input name="${name}" type="${type === 'number' ? 'number' : type}" ${type === 'number' ? 'step="any" min="0"' : ''} value="${esc(v)}" ${o.required ? 'required' : ''}>`;
      return `<label class="${o.full ? 'full' : ''}">${label}${o.required ? ' *' : ''}${ctl}</label>`;
    };

    const prefs = key === 'customers' ? `
      <div class="section-title">喜好 <button type="button" id="addPref">＋ 新增一筆</button></div>
      <div class="table-wrap"><table class="items"><thead><tr><th>烘焙度</th><th>偏好風味</th><th>研磨度</th><th>沖煮器具</th><th>常買品項</th><th>不喜歡</th><th>備註</th><th></th></tr></thead>
      <tbody id="prefs">${(row.preferences || []).map(prefRow).join('')}</tbody></table></div>` : '';

    const box = openModal(`
      <h2>${id ? '編輯' : '新增'}${m.title}</h2>
      <form id="f">
        <div class="form-grid">${m.fields.map(input).join('')}
          <label>狀態<select name="is_active"><option value="1" ${row.is_active ? 'selected' : ''}>啟用</option><option value="0" ${row.is_active ? '' : 'selected'}>停用</option></select></label>
        </div>${m.hint ? `<p class="hint">${m.hint}</p>` : ''}${prefs}
        <div class="form-actions">
          ${id ? '<button type="button" class="danger" id="del">刪除</button>' : ''}<span class="spacer"></span>
          <button type="button" id="cancel">取消</button><button class="primary">存檔</button>
        </div>
      </form>`, key === 'customers');

    $('#cancel', box).onclick = closeModal;
    if (key === 'customers') {
      $('#addPref', box).onclick = () => $('#prefs', box).insertAdjacentHTML('beforeend', prefRow());
      $('#prefs', box).onclick = (e) => e.target.matches('[data-del]') && e.target.closest('tr').remove();
    }
    $('#f', box).onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target));
      if (key === 'customers') {
        body.preferences = $$('#prefs tr', box).map((tr) => Object.fromEntries($$('[data-k]', tr).map((el) => [el.dataset.k, el.value])));
      }
      try {
        await api(id ? `/${key}/${id}` : `/${key}`, { method: id ? 'PUT' : 'POST', body });
        delete cache[key];
        closeModal(); toast('已存檔'); reload();
      } catch (err) { fail(err); }
    };
    if (id) $('#del', box).onclick = async () => {
      if (!confirm(`確定刪除這筆${m.title}？此動作無法復原。`)) return;
      try { await api(`/${key}/${id}`, { method: 'DELETE' }); delete cache[key]; closeModal(); toast('已刪除'); reload(); } catch (err) { fail(err); }
    };
  } catch (e) { fail(e); }
}

// ---------------------------------------------------------------- 進貨單
async function pagePurchases() {
  const suppliers = await lookup('suppliers', true);
  const beans = await lookup('green-beans', true);
  $('#main').innerHTML = `
    <h2>進貨單</h2>
    <div class="toolbar">
      <label>起日<input type="date" id="from" value="${monthStart()}"></label>
      <label>迄日<input type="date" id="to" value="${today()}"></label>
      <label>供應商<select id="sup">${options(suppliers, 'supplier_id', null, { blank: '全部' })}</select></label>
      <label>生豆品項<select id="bean">${options(beans, 'bean_id', null, { blank: '全部' })}</select></label>
      <button id="search">查詢</button><span class="spacer"></span>
      <button id="add" class="primary">＋ 新增進貨單</button>
    </div>
    <div class="stats" id="stats"></div>
    <div class="card"><div class="table-wrap" id="list"></div></div>`;

  const load = async () => {
    try {
      const { data, summary } = await api('/purchases' + qs({ from: $('#from').value, to: $('#to').value, supplier_id: $('#sup').value, bean_id: $('#bean').value }));
      $('#stats').innerHTML = [['進貨單數', fmt(summary.count)], ['生豆進貨 kg', kg(summary.bean_kg)], ['金額合計', money(summary.total_amount)], ['未付款', money(summary.unpaid_amount)]]
        .map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');
      $('#list').innerHTML = data.length ? `<table><thead><tr><th>進貨日期</th><th>單號</th><th>供應商</th><th class="num">明細數</th><th class="num">生豆 kg</th><th class="num">運費</th><th class="num">稅額</th><th class="num">合計</th><th>付款</th><th>發票</th></tr></thead><tbody>
        ${data.map((r) => `<tr class="clickable" data-id="${r.purchase_id}"><td>${esc(r.purchase_date)}</td><td>${esc(r.purchase_no)}</td><td>${esc(r.supplier_name)}</td>
          <td class="num">${r.item_count}</td><td class="num up">${r.bean_kg ? '+' + kg(r.bean_kg) : ''}</td><td class="num">${money(r.shipping_fee)}</td><td class="num">${money(r.tax_amount)}</td>
          <td class="num">${money(r.total_amount)}</td><td><span class="tag ${r.payment_status === '已付清' ? '' : 'warn'}">${esc(r.payment_status)}</span></td><td>${esc(r.invoice_no)}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">此區間沒有進貨單</div>';
      $$('#list tr.clickable').forEach((tr) => tr.onclick = () => purchaseForm(Number(tr.dataset.id), load));
    } catch (e) { fail(e); }
  };
  $('#search').onclick = load;
  $('#add').onclick = () => purchaseForm(null, load);
  load();
}

async function purchaseForm(id, reload) {
  try {
    const [suppliers, beans, packs] = await Promise.all([lookup('suppliers', true), lookup('green-beans', true), lookup('packaging-items', true)]);
    const p = id ? (await api(`/purchases/${id}`)).data : { purchase_date: today(), items: [{ item_type: '生豆' }], shipping_fee: 0, tax_amount: 0 };
    const locked = !!p.locked || (id && p.payment_status !== '未付');
    const dis = locked ? 'disabled' : '';

    const itemRow = (it = { item_type: '生豆' }) => `<tr>
      <td><select data-k="item_type" ${dis}><option ${it.item_type === '生豆' ? 'selected' : ''}>生豆</option><option ${it.item_type === '包材' ? 'selected' : ''}>包材</option></select></td>
      <td>
        <select data-k="bean_id" ${dis} ${it.item_type === '包材' ? 'hidden' : ''}>${options(beans, 'bean_id', it.bean_id, { blank: '選擇生豆' })}</select>
        <select data-k="packaging_id" ${dis} ${it.item_type === '包材' ? '' : 'hidden'}>${options(packs, 'packaging_id', it.packaging_id, { blank: '選擇包材', label: (r) => `${r.name}（${r.unit}）` })}</select>
      </td>
      <td><input data-k="lot_no" ${dis} value="${esc(it.lot_no)}" placeholder="自動產生" ${it.item_type === '包材' ? 'hidden' : ''}></td>
      <td><input data-k="qty" ${dis} type="number" step="any" min="0" value="${esc(it.qty)}" class="num"></td>
      <td><input data-k="unit_price" ${dis} type="number" step="any" min="0" value="${esc(it.unit_price)}" class="num"></td>
      <td class="num" data-amount></td><td class="num" data-alloc></td><td class="num" data-landed></td>
      <td><input data-k="storage_location" ${dis} value="${esc(it.storage_location)}" ${it.item_type === '包材' ? 'hidden' : ''}></td>
      <td>${locked ? '' : '<button type="button" class="link" data-del>刪除</button>'}</td></tr>`;

    const box = openModal(`
      <h2>${id ? '進貨單 ' + esc(p.purchase_no) : '新增進貨單'}</h2>
      ${locked ? `<div class="notice">此進貨單已鎖定（${p.locked ? '生豆批號已被使用' : '已有付款紀錄'}），只能檢視，無法修改或刪除。</div>` : ''}
      <form id="f">
        <div class="form-grid">
          <label>進貨日期 *<input name="purchase_date" type="date" required value="${esc(p.purchase_date)}" ${dis}></label>
          <label>進貨單號<input name="purchase_no" value="${esc(p.purchase_no)}" placeholder="自動產生" ${dis}></label>
          <label>供應商 *<select name="supplier_id" required ${dis}>${options(suppliers, 'supplier_id', p.supplier_id, { blank: '請選擇' })}</select></label>
          <label>供應商發票號碼<input name="invoice_no" value="${esc(p.invoice_no)}" ${dis}></label>
          <label>應付日期<input name="due_date" type="date" value="${esc(p.due_date)}" ${dis}></label>
          <label>付款狀態<input value="${esc(p.payment_status || '未付')}" disabled></label>
          <label class="full">備註<input name="note" value="${esc(p.note)}" ${dis}></label>
        </div>
        <div class="section-title">明細 ${locked ? '' : '<button type="button" id="addItem">＋ 新增一筆</button>'}</div>
        <div class="table-wrap"><table class="items"><thead><tr><th style="width:80px">類型</th><th style="min-width:200px">品項</th><th style="width:140px">生豆批號</th>
          <th style="width:90px">數量</th><th style="width:90px">單價</th><th class="num">小計</th><th class="num">攤提</th><th class="num">入庫成本/單位</th><th style="width:90px">存放位置</th><th></th></tr></thead>
          <tbody id="items">${p.items.map(itemRow).join('')}</tbody></table></div>
        <p class="hint">生豆數量單位為 kg。運費＋稅額只攤給生豆（依 kg 比例），包材維持原單價。批號留空會自動產生。</p>
        <div class="totals">
          <div><span>明細小計</span><span id="tItems"></span></div>
          <div><span>運費／報關費</span><input name="shipping_fee" type="number" step="any" min="0" value="${esc(p.shipping_fee)}" style="width:110px;text-align:right" ${dis}></div>
          <div><span>稅額</span><input name="tax_amount" type="number" step="any" min="0" value="${esc(p.tax_amount)}" style="width:110px;text-align:right" ${dis}></div>
          <div class="grand"><span>合計</span><span id="tTotal"></span></div>
        </div>
        <div class="form-actions">
          ${id && !locked ? '<button type="button" class="danger" id="del">刪除</button>' : ''}<span class="spacer"></span>
          <button type="button" id="cancel">${locked ? '關閉' : '取消'}</button>${locked ? '' : '<button class="primary">存檔</button>'}
        </div>
      </form>`, true);

    const f = $('#f', box);
    const readItems = () => $$('#items tr', box).map((tr) => Object.fromEntries($$('[data-k]', tr).map((el) => [el.dataset.k, el.value])));

    // 即時試算（與後端規則相同：運費＋稅只攤生豆、依 kg、尾差給最後一筆）
    const recalc = () => {
      const rows = $$('#items tr', box);
      const items = readItems().map((it) => ({ ...it, qty: Number(it.qty) || 0, unit_price: Number(it.unit_price) || 0 }));
      items.forEach((it) => { it.amount = r2(it.qty * it.unit_price); it.alloc = 0; });
      const pool = r2((Number(f.shipping_fee.value) || 0) + (Number(f.tax_amount.value) || 0));
      const beanIdx = items.map((it, i) => (it.item_type === '生豆' && it.qty > 0 ? i : -1)).filter((i) => i >= 0);
      const totalKg = beanIdx.reduce((s, i) => s + items[i].qty, 0);
      let used = 0;
      beanIdx.forEach((i, n) => {
        items[i].alloc = n === beanIdx.length - 1 ? r2(pool - used) : r2(pool * items[i].qty / totalKg);
        used = r2(used + items[i].alloc);
      });
      let sum = 0;
      items.forEach((it, i) => {
        sum += it.amount;
        $('[data-amount]', rows[i]).textContent = money(it.amount);
        $('[data-alloc]', rows[i]).textContent = it.alloc ? money(it.alloc) : '';
        $('[data-landed]', rows[i]).textContent = it.qty > 0 ? fmt((it.amount + it.alloc) / it.qty, 2) : '';
      });
      $('#tItems', box).textContent = money(sum);
      $('#tTotal', box).textContent = money(r2(sum) + pool);
    };

    $('#items', box).addEventListener('input', recalc);
    $('#items', box).addEventListener('change', (e) => {
      if (e.target.dataset.k === 'item_type') {
        const tr = e.target.closest('tr');
        const isPack = e.target.value === '包材';
        $('[data-k=bean_id]', tr).hidden = isPack;
        $('[data-k=packaging_id]', tr).hidden = !isPack;
        $('[data-k=lot_no]', tr).hidden = isPack;
        $('[data-k=storage_location]', tr).hidden = isPack;
      }
      if (e.target.dataset.k === 'packaging_id') { // 帶入包材參考單價
        const pk = packs.find((x) => x.packaging_id === Number(e.target.value));
        const price = $('[data-k=unit_price]', e.target.closest('tr'));
        if (pk?.unit_cost != null && !price.value) price.value = pk.unit_cost;
      }
      recalc();
    });
    $('#items', box).addEventListener('click', (e) => {
      if (e.target.matches('[data-del]')) { e.target.closest('tr').remove(); recalc(); }
    });
    f.shipping_fee.oninput = f.tax_amount.oninput = recalc;
    if (!locked) $('#addItem', box).onclick = () => { $('#items', box).insertAdjacentHTML('beforeend', itemRow()); recalc(); };
    $('#cancel', box).onclick = closeModal;
    recalc();

    f.onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(f));
      body.items = readItems().map((it) => it.item_type === '生豆'
        ? { item_type: '生豆', bean_id: it.bean_id, lot_no: it.lot_no, qty: it.qty, unit_price: it.unit_price, storage_location: it.storage_location }
        : { item_type: '包材', packaging_id: it.packaging_id, qty: it.qty, unit_price: it.unit_price });
      try {
        const res = await api(id ? `/purchases/${id}` : '/purchases', { method: id ? 'PUT' : 'POST', body });
        closeModal();
        toast(`已存檔 ${res.data.purchase_no}` + (res.unallocated ? `（本單沒有生豆，運費＋稅 ${money(res.unallocated)} 未攤入成本）` : ''));
        reload();
      } catch (err) { fail(err); }
    };
    if (id && !locked) $('#del', box).onclick = async () => {
      if (!confirm(`確定刪除進貨單 ${p.purchase_no}？\n會一併刪除它建立的生豆批號與庫存異動，無法復原。`)) return;
      try { await api(`/purchases/${id}`, { method: 'DELETE' }); closeModal(); toast('已刪除'); reload(); } catch (err) { fail(err); }
    };
  } catch (e) { fail(e); }
}

// ---------------------------------------------------------------- 庫存查詢
const inCell = (n, f = kg) => `<td class="num up">${n ? '+' + f(n) : ''}</td>`;
const outCell = (n, f = kg) => `<td class="num down">${n ? '−' + f(n) : ''}</td>`;

async function pageStockBeans() {
  const beans = await lookup('green-beans', true);
  $('#main').innerHTML = `
    <h2>生豆庫存查詢</h2>
    <div class="toolbar">
      <label>起日<input type="date" id="from" value="${monthStart()}"></label>
      <label>迄日<input type="date" id="to" value="${today()}"></label>
      <label>生豆品項<select id="bean">${options(beans, 'bean_id', null, { blank: '全部' })}</select></label>
      <label>顯示<select id="empty"><option value="">有庫存或異動的品項</option><option value="1">全部品項</option></select></label>
      <button id="search">查詢</button>
    </div>
    <p class="hint">庫存由庫存異動加總計算。期初 = 起日前一天的庫存；期末 = 迄日當天結束的庫存。點品項可展開批號，點批號可看異動明細。<span class="up">紅色 = 入庫</span>、<span class="down">綠色 = 出庫</span>。
      「期初」是算出來的、不能直接改；開帳時手上已有的生豆請到 <a href="#opening-stock">期初庫存</a> 登錄。</p>
    <div class="stats" id="stats"></div>
    <div class="card"><div class="table-wrap" id="list"></div></div>`;

  const load = async () => {
    try {
      const range = { from: $('#from').value, to: $('#to').value };
      const { data, total } = await api('/inventory/green-beans' + qs({ ...range, bean_id: $('#bean').value, show_empty: $('#empty').value }));
      $('#stats').innerHTML = [['期初 kg', kg(total.opening_qty), ''], ['本期入庫 kg', '+' + kg(total.in_qty), 'up'], ['本期出庫 kg', '−' + kg(total.out_qty), 'down'], ['期末 kg', kg(total.closing_qty), ''], ['期末庫存金額', money(total.closing_amount), '']]
        .map(([k, v, c]) => `<div class="stat"><div class="k">${k}</div><div class="v ${c}">${v}</div></div>`).join('');
      if (!data.length) { $('#list').innerHTML = '<div class="empty">沒有資料</div>'; return; }
      $('#list').innerHTML = `<table><thead><tr><th>品項／批號</th><th>入庫日</th><th>進貨單</th><th>位置</th><th class="num">成本/kg</th>
        <th class="num">期初 kg</th><th class="num">入庫 kg</th><th class="num">出庫 kg</th><th class="num">期末 kg</th><th class="num">期末金額</th><th>狀態</th></tr></thead><tbody>
        ${data.map((b) => `
          <tr class="clickable bean" data-bean="${b.bean_id}"><td>▸ <b>${esc(b.name)}</b>（${b.lots.length} 批）</td><td></td><td></td><td></td>
            <td class="num">${b.avg_cost == null ? '' : fmt(b.avg_cost, 2)}</td><td class="num">${kg(b.opening_qty)}</td>${inCell(b.in_qty)}${outCell(b.out_qty)}
            <td class="num"><b>${kg(b.closing_qty)}</b></td><td class="num">${money(b.closing_amount)}</td>
            <td>${b.low_stock ? `<span class="tag warn">低於安全庫存 ${fmt(b.safety_stock_kg)}kg</span>` : ''}</td></tr>
          ${b.lots.map((l) => `<tr class="sub clickable" data-parent="${b.bean_id}" data-lot="${l.lot_id}" data-lotno="${esc(l.lot_no)}" hidden>
            <td>${esc(l.lot_no)}</td><td>${esc(l.received_date)}</td><td>${l.purchase_no ? esc(l.purchase_no) : '<span class="tag">期初庫存</span>'}</td><td>${esc(l.storage_location)}</td>
            <td class="num">${fmt(l.unit_cost, 2)}</td><td class="num">${kg(l.opening_qty)}</td>${inCell(l.in_qty)}${outCell(l.out_qty)}
            <td class="num">${kg(l.closing_qty)}</td><td class="num">${money(l.closing_amount)}</td><td><span class="tag">${l.status}</span></td></tr>`).join('')}`).join('')}
        <tr class="total"><td>合計</td><td></td><td></td><td></td><td></td><td class="num">${kg(total.opening_qty)}</td>${inCell(total.in_qty)}${outCell(total.out_qty)}
          <td class="num">${kg(total.closing_qty)}</td><td class="num">${money(total.closing_amount)}</td><td></td></tr>
        </tbody></table>`;
      $$('#list tr.bean').forEach((tr) => tr.onclick = () => {
        const subs = $$(`#list tr[data-parent="${tr.dataset.bean}"]`);
        const open = subs[0]?.hidden;
        subs.forEach((s) => (s.hidden = !open));
        tr.cells[0].firstChild.textContent = open ? '▾ ' : '▸ ';
      });
      $$('#list tr.sub').forEach((tr) => tr.onclick = () => movementModal(`批號 ${tr.dataset.lotno} 異動明細`, { item_type: '生豆', lot_id: tr.dataset.lot, ...range }, 'kg'));
      if (data.length === 1) $('#list tr.bean').click();
    } catch (e) { fail(e); }
  };
  $('#search').onclick = load;
  load();
}

async function movementModal(title, params, unit) {
  try {
    const { data } = await api('/inventory/movements' + qs(params));
    let bal = null;
    openModal(`<h2>${esc(title)}</h2>
      <p class="hint">${esc(params.from || '最早')} ～ ${esc(params.to || '目前')}</p>
      <div class="table-wrap">${data.length ? `<table><thead><tr><th>日期</th><th>異動類型</th><th class="num">數量（${unit}）</th><th class="num">單位成本</th><th class="num">金額</th><th>來源單據</th><th>備註</th><th>操作者</th></tr></thead><tbody>
        ${data.map((m) => `<tr><td>${esc(m.movement_date.slice(0, 16))}</td><td><span class="tag ${m.qty > 0 ? 'up' : 'down'}">${esc(m.movement_type)}</span></td>
          <td class="num ${m.qty > 0 ? 'up' : 'down'}">${m.qty > 0 ? '+' : '−'}${kg(Math.abs(m.qty))}</td><td class="num">${fmt(m.unit_cost, 2)}</td>
          <td class="num ${m.qty > 0 ? 'up' : 'down'}">${m.qty > 0 ? '+' : '−'}${money(Math.abs(m.amount))}</td><td>${esc(m.doc_no)}${m.customer_name ? '（' + esc(m.customer_name) + '）' : ''}</td><td>${m.note === m.doc_no ? '' : esc(m.note)}</td><td>${esc(m.created_by)}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">此區間沒有異動</div>'}</div>
      <div class="form-actions"><button id="cancel">關閉</button></div>`, true);
    $('#cancel').onclick = closeModal;
  } catch (e) { fail(e); }
}

async function pageStockPackaging() {
  $('#main').innerHTML = `
    <h2>包材庫存查詢</h2>
    <div class="toolbar">
      <label>起日<input type="date" id="from" value="${monthStart()}"></label>
      <label>迄日<input type="date" id="to" value="${today()}"></label>
      <button id="search">查詢</button>
    </div>
    <p class="hint">點任一列可看異動明細。目前只有進貨入庫與期初；包裝耗用於 Phase 4（配方）加入。開帳時手上已有的包材請到 <a href="#opening-stock">期初庫存</a> 登錄。</p>
    <div class="card"><div class="table-wrap" id="list"></div></div>`;
  const load = async () => {
    try {
      const range = { from: $('#from').value, to: $('#to').value };
      const { data } = await api('/inventory/packaging' + qs(range));
      $('#list').innerHTML = data.length ? `<table><thead><tr><th>包材</th><th>單位</th><th class="num">期初</th><th class="num">入庫</th><th class="num">出庫</th><th class="num">期末</th><th class="num">期末金額</th><th>狀態</th></tr></thead><tbody>
        ${data.map((r) => `<tr class="clickable ${r.is_active ? '' : 'inactive'}" data-id="${r.packaging_id}" data-name="${esc(r.name)}" data-unit="${esc(r.unit)}"><td>${esc(r.name)}</td><td>${esc(r.unit)}</td>
          <td class="num">${fmt(r.opening_qty)}</td>${inCell(r.in_qty, fmt)}${outCell(r.out_qty, fmt)}<td class="num"><b>${fmt(r.closing_qty)}</b></td><td class="num">${money(r.closing_amount)}</td>
          <td>${r.low_stock ? `<span class="tag warn">低於安全庫存 ${fmt(r.safety_stock)}</span>` : ''}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">沒有資料</div>';
      $$('#list tr.clickable').forEach((tr) => tr.onclick = () => movementModal(`${tr.dataset.name} 異動明細`, { item_type: '包材', packaging_id: tr.dataset.id, ...range }, tr.dataset.unit));
    } catch (e) { fail(e); }
  };
  $('#search').onclick = load;
  load();
}

// ---------------------------------------------------------------- 烘焙批次
const pct = (r) => (r === null || r === undefined ? '' : fmt(r * 100, 1) + '%');
const LOSS_MIN = 0.10, LOSS_MAX = 0.25;
const lossTag = (r) => (r < LOSS_MIN || r > LOSS_MAX ? `<span class="tag warn">${pct(r)}</span>` : pct(r));

async function pageRoasts() {
  const [rbeans, beans] = await Promise.all([lookup('roasted-beans', true), lookup('green-beans', true)]);
  $('#main').innerHTML = `
    <h2>烘焙批次</h2>
    <div class="toolbar">
      <label>起日<input type="date" id="from" value="${monthStart()}"></label>
      <label>迄日<input type="date" id="to" value="${today()}"></label>
      <label>熟豆品項<select id="rbean">${options(rbeans, 'roasted_bean_id', null, { blank: '全部' })}</select></label>
      <label>投入生豆<select id="bean">${options(beans, 'bean_id', null, { blank: '全部' })}</select></label>
      <button id="search">查詢</button><span class="spacer"></span>
      <button id="add" class="primary">＋ 新增烘焙批次</button>
    </div>
    <div class="stats" id="stats"></div>
    <div class="card"><div class="table-wrap" id="list"></div></div>`;

  const load = async () => {
    try {
      const { data, summary } = await api('/roast-batches' + qs({ from: $('#from').value, to: $('#to').value, roasted_bean_id: $('#rbean').value, bean_id: $('#bean').value }));
      $('#stats').innerHTML = [['批次數', fmt(summary.count), ''], ['投入生豆 kg', '−' + kg(summary.input_kg), 'down'], ['產出熟豆 kg', '+' + kg(summary.output_kg), 'up'], ['平均失重率', pct(summary.loss_rate) || '—', ''], ['投入成本', money(summary.input_cost), '']]
        .map(([k, v, c]) => `<div class="stat"><div class="k">${k}</div><div class="v ${c}">${v}</div></div>`).join('');
      $('#list').innerHTML = data.length ? `<table><thead><tr><th>烘焙日期</th><th>批次編號</th><th>熟豆品項</th><th>投入生豆</th><th class="num">投入 kg</th><th class="num">產出 kg</th><th class="num">失重率</th><th class="num">熟豆成本/kg</th><th class="num">剩餘 kg</th><th>賞味期限</th></tr></thead><tbody>
        ${data.map((r) => `<tr class="clickable" data-id="${r.batch_id}"><td>${esc(r.roast_date)}</td><td>${esc(r.batch_no)}</td><td>${esc(r.roasted_bean_name)}</td><td>${esc(r.inputs_text)}</td>
          <td class="num down">−${kg(r.input_total_kg)}</td><td class="num up">+${kg(r.output_kg)}</td><td class="num">${lossTag(r.loss_rate)}</td>
          <td class="num">${fmt(r.unit_cost, 2)}</td><td class="num ${r.current_kg < 0 ? 'down' : ''}">${kg(r.current_kg)}</td><td>${esc(r.best_before)}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">此區間沒有烘焙批次</div>';
      $$('#list tr.clickable').forEach((tr) => tr.onclick = () => roastForm(Number(tr.dataset.id), load));
    } catch (e) { fail(e); }
  };
  $('#search').onclick = load;
  $('#add').onclick = () => roastForm(null, load);
  load();
}

async function roastForm(id, reload) {
  try {
    const [rbeans, stock] = await Promise.all([lookup('roasted-beans', true), api('/inventory/green-beans')]);
    const b = id ? (await api(`/roast-batches/${id}`)).data : { roast_date: today(), inputs: [{}] };
    const locked = !!b.locked;
    const dis = locked ? 'disabled' : '';

    // 可選的生豆批號：目前有庫存的，加上本批次原本就投入的（修改時可用量要加回自己的投入）
    const own = new Map((b.inputs || []).filter((i) => i.lot_id).map((i) => [i.lot_id, i]));
    const lots = [];
    for (const bean of stock.data) {
      for (const l of bean.lots) {
        const avail = r2(l.closing_qty + (own.get(l.lot_id)?.input_kg || 0));
        if (avail > 0.0005) lots.push({ lot_id: l.lot_id, lot_no: l.lot_no, bean_name: bean.name, unit_cost: l.unit_cost, avail });
      }
    }
    for (const i of own.values()) { // 鎖定檢視時批號可能已用完，仍要顯示
      if (!lots.some((l) => l.lot_id === i.lot_id)) lots.push({ lot_id: i.lot_id, lot_no: i.lot_no, bean_name: i.bean_name, unit_cost: i.unit_cost, avail: i.input_kg });
    }
    const lotOpts = (sel) => '<option value="">選擇生豆批號</option>' + lots.map((l) =>
      `<option value="${l.lot_id}" ${l.lot_id === sel ? 'selected' : ''}>${esc(l.lot_no)}｜${esc(l.bean_name)}｜可用 ${kg(l.avail)} kg｜${fmt(l.unit_cost, 2)} 元/kg</option>`).join('');

    const inputRow = (it = {}) => `<tr>
      <td><select data-k="lot_id" ${dis}>${lotOpts(it.lot_id)}</select></td>
      <td><input data-k="input_kg" ${dis} type="number" step="any" min="0" value="${esc(it.input_kg)}" class="num"></td>
      <td class="num" data-cost></td><td class="num" data-amount></td>
      <td>${locked ? '' : '<button type="button" class="link" data-del>刪除</button>'}</td></tr>`;

    const box = openModal(`
      <h2>${id ? '烘焙批次 ' + esc(b.batch_no) : '新增烘焙批次'}</h2>
      ${locked ? '<div class="notice">此批次的熟豆已被使用（銷貨出庫），只能檢視，無法修改或刪除。</div>' : ''}
      ${!id && !lots.length ? '<div class="notice">目前沒有任何有庫存的生豆批號，請先建立進貨單。</div>' : ''}
      ${!id && !rbeans.some((r) => r.is_active) ? '<div class="notice">還沒有熟豆品項，請先到「主檔 → 熟豆品項」新增（例：招牌綜合 中深焙）。</div>' : ''}
      <form id="f">
        <div class="form-grid">
          <label>烘焙日期 *<input name="roast_date" type="date" required value="${esc(b.roast_date)}" ${dis}></label>
          <label>批次編號<input name="batch_no" value="${esc(b.batch_no)}" placeholder="自動產生" ${dis}></label>
          <label>熟豆品項 *<select name="roasted_bean_id" required ${dis}>${options(rbeans, 'roasted_bean_id', b.roasted_bean_id, { blank: '請選擇' })}</select></label>
          <label>產出熟豆 kg *<input name="output_kg" type="number" step="any" min="0" required value="${esc(b.output_kg)}" ${dis}></label>
          <label class="full">備註<input name="note" value="${esc(b.note)}" ${dis}></label>
        </div>
        <div class="section-title">投入生豆 ${locked ? '' : '<button type="button" id="addItem">＋ 新增一筆</button>'}</div>
        <div class="table-wrap"><table class="items"><thead><tr><th style="min-width:320px">生豆批號</th><th style="width:110px">投入 kg</th><th class="num">成本/kg</th><th class="num">投入成本</th><th></th></tr></thead>
          <tbody id="items">${b.inputs.map(inputRow).join('')}</tbody></table></div>
        <p class="hint">只需記錄：投入哪幾批生豆各幾公斤、產出多少熟豆。失重率與熟豆成本自動計算；失重率不在 10%～25% 時存檔前會提醒。</p>
        <div class="totals">
          <div><span>投入總重</span><span id="tIn" class="down"></span></div>
          <div><span>產出熟豆</span><span id="tOut" class="up"></span></div>
          <div><span>失重率</span><span id="tLoss"></span></div>
          <div><span>投入總成本</span><span id="tCost"></span></div>
          <div class="grand"><span>熟豆成本/kg</span><span id="tUnit"></span></div>
        </div>
        ${id ? `<p class="hint">熟豆剩餘 ${kg(b.current_kg)} kg${b.best_before ? '，賞味期限 ' + esc(b.best_before) : ''}。</p>` : ''}
        <div class="form-actions">
          ${id && !locked ? '<button type="button" class="danger" id="del">刪除</button>' : ''}<span class="spacer"></span>
          <button type="button" id="cancel">${locked ? '關閉' : '取消'}</button>${locked ? '' : '<button class="primary">存檔</button>'}
        </div>
      </form>`, true);

    const f = $('#f', box);
    const readItems = () => $$('#items tr', box).map((tr) => Object.fromEntries($$('[data-k]', tr).map((el) => [el.dataset.k, el.value])));
    const calc = () => {
      const rows = $$('#items tr', box);
      let inKg = 0, cost = 0;
      readItems().forEach((it, i) => {
        const lot = lots.find((l) => l.lot_id === Number(it.lot_id));
        const q = Number(it.input_kg) || 0;
        const amt = lot ? r2(q * lot.unit_cost) : 0;
        inKg += q; cost += amt;
        $('[data-cost]', rows[i]).textContent = lot ? fmt(lot.unit_cost, 2) : '';
        $('[data-amount]', rows[i]).textContent = lot && q ? money(amt) : '';
      });
      const out = Number(f.output_kg.value) || 0;
      const loss = inKg > 0 && out > 0 ? (inKg - out) / inKg : null;
      $('#tIn', box).textContent = '−' + kg(inKg) + ' kg';
      $('#tOut', box).textContent = '+' + kg(out) + ' kg';
      $('#tLoss', box).innerHTML = loss === null ? '—' : lossTag(loss);
      $('#tCost', box).textContent = money(cost);
      $('#tUnit', box).textContent = out > 0 ? fmt(cost / out, 2) : '—';
      return loss;
    };
    $('#items', box).addEventListener('input', calc);
    $('#items', box).addEventListener('change', calc);
    $('#items', box).addEventListener('click', (e) => {
      if (e.target.matches('[data-del]')) { e.target.closest('tr').remove(); calc(); }
    });
    f.output_kg.oninput = calc;
    if (!locked) $('#addItem', box).onclick = () => { $('#items', box).insertAdjacentHTML('beforeend', inputRow()); calc(); };
    $('#cancel', box).onclick = closeModal;
    calc();

    f.onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(f));
      body.inputs = readItems().filter((it) => it.lot_id || it.input_kg);
      const loss = calc();
      if (loss !== null && (loss < LOSS_MIN || loss > LOSS_MAX)
        && !confirm(`失重率 ${pct(loss)} 不在一般範圍（10%～25%）。\n請確認投入與產出公斤數沒有輸入錯誤。\n\n仍要存檔嗎？`)) return;
      try {
        const res = await api(id ? `/roast-batches/${id}` : '/roast-batches', { method: id ? 'PUT' : 'POST', body });
        closeModal();
        toast(`已存檔 ${res.data.batch_no}（失重率 ${pct(res.data.loss_rate)}）`);
        reload();
      } catch (err) { fail(err); }
    };
    if (id && !locked) $('#del', box).onclick = async () => {
      if (!confirm(`確定刪除烘焙批次 ${b.batch_no}？\n投入的生豆會加回庫存，產出的熟豆批次會一併刪除，無法復原。`)) return;
      try { await api(`/roast-batches/${id}`, { method: 'DELETE' }); closeModal(); toast('已刪除'); reload(); } catch (err) { fail(err); }
    };
  } catch (e) { fail(e); }
}

// ---------------------------------------------------------------- 銷貨單
const CHANNELS = ['門市', '電話', 'LINE', '官網', '蝦皮', '批發'];
const PAY_METHODS = ['現金', '轉帳', 'LINE Pay', '刷卡', '貨到付款', '月結'];
const PAY_STATUS = ['未收', '部分收款', '已收清'];
const PAID_ON_SALE = ['現金', 'LINE Pay', '刷卡'];
const plainOpts = (values, sel, blank = null) => (blank === null ? '' : `<option value="">${blank}</option>`) + values.map((v) => `<option ${v === sel ? 'selected' : ''}>${v}</option>`).join('');
const payTag = (s) => `<span class="tag ${s === '已收清' ? '' : 'warn'}">${esc(s)}</span>`;

async function pageSales() {
  const [customers, products] = await Promise.all([lookup('customers', true), lookup('products', true)]);
  $('#main').innerHTML = `
    <h2>銷貨單</h2>
    <div class="toolbar">
      <label>起日<input type="date" id="from" value="${monthStart()}"></label>
      <label>迄日<input type="date" id="to" value="${today()}"></label>
      <label>客戶<select id="cust"><option value="">全部</option><option value="none">散客</option>${options(customers, 'customer_id', null, { blank: null })}</select></label>
      <label>產品<select id="prod">${options(products, 'product_id', null, { blank: '全部' })}</select></label>
      <label>通路<select id="chan">${plainOpts(CHANNELS, null, '全部')}</select></label>
      <label>收款<select id="pay">${plainOpts(PAY_STATUS, null, '全部')}</select></label>
      <button id="search">查詢</button><span class="spacer"></span>
      <button id="add" class="primary">＋ 新增銷貨單</button>
    </div>
    <div class="stats" id="stats"></div>
    <div class="card"><div class="table-wrap" id="list"></div></div>`;

  const load = async () => {
    try {
      const { data, summary } = await api('/sales' + qs({ from: $('#from').value, to: $('#to').value, customer_id: $('#cust').value, product_id: $('#prod').value, channel: $('#chan').value, payment_status: $('#pay').value }));
      $('#stats').innerHTML = [['銷貨單數', fmt(summary.count), ''], ['營業額', money(summary.total_amount), 'up'], ['熟豆成本', money(summary.cost_amount), ''], ['毛利', money(summary.gross_profit), ''], ['未收款', money(summary.unpaid_amount), ''], ['出貨熟豆 kg', '−' + kg(summary.roasted_kg), 'down']]
        .map(([k, v, c]) => `<div class="stat"><div class="k">${k}</div><div class="v ${c}">${v}</div></div>`).join('');
      $('#list').innerHTML = data.length ? `<table><thead><tr><th>銷貨日期</th><th>單號</th><th>客戶</th><th>通路</th><th class="num">明細數</th><th class="num">小計</th><th class="num">折扣</th><th class="num">運費</th><th class="num">合計</th><th class="num">毛利</th><th>付款方式</th><th>收款</th></tr></thead><tbody>
        ${data.map((r) => `<tr class="clickable" data-id="${r.sale_id}"><td>${esc(r.sale_date)}</td><td>${esc(r.sale_no)}</td><td>${r.customer_name ? esc(r.customer_name) : '<span class="tag">散客</span>'}</td><td>${esc(r.channel)}</td>
          <td class="num">${r.item_count}</td><td class="num">${money(r.subtotal)}</td><td class="num">${r.discount ? '−' + money(r.discount) : ''}</td><td class="num">${r.shipping_fee ? money(r.shipping_fee) : ''}</td>
          <td class="num up"><b>${money(r.total_amount)}</b></td><td class="num">${money(r.gross_profit)}</td><td>${esc(r.payment_method)}</td><td>${payTag(r.payment_status)}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">此區間沒有銷貨單</div>';
      $$('#list tr.clickable').forEach((tr) => tr.onclick = () => saleForm(Number(tr.dataset.id), load));
    } catch (e) { fail(e); }
  };
  $('#search').onclick = load;
  $('#add').onclick = () => saleForm(null, load);
  load();
}

async function saleForm(id, reload) {
  try {
    const [customers, products] = await Promise.all([lookup('customers', true), lookup('products', true)]);
    const s = id ? (await api(`/sales/${id}`)).data : { sale_date: today(), channel: '門市', payment_method: '現金', payment_status: '已收清', items: [{}], discount: 0, shipping_fee: 0 };
    const prodOf = (pid) => products.find((p) => p.product_id === Number(pid));
    const priceFor = (p, cust) => (cust?.price_level === '批發價' && p.wholesale_price != null ? p.wholesale_price : p.retail_price);

    const itemRow = (it = {}) => `<tr>
      <td><select data-k="product_id">${options(products, 'product_id', it.product_id, { blank: '選擇產品' })}</select></td>
      <td><select data-k="grind_size">${plainOpts(GRIND, it.grind_size, '')}</select></td>
      <td><input data-k="qty" type="number" step="1" min="1" value="${esc(it.qty)}" class="num"></td>
      <td><input data-k="unit_price" type="number" step="any" min="0" value="${esc(it.unit_price)}" class="num"></td>
      <td class="num" data-amount></td><td class="num down" data-kg></td>
      <td data-lots>${(it.lots || []).map((l) => `${esc(l.batch_no)} ${kg(l.kg)}kg`).join('、')}${it.undeducted_kg ? ` <span class="tag warn">未扣 ${kg(it.undeducted_kg)}kg</span>` : ''}</td>
      <td><button type="button" class="link" data-del>刪除</button></td></tr>`;

    const box = openModal(`
      <h2>${id ? '銷貨單 ' + esc(s.sale_no) : '新增銷貨單'}</h2>
      <form id="f">
        <div class="form-grid">
          <label>銷貨日期 *<input name="sale_date" type="date" required value="${esc(s.sale_date)}"></label>
          <label>銷貨單號<input name="sale_no" value="${esc(s.sale_no)}" placeholder="自動產生"></label>
          <label>客戶<select name="customer_id">${options(customers, 'customer_id', s.customer_id, { blank: '散客（不指定）', label: (c) => `${c.name}（${c.price_level}）` })}</select></label>
          <label>通路<select name="channel">${plainOpts(CHANNELS, s.channel)}</select></label>
          <label>付款方式<select name="payment_method">${plainOpts(PAY_METHODS, s.payment_method)}</select></label>
          <label>收款狀態<select name="payment_status">${plainOpts(PAY_STATUS, s.payment_status)}</select></label>
          <label>應收日期<input name="due_date" type="date" value="${esc(s.due_date)}"></label>
          <label class="full">備註<input name="note" value="${esc(s.note)}"></label>
        </div>
        <div id="prefs"></div>
        <div class="section-title">明細 <button type="button" id="addItem">＋ 新增一筆</button></div>
        <div class="table-wrap"><table class="items"><thead><tr><th style="min-width:220px">產品</th><th style="width:90px">研磨</th><th style="width:80px">數量</th><th style="width:100px">單價</th>
          <th class="num">小計</th><th class="num">扣熟豆 kg</th><th>出貨熟豆批次</th><th></th></tr></thead>
          <tbody id="items">${s.items.map(itemRow).join('')}</tbody></table></div>
        <p class="hint">選產品後自動帶入單價（批發價客戶帶批發價）。有指定熟豆品項的產品，存檔時依「數量 × 每包淨重」以先進先出扣熟豆庫存；熟豆不足時會先提醒，確認後仍可存檔。</p>
        <div class="totals">
          <div><span>明細小計</span><span id="tItems"></span></div>
          <div><span>折扣</span><input name="discount" type="number" step="any" min="0" value="${esc(s.discount)}" style="width:110px;text-align:right"></div>
          <div><span>運費</span><input name="shipping_fee" type="number" step="any" min="0" value="${esc(s.shipping_fee)}" style="width:110px;text-align:right"></div>
          <div class="grand"><span>合計</span><span id="tTotal" class="up"></span></div>
          ${id ? `<div><span>熟豆成本</span><span>${money(s.cost_amount)}</span></div><div><span>毛利（不含運費）</span><span>${money(s.gross_profit)}</span></div>` : ''}
        </div>
        <div class="form-actions">
          ${id ? '<button type="button" class="danger" id="del">刪除</button>' : ''}<span class="spacer"></span>
          <button type="button" id="cancel">取消</button><button class="primary">存檔</button>
        </div>
      </form>`, true);

    const f = $('#f', box);
    const custOf = () => customers.find((c) => c.customer_id === Number(f.customer_id.value));
    const readItems = () => $$('#items tr', box).map((tr) => Object.fromEntries($$('[data-k]', tr).map((el) => [el.dataset.k, el.value])));
    const recalc = () => {
      const rows = $$('#items tr', box);
      let sum = 0;
      readItems().forEach((it, i) => {
        const p = prodOf(it.product_id);
        const q = Number(it.qty) || 0;
        const amt = r2(q * (Number(it.unit_price) || 0));
        sum += amt;
        $('[data-amount]', rows[i]).textContent = q ? money(amt) : '';
        $('[data-kg]', rows[i]).textContent = p?.roasted_bean_id && p.net_weight_g && q ? '−' + kg(q * p.net_weight_g / 1000) : '';
      });
      $('#tItems', box).textContent = money(sum);
      $('#tTotal', box).textContent = money(r2(sum) - (Number(f.discount.value) || 0) + (Number(f.shipping_fee.value) || 0));
    };
    // 顯示客戶喜好（Phase 1 客戶主檔），方便出貨時確認烘焙度與研磨度
    const showPrefs = async () => {
      const el = $('#prefs', box);
      el.innerHTML = '';
      if (!f.customer_id.value) return;
      try {
        const { data } = await api(`/customers/${f.customer_id.value}`);
        const lines = (data.preferences || []).map((p) => [p.roast_level, p.grind_size, p.flavor_notes, p.brew_method, p.favorite_products && '常買：' + p.favorite_products, p.dislikes && '不喜歡：' + p.dislikes, p.note].filter(Boolean).join('／')).filter(Boolean);
        const extra = [data.payment_terms && '付款條件：' + data.payment_terms, data.note].filter(Boolean).join('　');
        if (lines.length || extra) el.innerHTML = `<p class="hint">${lines.length ? '客戶喜好：' + lines.map(esc).join('；') : ''}${lines.length && extra ? '　｜　' : ''}${esc(extra)}</p>`;
      } catch { /* 喜好只是提示，讀不到不影響開單 */ }
    };

    $('#items', box).addEventListener('input', recalc);
    $('#items', box).addEventListener('change', (e) => {
      if (e.target.dataset.k === 'product_id') { // 帶入單價
        const p = prodOf(e.target.value);
        const tr = e.target.closest('tr');
        if (p) {
          const price = priceFor(p, custOf());
          $('[data-k=unit_price]', tr).value = price ?? '';
          if (!$('[data-k=qty]', tr).value) $('[data-k=qty]', tr).value = 1;
        }
        $('[data-lots]', tr).textContent = '';
      }
      recalc();
    });
    $('#items', box).addEventListener('click', (e) => {
      if (e.target.matches('[data-del]')) { e.target.closest('tr').remove(); recalc(); }
    });
    f.discount.oninput = f.shipping_fee.oninput = recalc;
    f.payment_method.onchange = () => { f.payment_status.value = PAID_ON_SALE.includes(f.payment_method.value) ? '已收清' : '未收'; };
    f.customer_id.onchange = () => {
      const c = custOf();
      if (!id && c && /月結/.test(c.payment_terms || '')) { f.payment_method.value = '月結'; f.payment_status.value = '未收'; }
      showPrefs();
    };
    $('#addItem', box).onclick = () => { $('#items', box).insertAdjacentHTML('beforeend', itemRow()); recalc(); };
    $('#cancel', box).onclick = closeModal;
    recalc();
    showPrefs();

    f.onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(f));
      body.items = readItems().filter((it) => it.product_id || it.qty).map((it) => ({ product_id: it.product_id, grind_size: it.grind_size, qty: it.qty, unit_price: it.unit_price }));
      const save = (extra = {}) => api(id ? `/sales/${id}` : '/sales', { method: id ? 'PUT' : 'POST', body: { ...body, ...extra } });
      try {
        let res;
        try { res = await save(); } catch (err) {
          if (err.detail?.code !== 'SHORTAGE') throw err;
          const lines = err.detail.shortages.map((x) => `・${x.product_name}：需要 ${kg(x.need_kg)} kg，不足 ${kg(x.short_kg)} kg`
            + (x.batch_no ? `（會記在批次 ${x.batch_no}，該批庫存變負數）` : '（還沒有任何烘焙批次，這筆不會扣庫存）'));
          if (!confirm(`熟豆庫存不足（只計算烘焙日在銷貨日當天或之前的批次）：\n\n${lines.join('\n')}\n\n補登烘焙批次後，重新存檔這張銷貨單就會重新配批次。\n仍要存檔嗎？`)) return;
          res = await save({ allow_shortage: true });
        }
        closeModal();
        toast(`已存檔 ${res.data.sale_no}（合計 ${money(res.data.total_amount)}）`);
        reload();
      } catch (err) { fail(err); }
    };
    if (id) $('#del', box).onclick = async () => {
      if (!confirm(`確定刪除銷貨單 ${s.sale_no}？\n已扣的熟豆會加回庫存，無法復原。`)) return;
      try { await api(`/sales/${id}`, { method: 'DELETE' }); closeModal(); toast('已刪除'); reload(); } catch (err) { fail(err); }
    };
  } catch (e) { fail(e); }
}

// ---------------------------------------------------------------- 客戶購買紀錄
async function pageCustomerHistory() {
  const [customers, products] = await Promise.all([lookup('customers', true), lookup('products', true)]);
  $('#main').innerHTML = `
    <h2>客戶購買紀錄</h2>
    <div class="toolbar">
      <label>客戶<select id="cust"><option value="">全部客戶</option><option value="none">散客</option>${options(customers, 'customer_id', null, { blank: null })}</select></label>
      <label>起日<input type="date" id="from" value=""></label>
      <label>迄日<input type="date" id="to" value="${today()}"></label>
      <label>產品<select id="prod">${options(products, 'product_id', null, { blank: '全部' })}</select></label>
      <button id="search">查詢</button>
    </div>
    <p class="hint">購買紀錄 = 依客戶篩選的銷貨明細。起日留空 = 從最早紀錄算起。點任一列可開啟該張銷貨單。</p>
    <div class="stats" id="stats"></div>
    <div class="card"><div class="table-wrap" id="list"></div></div>`;

  const load = async () => {
    try {
      const { data, summary } = await api('/sales/items' + qs({ from: $('#from').value, to: $('#to').value, customer_id: $('#cust').value, product_id: $('#prod').value }));
      const top = summary.by_product.slice(0, 3).map((p) => `${p.product_name} ×${fmt(p.qty)}`).join('、');
      $('#stats').innerHTML = [['購買次數', fmt(summary.sale_count)], ['累計金額', money(summary.amount)], ['累計熟豆 kg', kg(summary.kg)], ['最近購買日', summary.last_date || '—']]
        .map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${esc(v)}</div></div>`).join('')
        + `<div class="stat" style="grid-column: span 2"><div class="k">常買品項</div><div class="v" style="font-size:15px">${esc(top) || '—'}</div></div>`;
      $('#list').innerHTML = data.length ? `<table><thead><tr><th>銷貨日期</th><th>單號</th><th>客戶</th><th>產品</th><th>研磨</th><th class="num">數量</th><th class="num">單價</th><th class="num">小計</th><th>通路</th><th>收款</th></tr></thead><tbody>
        ${data.map((r) => `<tr class="clickable" data-id="${r.sale_id}"><td>${esc(r.sale_date)}</td><td>${esc(r.sale_no)}</td><td>${r.customer_name ? esc(r.customer_name) : '<span class="tag">散客</span>'}</td><td>${esc(r.product_name)}</td><td>${esc(r.grind_size)}</td>
          <td class="num">${fmt(r.qty)}</td><td class="num">${money(r.unit_price)}</td><td class="num">${money(r.amount)}</td><td>${esc(r.channel)}</td><td>${payTag(r.payment_status)}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">沒有購買紀錄</div>';
      $$('#list tr.clickable').forEach((tr) => tr.onclick = () => saleForm(Number(tr.dataset.id), load));
    } catch (e) { fail(e); }
  };
  $('#search').onclick = load;
  $('#cust').onchange = load;
  load();
}

// ---------------------------------------------------------------- 熟豆庫存查詢
async function pageStockRoasted() {
  const rbeans = await lookup('roasted-beans', true);
  $('#main').innerHTML = `
    <h2>熟豆庫存查詢</h2>
    <div class="toolbar">
      <label>起日<input type="date" id="from" value="${monthStart()}"></label>
      <label>迄日<input type="date" id="to" value="${today()}"></label>
      <label>熟豆品項<select id="bean">${options(rbeans, 'roasted_bean_id', null, { blank: '全部' })}</select></label>
      <label>顯示<select id="empty"><option value="">有庫存或異動的品項</option><option value="1">全部品項</option></select></label>
      <button id="search">查詢</button>
    </div>
    <p class="hint">熟豆批次 = 烘焙批次。期初 = 起日前一天的庫存；期末 = 迄日當天結束的庫存。點品項可展開批次，點批次可看異動明細。<span class="up">紅色 = 入庫</span>、<span class="down">綠色 = 出庫</span>。</p>
    <div class="stats" id="stats"></div>
    <div class="card"><div class="table-wrap" id="list"></div></div>`;

  const load = async () => {
    try {
      const range = { from: $('#from').value, to: $('#to').value };
      const { data, total } = await api('/inventory/roasted' + qs({ ...range, roasted_bean_id: $('#bean').value, show_empty: $('#empty').value }));
      $('#stats').innerHTML = [['期初 kg', kg(total.opening_qty), ''], ['本期烘焙產出 kg', '+' + kg(total.in_qty), 'up'], ['本期出庫 kg', '−' + kg(total.out_qty), 'down'], ['期末 kg', kg(total.closing_qty), ''], ['期末庫存金額', money(total.closing_amount), '']]
        .map(([k, v, c]) => `<div class="stat"><div class="k">${k}</div><div class="v ${c}">${v}</div></div>`).join('');
      if (!data.length) { $('#list').innerHTML = '<div class="empty">沒有資料</div>'; return; }
      const lotTag = (l) => (l.status === '負庫存' ? '<span class="tag warn">負庫存（待補登烘焙）</span>'
        : l.expired ? '<span class="tag warn">已過賞味期</span>' : l.expiring ? '<span class="tag warn">7 天內到期</span>' : `<span class="tag">${l.status}</span>`);
      $('#list').innerHTML = `<table><thead><tr><th>熟豆品項／批次</th><th>烘焙日</th><th>賞味期限</th><th class="num">失重率</th><th class="num">成本/kg</th>
        <th class="num">期初 kg</th><th class="num">入庫 kg</th><th class="num">出庫 kg</th><th class="num">期末 kg</th><th class="num">期末金額</th><th>狀態</th></tr></thead><tbody>
        ${data.map((b) => `
          <tr class="clickable bean" data-bean="${b.roasted_bean_id}"><td>▸ <b>${esc(b.name)}</b>（${b.lots.length} 批）</td><td></td><td></td><td></td>
            <td class="num">${b.avg_cost == null ? '' : fmt(b.avg_cost, 2)}</td><td class="num">${kg(b.opening_qty)}</td>${inCell(b.in_qty)}${outCell(b.out_qty)}
            <td class="num"><b>${kg(b.closing_qty)}</b></td><td class="num">${money(b.closing_amount)}</td>
            <td>${[b.negative ? '<span class="tag warn">有負庫存</span>' : '', b.low_stock ? `<span class="tag warn">低於安全庫存 ${fmt(b.safety_stock_kg)}kg</span>` : '', b.expiring_count ? `<span class="tag warn">${b.expiring_count} 批將到期</span>` : ''].join(' ')}</td></tr>
          ${b.lots.map((l) => `<tr class="sub clickable" data-parent="${b.roasted_bean_id}" data-lot="${l.roasted_lot_id}" data-lotno="${esc(l.batch_no)}" hidden>
            <td>${esc(l.batch_no)}</td><td>${esc(l.roast_date)}</td><td>${esc(l.best_before)}</td><td class="num">${pct(l.loss_rate)}</td>
            <td class="num">${fmt(l.unit_cost, 2)}</td><td class="num">${kg(l.opening_qty)}</td>${inCell(l.in_qty)}${outCell(l.out_qty)}
            <td class="num">${kg(l.closing_qty)}</td><td class="num">${money(l.closing_amount)}</td><td>${lotTag(l)}</td></tr>`).join('')}`).join('')}
        <tr class="total"><td>合計</td><td></td><td></td><td></td><td></td><td class="num">${kg(total.opening_qty)}</td>${inCell(total.in_qty)}${outCell(total.out_qty)}
          <td class="num">${kg(total.closing_qty)}</td><td class="num">${money(total.closing_amount)}</td><td></td></tr>
        </tbody></table>`;
      $$('#list tr.bean').forEach((tr) => tr.onclick = () => {
        const subs = $$(`#list tr[data-parent="${tr.dataset.bean}"]`);
        const open = subs[0]?.hidden;
        subs.forEach((x) => (x.hidden = !open));
        tr.cells[0].firstChild.textContent = open ? '▾ ' : '▸ ';
      });
      $$('#list tr.sub').forEach((tr) => tr.onclick = () => movementModal(`熟豆批次 ${tr.dataset.lotno} 異動明細`, { item_type: '熟豆', roasted_lot_id: tr.dataset.lot, ...range }, 'kg'));
      if (data.length === 1) $('#list tr.bean').click();
    } catch (e) { fail(e); }
  };
  $('#search').onclick = load;
  load();
}

// ---------------------------------------------------------------- 期初庫存
async function pageOpening() {
  $('#main').innerHTML = `
    <h2>期初庫存</h2>
    <div class="toolbar">
      <span class="spacer"></span>
      <button id="addBean" class="primary">＋ 新增生豆期初</button>
      <button id="addPack" class="primary">＋ 新增包材期初</button>
    </div>
    <p class="hint">開始使用系統時手上已有的生豆、包材在這裡登錄，不經過進貨單（不算進貨金額、不產生應付帳款）。
      庫存查詢的「期初」是起日之前所有異動的加總，所以<b>期初日期請填開帳日的前一天</b>（例如 11/1 開始記帳就填 10/31），查詢 11/1 之後的區間時這些數量就會出現在「期初」欄。
      生豆期初批號被烘焙使用後會鎖定。點任一列可修改。</p>
    <div class="stats" id="stats"></div>
    <div class="section-title">生豆</div>
    <div class="card"><div class="table-wrap" id="beans"></div></div>
    <div class="section-title">包材</div>
    <div class="card"><div class="table-wrap" id="packs"></div></div>`;

  const load = async () => {
    try {
      const { beans, packaging, summary } = await api('/opening-stock');
      $('#stats').innerHTML = [['生豆期初 kg', '+' + kg(summary.bean_kg)], ['生豆期初金額', money(summary.bean_amount)], ['包材期初金額', money(summary.packaging_amount)]]
        .map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');
      $('#beans').innerHTML = beans.length ? `<table><thead><tr><th>期初日期</th><th>批號</th><th>生豆品項</th><th class="num">期初 kg</th><th class="num">成本/kg</th><th class="num">金額</th><th class="num">目前剩餘 kg</th><th>位置</th><th>備註</th><th>狀態</th></tr></thead><tbody>
        ${beans.map((b) => `<tr class="clickable" data-id="${b.lot_id}"><td>${esc(b.received_date)}</td><td>${esc(b.lot_no)}</td><td>${esc(b.bean_name)}</td>
          <td class="num up">+${kg(b.initial_kg)}</td><td class="num">${fmt(b.unit_cost, 2)}</td><td class="num">${money(b.amount)}</td><td class="num">${kg(b.current_kg)}</td>
          <td>${esc(b.storage_location)}</td><td>${esc(b.note)}</td><td>${b.locked ? '<span class="tag warn">已使用，鎖定</span>' : '<span class="tag">可修改</span>'}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">還沒有生豆期初庫存</div>';
      $('#packs').innerHTML = packaging.length ? `<table><thead><tr><th>期初日期</th><th>包材</th><th class="num">期初數量</th><th>單位</th><th class="num">單價</th><th class="num">金額</th><th>備註</th></tr></thead><tbody>
        ${packaging.map((p) => `<tr class="clickable" data-id="${p.movement_id}"><td>${esc(p.date)}</td><td>${esc(p.packaging_name)}</td>
          <td class="num up">+${fmt(p.qty)}</td><td>${esc(p.unit)}</td><td class="num">${fmt(p.unit_cost, 2)}</td><td class="num">${money(p.amount)}</td><td>${esc(p.note)}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">還沒有包材期初庫存</div>';
      $$('#beans tr.clickable').forEach((tr) => tr.onclick = () => openingForm('生豆', beans.find((b) => b.lot_id === Number(tr.dataset.id)), load));
      $$('#packs tr.clickable').forEach((tr) => tr.onclick = () => openingForm('包材', packaging.find((p) => p.movement_id === Number(tr.dataset.id)), load));
    } catch (e) { fail(e); }
  };
  $('#addBean').onclick = () => openingForm('生豆', null, load);
  $('#addPack').onclick = () => openingForm('包材', null, load);
  load();
}

async function openingForm(type, row, reload) {
  try {
    const isBean = type === '生豆';
    const master = await lookup(isBean ? 'green-beans' : 'packaging-items', true);
    const id = row ? (isBean ? 'g' + row.lot_id : 'p' + row.movement_id) : null;
    const locked = !!row?.locked;
    const dis = locked ? 'disabled' : '';
    const r = row || {};
    const box = openModal(`
      <h2>${row ? '修改' : '新增'}${type}期初庫存</h2>
      ${locked ? '<div class="notice">此批號已被使用（烘焙投入等），只能檢視，無法修改或刪除。</div>' : ''}
      <form id="f">
        <div class="form-grid">
          <label>期初日期 *<input name="date" type="date" required value="${esc(isBean ? r.received_date : r.date) || today()}" ${dis}></label>
          ${isBean
            ? `<label>生豆品項 *<select name="bean_id" required ${dis}>${options(master, 'bean_id', r.bean_id, { blank: '請選擇' })}</select></label>
               <label>批號<input name="lot_no" value="${esc(r.lot_no)}" placeholder="自動產生" ${dis}></label>`
            : `<label>包材 *<select name="packaging_id" required ${dis}>${options(master, 'packaging_id', r.packaging_id, { blank: '請選擇', label: (k) => `${k.name}（${k.unit}）` })}</select></label>`}
          <label>${isBean ? '數量（kg）' : '數量'} *<input name="qty" type="number" step="any" min="0" required value="${esc(isBean ? r.initial_kg : r.qty)}" ${dis}></label>
          <label>${isBean ? '每 kg 成本' : '單價'}<input name="unit_cost" type="number" step="any" min="0" value="${esc(r.unit_cost)}" ${dis}></label>
          <label>金額<input id="amt" disabled></label>
          ${isBean ? `<label>存放位置<input name="storage_location" value="${esc(r.storage_location)}" ${dis}></label>` : ''}
          <label class="full">備註<input name="note" value="${esc(r.note)}" ${dis}></label>
        </div>
        <p class="hint">期初日期請填開帳日的前一天。${isBean ? '每 kg 成本會帶入之後的烘焙成本，請填當初的進貨成本（含運費、稅）。' : ''}</p>
        <div class="form-actions">
          ${row && !locked ? '<button type="button" class="danger" id="del">刪除</button>' : ''}<span class="spacer"></span>
          <button type="button" id="cancel">${locked ? '關閉' : '取消'}</button>${locked ? '' : '<button class="primary">存檔</button>'}
        </div>
      </form>`);
    const f = $('#f', box);
    const calc = () => { $('#amt', box).value = money(r2((Number(f.qty.value) || 0) * (Number(f.unit_cost.value) || 0))); };
    f.qty.oninput = f.unit_cost.oninput = calc;
    if (!isBean) f.packaging_id.onchange = () => { // 帶入包材參考單價
      const k = master.find((x) => x.packaging_id === Number(f.packaging_id.value));
      if (k?.unit_cost != null && !f.unit_cost.value) { f.unit_cost.value = k.unit_cost; calc(); }
    };
    calc();
    $('#cancel', box).onclick = closeModal;
    f.onsubmit = async (e) => {
      e.preventDefault();
      const body = { ...Object.fromEntries(new FormData(f)), item_type: type };
      try {
        await api(id ? `/opening-stock/${id}` : '/opening-stock', { method: id ? 'PUT' : 'POST', body });
        closeModal(); toast('已存檔'); reload();
      } catch (err) { fail(err); }
    };
    if (row && !locked) $('#del', box).onclick = async () => {
      if (!confirm(`確定刪除這筆${type}期初庫存？無法復原。`)) return;
      try { await api(`/opening-stock/${id}`, { method: 'DELETE' }); closeModal(); toast('已刪除'); reload(); } catch (err) { fail(err); }
    };
  } catch (e) { fail(e); }
}

// ---------------------------------------------------------------- 路由
const ROUTES = {
  purchases: pagePurchases,
  sales: pageSales,
  'customer-history': pageCustomerHistory,
  roasts: pageRoasts,
  'opening-stock': pageOpening,
  'stock-beans': pageStockBeans,
  'stock-roasted': pageStockRoasted,
  'stock-packaging': pageStockPackaging,
  ...Object.fromEntries(Object.keys(MASTERS).map((k) => [k, () => pageMaster(k)])),
};

function route() {
  const key = location.hash.slice(1) || 'purchases';
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + key));
  $('#nav').classList.remove('open');
  closeModal();
  (ROUTES[key] || ROUTES.purchases)().catch(fail);
}

window.addEventListener('hashchange', route);
$('#menuBtn').onclick = () => $('#nav').classList.toggle('open');
$('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });
api('/me').then((r) => ($('#who').textContent = r.data.email)).catch(() => {});
route();
