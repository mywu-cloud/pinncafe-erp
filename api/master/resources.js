// 主檔定義：欄位、型別、列舉值。CRUD 邏輯在 crud.js
// type: text | number | int | bool | date | enum | fk

export const ROAST_LEVELS = ['淺焙', '中焙', '中深焙', '深焙'];
export const GRIND_SIZES = ['原豆', '手沖', '義式', '法壓', '冷萃'];

export const resources = {
  suppliers: {
    table: 'suppliers', pk: 'supplier_id', label: '供應商',
    search: ['name', 'contact_name', 'phone', 'tax_id'],
    fields: {
      name: { type: 'text', required: true },
      tax_id: { type: 'text' }, contact_name: { type: 'text' },
      phone: { type: 'text' }, email: { type: 'text' }, address: { type: 'text' },
      country: { type: 'text' }, payment_terms: { type: 'text' },
      bank_info: { type: 'text' }, note: { type: 'text' },
      is_active: { type: 'bool', default: 1 },
    },
    refs: [
      ['purchases', 'supplier_id', '進貨單'],
      ['green_beans', 'default_supplier_id', '生豆品項'],
      ['packaging_items', 'supplier_id', '包材'],
    ],
  },
  customers: {
    table: 'customers', pk: 'customer_id', label: '客戶',
    search: ['name', 'phone', 'line_id', 'tax_id'],
    fields: {
      name: { type: 'text', required: true },
      customer_type: { type: 'enum', values: ['零售', '批發', '咖啡廳', '電商'], default: '零售' },
      price_level: { type: 'enum', values: ['零售價', '批發價', 'VIP'], default: '零售價' },
      tax_id: { type: 'text' }, phone: { type: 'text' }, email: { type: 'text' },
      line_id: { type: 'text' }, shipping_address: { type: 'text' },
      payment_terms: { type: 'text' }, credit_limit: { type: 'number' },
      birthday: { type: 'date' }, source: { type: 'text' }, note: { type: 'text' },
      is_active: { type: 'bool', default: 1 },
    },
    refs: [],
  },
  'green-beans': {
    table: 'green_beans', pk: 'bean_id', label: '生豆品項',
    search: ['name', 'country', 'region', 'farm'],
    fields: {
      name: { type: 'text', required: true },
      country: { type: 'text' }, region: { type: 'text' }, farm: { type: 'text' },
      process: { type: 'enum', values: ['水洗', '日曬', '蜜處理', '厭氧', '其他'] },
      variety: { type: 'text' }, altitude: { type: 'text' }, crop_year: { type: 'text' },
      cupping_score: { type: 'number' },
      default_supplier_id: { type: 'fk' },
      safety_stock_kg: { type: 'number', default: 0 },
      note: { type: 'text' },
      is_active: { type: 'bool', default: 1 },
    },
    joins: 'LEFT JOIN suppliers s ON s.supplier_id = t.default_supplier_id',
    joinCols: 's.name AS default_supplier_name',
    refs: [
      ['purchase_items', 'bean_id', '進貨明細'],
      ['green_bean_lots', 'bean_id', '生豆批號'],
    ],
  },
  'packaging-items': {
    table: 'packaging_items', pk: 'packaging_id', label: '包材',
    search: ['name'],
    fields: {
      name: { type: 'text', required: true },
      unit: { type: 'text', default: '個' },
      unit_cost: { type: 'number' },
      supplier_id: { type: 'fk' },
      safety_stock: { type: 'int', default: 0 },
      note: { type: 'text' },
      is_active: { type: 'bool', default: 1 },
    },
    joins: 'LEFT JOIN suppliers s ON s.supplier_id = t.supplier_id',
    joinCols: 's.name AS supplier_name',
    refs: [['purchase_items', 'packaging_id', '進貨明細']],
  },
  products: {
    table: 'products', pk: 'product_id', label: '產品',
    search: ['name', 'sku'],
    fields: {
      sku: { type: 'text' },
      name: { type: 'text', required: true },
      category: { type: 'enum', values: ['單品豆', '綜合豆', '濾掛', '禮盒', '器具', '其他'], default: '單品豆' },
      roast_level: { type: 'enum', values: ROAST_LEVELS },
      net_weight_g: { type: 'int' },
      retail_price: { type: 'number' }, wholesale_price: { type: 'number' },
      shelf_life_days: { type: 'int' },
      note: { type: 'text' },
      is_active: { type: 'bool', default: 1 },
    },
    refs: [],
  },
};

export const PREF_FIELDS = {
  roast_level: { type: 'enum', values: ROAST_LEVELS },
  flavor_notes: { type: 'text' },
  grind_size: { type: 'enum', values: GRIND_SIZES },
  brew_method: { type: 'text' },
  favorite_products: { type: 'text' },
  dislikes: { type: 'text' },
  note: { type: 'text' },
};
