// 咖啡烘豆進銷存 — 後台管理（Phase 1）
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
  if (!res.ok) throw new Error(data?.error || `發生錯誤（${res.status}）`);
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
    cols: [['sku', '料號'], ['name', '產品名稱'], ['category', '類別'], ['roast_level', '烘焙度'], ['net_weight_g', '淨重 g', 'num'], ['retail_price', '零售價', 'num'], ['wholesale_price', '批發價', 'num']],
    fields: [
      ['sku', '料號／條碼'], ['name', '產品名稱', 'text', { required: true }],
      ['category', '類別', 'enum', { values: ['單品豆', '綜合豆', '濾掛', '禮盒', '器具', '其他'], noBlank: true }],
      ['roast_level', '烘焙度', 'enum', { values: ROAST }], ['net_weight_g', '每包淨重（g）', 'number'],
      ['retail_price', '零售價', 'number'], ['wholesale_price', '批發價', 'number'], ['shelf_life_days', '賞味期（天，烘焙日起算）', 'number'],
      ['note', '備註', 'textarea', { full: true }],
    ],
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
      else if (type === 'fk') ctl = `<select name="${name}">${options(fkData[o.resource], o.idKey, v)}</select>`;
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
        </div>${prefs}
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
    <p class="hint">庫存由庫存異動加總計算。期初 = 起日前一天的庫存；期末 = 迄日當天結束的庫存。點品項可展開批號，點批號可看異動明細。<span class="up">紅色 = 入庫</span>、<span class="down">綠色 = 出庫</span>。</p>
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
            <td>${esc(l.lot_no)}</td><td>${esc(l.received_date)}</td><td>${esc(l.purchase_no)}</td><td>${esc(l.storage_location)}</td>
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
          <td class="num ${m.qty > 0 ? 'up' : 'down'}">${m.qty > 0 ? '+' : '−'}${money(Math.abs(m.amount))}</td><td>${esc(m.purchase_no)}</td><td>${esc(m.note)}</td><td>${esc(m.created_by)}</td></tr>`).join('')}
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
    <p class="hint">點任一列可看異動明細。Phase 1 只有進貨入庫；包裝耗用於後續階段加入。</p>
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

// ---------------------------------------------------------------- 路由
const ROUTES = {
  purchases: pagePurchases,
  'stock-beans': pageStockBeans,
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
