/* ============================================================
   api.js — BACKEND POS (pengganti Code.gs) · Supabase
   Tahap 1: login & bootstrap
   ============================================================ */

const SUPA_URL = 'https://faehyveljmsnmwvgvtqb.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZhZWh5dmVsam1zbm13dmd2dHFiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQzMjAwODUsImV4cCI6MjA5OTg5NjA4NX0.ugt__NEH4nbVzxzqvmCLxSMY0SylvxX5Z_46KKA1KDw';
const PEPPER   = '3RakanKupi_pos_pepper_v1';

/* jalan di Node (untuk tes) maupun browser (untuk aplikasi) */
const _cc = (typeof require !== 'undefined')
  ? require('@supabase/supabase-js').createClient
  : window.supabase.createClient;
const db = _cc(SUPA_URL, SUPA_KEY);

/* ---------- helper ---------- */
const SESSION = {};

async function hashPin(id, pin){
  const txt = PEPPER + ':' + id + ':' + pin;
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(txt));
  const arr = new Uint8Array(buf);
  let s = ''; for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return (typeof btoa !== 'undefined') ? btoa(s) : Buffer.from(arr).toString('base64');
}
function roundRibuan(v){ v=Math.max(0,Math.round(Number(v)||0)); const r=v%1000; return r===0?v:(v-r+(r>=500?1000:0)); }
function need(err){ if (err) throw new Error(err.message); }
function safeUser(u){ return { id:u.id, name:u.name, role:u.role, color:u.color }; }
function requireUser(token){
  const u = SESSION[token];
  if (!u) throw new Error('Sesi berakhir. Silakan login ulang.');
  return u;
}
function isAdminRole(r){ return /admin|owner/i.test(r || ''); }

/* jam ganti hari usaha (dari pengaturan toko) */
let CUTOFF = 7;
function bizShift(d){ return new Date(new Date(d).getTime() - CUTOFF*3600000); }
function bizYmd(d){
  const x = bizShift(d);
  const p = n => String(n).padStart(2,'0');
  return x.getFullYear()+'-'+p(x.getMonth()+1)+'-'+p(x.getDate());
}

/* produk: stok & modal ikut INDUK (Milo Es/Panas satu sachet) */
function mapProduct(p, byId){
  const par  = String(p.stok_induk || '').trim();
  const root = (par && byId[par]) ? byId[par] : p;
  return {
    id:p.id, name:p.name, cat:p.cat,
    price: Number(p.price)||0,
    cost:  (Number(p.cost)||0) || (par && byId[par] ? (Number(byId[par].cost)||0) : 0),
    stock: Number(root.stock)||0,
    min:   Number(p.min)||0,
    active: !!p.active,
    mitra: String(p.mitra||'').trim(),
    mitraCost: Number(p.mitra_cost)||0,
    stokInduk: par,
    indukName: (par && byId[par]) ? String(byId[par].name) : ''
  };
}
function mapTable(t){
  let order = null;
  if (t.status === 'terisi' && t.items) {
    order = { name:t.cust_name, note:t.note, items:t.items,
              opened: t.opened ? new Date(t.opened).getTime() : Date.now() };
  }
  return { no:Number(t.no), status:t.status||'kosong', order:order, kind:t.kind||'meja',
    x: (t.x==null?null:Number(t.x)), y: (t.y==null?null:Number(t.y)),
    shape:t.shape||'square', zone:t.zone||'', label:t.label||'' };
}

async function getShop(){
  const { data, error } = await db.from('settings').select('*');
  need(error);
  const s = {}; (data||[]).forEach(r => s[r.key] = r.value);
  CUTOFF = Number(s['biz_cutoff']) || 7;
  return { name:  String(s['cafe'] || '3 Rakan Kupi'),
           addr:  String(s['alamat'] || ''),
           footer:String(s['struk_footer'] || 'Terima Kasih! 🙏'),
           cutoff: CUTOFF,
           logo:  String(s['shop_logo'] || '') };
}


/* ---------- daftar produk & meja (dipakai berulang) ---------- */
async function getProductsList(){
  const { data, error } = await db.from('products').select('*'); need(error);
  const byId = {}; (data||[]).forEach(p => byId[String(p.id)] = p);
  return (data||[]).map(p => mapProduct(p, byId)).sort((a,b)=>a.name.localeCompare(b.name,'id'));
}
async function getTablesList(){
  const { data, error } = await db.from('tables_').select('*').order('no'); need(error);
  return (data||[]).map(mapTable);
}
async function cleanTabs(){
  await db.from('tables_').delete().eq('kind','tab').eq('status','kosong');
}
async function getUsersFull(){
  const { data } = await db.from('users').select('id,name,role,color,active,phone,created,last_login').order('id');
  return (data||[]).map(u => ({ id:u.id, name:u.name, role:u.role, color:u.color, hasPin:true,
    active:!!u.active, phone:u.phone||'',
    created:u.created?new Date(u.created).getTime():null,
    lastLogin:u.last_login?new Date(u.last_login).getTime():null }));
}

/* ---------- STOK: hormati stok induk & produk mitra ---------- */
async function applyStock(items, original, reason, byName){
  const { data: prods, error } = await db.from('products').select('id,name,stock,cost,mitra,stok_induk');
  need(error);
  const byId = {}; (prods||[]).forEach(p => byId[String(p.id)] = p);
  const rootOf = id => {
    const p = byId[String(id)]; if (!p) return null;
    const par = String(p.stok_induk||'').trim();
    return (par && byId[par]) ? par : String(id);
  };
  const delta = {};
  const add = (arr, sign) => (arr||[]).forEach(it => {
    const p = byId[String(it.id)]; if (!p) return;
    if (String(p.mitra||'').trim() !== '') return;      // mitra: stok tak dilacak
    const r = rootOf(it.id); if (!r) return;
    delta[r] = (delta[r]||0) + sign * (Number(it.qty)||0);
  });
  add(items, 1); add(original, -1);

  const upd = [], logs = [];
  Object.keys(delta).forEach(r => {
    const d = delta[r]; if (!d) return;
    const p = byId[r];
    const after = Math.max(0, (Number(p.stock)||0) - d);
    upd.push({ id: r, stock: after });
    logs.push({ product_id: r, name: p.name, type: (d>0 ? reason : 'Retur'),
      delta: -d, after: after, note: reason, by_user: byName });
  });
  if (upd.length) { const { error: e2 } = await db.from('products').upsert(upd); need(e2); }
  if (logs.length) db.from('stock_log').insert(logs).then(()=>{});   // log jalan di belakang layar
}

/* ---------- nomor struk (ikut hari usaha) ---------- */
async function ymdKey(){
  const x = bizShift(new Date()); const p = n => String(n).padStart(2,'0');
  return '' + x.getFullYear() + p(x.getMonth()+1) + p(x.getDate());
}
async function insertSale(row, prefix){
  const key = await ymdKey();
  for (let i = 0; i < 6; i++) {
    const { count } = await db.from('sales').select('no', { count:'exact', head:true }).like('no', '%'+key+'%');
    const no = (prefix||'') + key + String((count||0)+1+i).padStart(3,'0');
    const { error } = await db.from('sales').insert([ Object.assign({ no: no }, row) ]);
    if (!error) return no;
    if (!/duplicate|unique/i.test(error.message)) throw new Error(error.message);
  }
  throw new Error('Gagal membuat nomor struk, coba lagi.');
}

/* ---------- API (nama fungsi SAMA seperti Code.gs) ---------- */
const API = {

  async getShopPublic(){ return await getShop(); },

  async getStaffTiles(){
    const { data, error } = await db.from('users')
      .select('id,name,role,color').eq('active', true).order('id');
    need(error);
    return data || [];
  },

  async login(staffId, pin){
    const { data, error } = await db.from('users')
      .select('id,name,role,color,active').eq('id', staffId).eq('active', true).maybeSingle();
    need(error);
    if (!data) return null;

    // hash PIN dikunci dari pembacaan publik → verifikasi lewat fungsi server verify_pin
    const h = await hashPin(data.id, pin);
    const { data: ok, error: e2 } = await db.rpc('verify_pin', { uid: data.id, pin_hash: h });
    if (e2) throw new Error(e2.message);
    if (!ok) return null;

    db.from('users').update({ last_login: new Date().toISOString() }).eq('id', data.id).then(()=>{});
    SESSION[data.id] = data;
    return { token: data.id, user: safeUser(data) };
  },

  async bootstrap(token){
    const me = requireUser(token);
    const adm = isAdminRole(me.role);
    const today = bizYmd(new Date());   // CUTOFF sudah terisi saat layar login

    /* SEMUA diambil SERENTAK — 1x waktu tunggu, bukan 5x */
    const [sRes, pRes, tRes, uRes, oRes] = await Promise.all([
      db.from('settings').select('*'),
      db.from('products').select('*'),
      db.from('tables_').select('*').order('no'),
      adm ? db.from('users').select('id,name,role,color,active,phone,created,last_login').order('id') : Promise.resolve({ data:null }),
      db.from('cash_open').select('opening').eq('date', today).maybeSingle()
    ]);
    need(sRes.error); need(pRes.error); need(tRes.error);

    const s = {}; (sRes.data||[]).forEach(r => s[r.key] = r.value);
    CUTOFF = Number(s['biz_cutoff']) || 7;
    const shop = { name:String(s['cafe']||'3 Rakan Kupi'), addr:String(s['alamat']||''),
      footer:String(s['struk_footer']||'Terima Kasih! 🙏'), cutoff:CUTOFF, logo:String(s['shop_logo']||'') };

    const byId = {}; (pRes.data||[]).forEach(p => byId[String(p.id)] = p);
    const products = (pRes.data||[]).map(p => mapProduct(p, byId))
      .sort((a,b) => a.name.localeCompare(b.name, 'id'));
    const tables = (tRes.data||[]).map(mapTable);

    const res = { products, tables, me: safeUser(me), shop, popular: {} };

    if (adm) {
      res.users = (uRes.data||[]).map(u => ({
        id:u.id, name:u.name, role:u.role, color:u.color, hasPin: true,
        active: !!u.active, phone: u.phone || '',
        created:   u.created    ? new Date(u.created).getTime()    : null,
        lastLogin: u.last_login ? new Date(u.last_login).getTime() : null
      }));
    }
    res.openToday = oRes.data ? Number(oRes.data.opening) : null;

    return res;
  }
  ,

  /* ================= KASIR & MEJA ================= */

  async checkout(token, payload){
    const u = requireUser(token);
    const items  = payload.items || [];
    const fromNo = payload.fromNo ? Number(payload.fromNo) : null;

    let original = [];
    if (fromNo) {
      const { data: t } = await db.from('tables_').select('items').eq('no', fromNo).maybeSingle();
      if (t && t.items) original = t.items;
    }
    await applyStock(items, original, fromNo ? ('Penjualan Meja '+fromNo) : 'Penjualan', u.name);

    const no = await insertSale({
      datetime: new Date().toISOString(), kasir: u.name, table: fromNo ? String(fromNo) : '',
      method: payload.method, sub: Number(payload.sub)||0, disc: Number(payload.disc)||0,
      total: Number(payload.total)||0, cash: Number(payload.cash)||0,
      kembalian: Math.max(0, (Number(payload.cash)||0) - (Number(payload.total)||0)),
      items: items, mix: payload.mix || null
    });

    if (fromNo) {
      await db.from('tables_').update({ status:'kosong', cust_name:'', note:'', opened:null, items:null })
        .eq('no', fromNo);
      await cleanTabs();
    }
    return { tables: await getTablesList(), products: await getProductsList(), no: no };
  },

  async saveTableOrder(token, payload){
    const u = requireUser(token);
    const fromNo = payload.fromNo ? Number(payload.fromNo) : null;
    const target = Number(payload.targetNo);
    const items  = payload.items || [];

    let original = [], opened = new Date().toISOString();
    if (fromNo) {
      const { data: ft } = await db.from('tables_').select('items,opened').eq('no', fromNo).maybeSingle();
      if (ft) { if (ft.items) original = ft.items; if (ft.opened) opened = ft.opened; }
    }
    await applyStock(items, original, 'Pesanan meja', u.name);

    if (fromNo && fromNo !== target) {
      await db.from('tables_').update({ status:'kosong', cust_name:'', note:'', opened:null, items:null })
        .eq('no', fromNo);
    }
    const { error } = await db.from('tables_').update({
      status:'terisi', cust_name: payload.name||'', note: payload.note||'',
      opened: opened, items: items
    }).eq('no', target);
    need(error);
    await cleanTabs();
    return { tables: await getTablesList(), products: await getProductsList() };
  },

  async freeTableOrder(token, no){
    const u = requireUser(token);
    no = Number(no);
    const { data: t } = await db.from('tables_').select('items').eq('no', no).maybeSingle();
    if (t && t.items && t.items.length) {
      await applyStock([], t.items, 'Batal Meja '+no, u.name);   // kembalikan stok
    }
    await db.from('tables_').update({ status:'kosong', cust_name:'', note:'', opened:null, items:null })
      .eq('no', no);
    await cleanTabs();
    return { tables: await getTablesList(), products: await getProductsList() };
  },

  async createTab(token, payload){
    const u = requireUser(token);
    const items = payload.items || [];
    if (!items.length) throw new Error('Keranjang kosong.');
    if (!payload.name)  throw new Error('Nama pemesan wajib diisi.');
    await applyStock(items, [], 'Pesanan tanpa meja', u.name);

    const { data: mx } = await db.from('tables_').select('no').order('no', { ascending:false }).limit(1);
    const next = (mx && mx.length ? Number(mx[0].no) : 0) + 1;
    const { error } = await db.from('tables_').insert([{
      no: next, status:'terisi', cust_name: payload.name, note: payload.note||'',
      opened: new Date().toISOString(), items: items,
      x: null, y: null, shape:'square', zone:'', label: payload.name, kind:'tab'
    }]);
    need(error);
    return { tables: await getTablesList(), products: await getProductsList() };
  },

  async splitCheckout(token, payload){
    const u = requireUser(token);
    const tableNo = Number(payload.tableNo);
    const { data: t } = await db.from('tables_').select('*').eq('no', tableNo).maybeSingle();
    if (!t || t.status !== 'terisi') throw new Error('Meja tidak aktif.');

    let cur = t.items || [];
    const payItems = (payload.items||[]).filter(it => Number(it.qty) > 0);
    if (!payItems.length) throw new Error('Pilih item yang mau dibayar dulu.');

    /* item TAMBAHAN (belum ada di meja) → potong stok sekarang */
    const extra = [];
    payItems.forEach(pi => {
      const it   = cur.filter(c => String(c.id) === String(pi.id))[0];
      const have = it ? Number(it.qty) : 0;
      const use  = Math.min(have, Number(pi.qty));
      if (it) it.qty = have - use;
      const ex = Number(pi.qty) - use;
      if (ex > 0) extra.push({ id: pi.id, qty: ex });
    });
    cur = cur.filter(c => Number(c.qty) > 0);
    if (extra.length) await applyStock(extra, [], 'Split tambahan', u.name);

    const no = await insertSale({
      datetime: new Date().toISOString(), kasir: u.name, table: String(tableNo),
      method: payload.method, sub: Number(payload.sub)||0, disc: Number(payload.disc)||0,
      total: Number(payload.total)||0, cash: Number(payload.cash)||0,
      kembalian: Math.max(0, (Number(payload.cash)||0) - (Number(payload.total)||0)),
      items: payItems, mix: payload.mix || null
    });

    if (cur.length === 0) {
      await db.from('tables_').update({ status:'kosong', cust_name:'', note:'', opened:null, items:null })
        .eq('no', tableNo);
    } else {
      await db.from('tables_').update({ items: cur }).eq('no', tableNo);
    }
    await cleanTabs();
    return { tables: await getTablesList(), products: await getProductsList(), no: no, remaining: cur.length };
  },

  async setTableStatus(token, no, status){
    requireUser(token);
    const { data: t } = await db.from('tables_').select('status').eq('no', Number(no)).maybeSingle();
    if (t && t.status !== 'terisi') {
      need(( await db.from('tables_').update({ status: status }).eq('no', Number(no)) ).error);
    }
    return { tables: await getTablesList() };
  },

  async addTable(token){
    requireUser(token);
    const { data: mx } = await db.from('tables_').select('no').order('no', { ascending:false }).limit(1);
    const next = (mx && mx.length ? Number(mx[0].no) : 0) + 1;
    need(( await db.from('tables_').insert([{ no: next, status:'kosong', x:50, y:50,
      shape:'square', zone:'', label:'', kind:'meja' }]) ).error);
    return { tables: await getTablesList() };
  },

  async removeTable(token, no){
    requireUser(token);
    const { data: t } = await db.from('tables_').select('status').eq('no', Number(no)).maybeSingle();
    if (t && t.status === 'terisi') throw new Error('Kosongkan meja dulu sebelum dihapus.');
    need(( await db.from('tables_').delete().eq('no', Number(no)) ).error);
    return { tables: await getTablesList() };
  },

  async saveLayout(token, layout){
    const u = requireUser(token);
    if (!isAdminRole(u.role)) throw new Error('Akses ditolak — khusus Admin/Owner.');
    const rows = (layout||[]).map(L => ({ no: Number(L.no), x: Number(L.x)||0, y: Number(L.y)||0,
      shape: L.shape||'square', zone: L.zone||'', label: L.label||'' }));
    if (rows.length) need(( await db.from('tables_').upsert(rows) ).error);
    return { tables: await getTablesList() };
  },

  /* ================= TUTUP KAS ================= */

  async getCashSummary(token, ymdStr){
    requireUser(token);
    const day = ymdStr || bizYmd(new Date());
    const dcal = d => { const x=new Date(d); const p=n=>String(n).padStart(2,'0'); return x.getFullYear()+'-'+p(x.getMonth()+1)+'-'+p(x.getDate()); };
    const [salesRes, prodRes, expRes, ccRes, coRes] = await Promise.all([
      db.from('sales').select('*'),
      db.from('products').select('id,price,mitra,mitra_cost'),
      db.from('expenses').select('*'),
      db.from('cash_close').select('*').eq('date', day),
      db.from('cash_open').select('*').eq('date', day).maybeSingle()
    ]);
    need(salesRes.error);
    const sales = (salesRes.data||[]).filter(s => s.datetime && bizYmd(s.datetime)===day);
    const byMethod = {}; let total = 0;
    sales.forEach(s => { const t=Number(s.total)||0; total+=t;
      const mix = (String(s.method)==='Campur' && s.mix) ? s.mix : null;
      if (mix) Object.keys(mix).forEach(k => byMethod[k]=(byMethod[k]||0)+(Number(mix[k])||0));
      else { const m=s.method||'Lainnya'; byMethod[m]=(byMethod[m]||0)+t; }
    });
    const prodM = {}; (prodRes.data||[]).forEach(p => { const m=String(p.mitra||'').trim(); if(m) prodM[String(p.id)]={m:m,c:Number(p.mitra_cost)||0}; });
    const titipanByMitra = {};
    sales.forEach(s => (s.items||[]).forEach(it => { const pm=prodM[String(it.id)]; if(pm){ const per=pm.c>0?pm.c:Number(it.price); titipanByMitra[pm.m]=(titipanByMitra[pm.m]||0)+Number(it.qty)*per; } }));
    const titipanPayByMitra = {}; let titipanMitra = 0;
    Object.keys(titipanByMitra).forEach(m => { titipanPayByMitra[m]=roundRibuan(titipanByMitra[m]); titipanMitra+=titipanPayByMitra[m]; });
    const expRows = (expRes.data||[]).filter(e => e.date && dcal(e.date)===day);
    const expenses = expRows.filter(e => e.type!=='Bulanan').reduce((a,e)=>a+(Number(e.amount)||0),0);
    const expensesBulanan = expRows.filter(e => e.type==='Bulanan').reduce((a,e)=>a+(Number(e.amount)||0),0);
    const z = (ccRes.data && ccRes.data[0]) ? ccRes.data[0] : null;
    const closed = z ? { by:z.by_user||'', opening:Number(z.opening)||0, counted:Number(z.counted)||0, note:z.note||'', datetime: z.datetime?new Date(z.datetime).getTime():null } : null;
    const openingFloat = coRes.data ? (Number(coRes.data.opening)||0) : null;
    return { date:day, count:sales.length, total:total, byMethod:byMethod, cashSales:byMethod['Tunai']||0,
      expenses:expenses, expensesBulanan:expensesBulanan, closed:closed, openingFloat:openingFloat,
      titipanMitra:titipanMitra, titipanByMitra:titipanByMitra, titipanPayByMitra:titipanPayByMitra };
  },

  async openShiftCash(token, payload){
    const u = requireUser(token);
    const day = String((payload && payload.date) || bizYmd(new Date()));
    const opening = Number(payload && payload.opening)||0;
    need(( await db.from('cash_open').upsert({ date:day, opening:opening, by_user:u.name, datetime:new Date().toISOString() }) ).error);
    return { date:day, opening:opening };
  },

  async closeShift(token, payload){
    const u = requireUser(token);
    const s = await API.getCashSummary(token, payload.date);
    const opening = Number(payload.opening)||0, counted = Number(payload.counted)||0;
    let titipan = Number(s.titipanMitra)||0, payMap = s.titipanPayByMitra||{};
    if (payload.titipanPayByMitra && Object.keys(payload.titipanPayByMitra).length){
      payMap = {}; let t=0; Object.keys(payload.titipanPayByMitra).forEach(m => { const v=Number(payload.titipanPayByMitra[m])||0; payMap[m]=v; t+=v; }); titipan=t;
    }
    const expected = opening + s.cashSales - s.expenses - titipan;
    const selisih = counted - expected;
    const { data: ex } = await db.from('cash_close').select('id').eq('date', s.date).maybeSingle();
    const rec = { id: ex ? ex.id : ('Z'+Date.now()), datetime:new Date().toISOString(), by_user:u.name, date:s.date,
      count:s.count, total_sales:s.total, cash_sales:s.cashSales, non_cash:s.total-s.cashSales, expenses:s.expenses,
      opening:opening, expected:expected, counted:counted, selisih:selisih, note:payload.note||'',
      by_method:s.byMethod, titipan_mitra:titipan, titipan:payMap };
    need(( await db.from('cash_close').upsert(rec) ).error);
    return { by:u.name, date:s.date, count:s.count, totalSales:s.total, cashSales:s.cashSales,
      nonCash:s.total-s.cashSales, expenses:s.expenses, opening:opening, expected:expected,
      counted:counted, selisih:selisih, note:payload.note||'', byMethod:s.byMethod,
      titipanMitra:titipan, titipanByMitra:payMap, datetime:Date.now() };
  },

  async getCashCloses(token, fromYmd, toYmd){
    requireUser(token);
    const dcal = v => { const x=new Date(v); const p=n=>String(n).padStart(2,'0'); return x.getFullYear()+'-'+p(x.getMonth()+1)+'-'+p(x.getDate()); };
    const { data, error } = await db.from('cash_close').select('*').gte('date', fromYmd).lte('date', toYmd);
    need(error);
    return (data||[]).map(z => ({
      id:z.id, datetime:z.datetime?new Date(z.datetime).getTime():null, by:z.by_user||'', date:dcal(z.date),
      count:Number(z.count)||0, totalSales:Number(z.total_sales)||0, cashSales:Number(z.cash_sales)||0,
      nonCash:Number(z.non_cash)||0, expenses:Number(z.expenses)||0, opening:Number(z.opening)||0,
      expected:Number(z.expected)||0, counted:Number(z.counted)||0, selisih:Number(z.selisih)||0,
      note:z.note||'', byMethod:z.by_method||{}, titipanMitra:Number(z.titipan_mitra)||0, titipanByMitra:z.titipan||{}
    })).sort((a,b)=> b.date.localeCompare(a.date) || ((b.datetime||0)-(a.datetime||0)));
  },

  /* ================= RIWAYAT & REFUND ================= */

  async getSalesHistory(token, fromYmd, toYmd){
    requireUser(token);
    const { data, error } = await db.from('sales').select('*');
    need(error);
    return (data||[]).filter(s => s.datetime).map(s => ({
      no:String(s.no), datetime:new Date(s.datetime).getTime(), kasir:s.kasir||'', table:s.table||'',
      method:(function(){ if(String(s.method)==='Campur' && s.mix){ const ks=Object.keys(s.mix);
        if(ks.length) return 'Campur: '+ks.map(k=>k+' '+(Number(s.mix[k])||0).toLocaleString('id-ID')).join(' + '); }
        return s.method||''; })(),
      sub:Number(s.sub)||0, disc:Number(s.disc)||0, total:Number(s.total)||0,
      cash:Number(s.cash)||0, kembalian:Number(s.kembalian)||0, items: s.items||[]
    })).filter(s => { const k=bizYmd(s.datetime); return k>=fromYmd && k<=toYmd; })
      .sort((a,b)=> b.datetime-a.datetime);
  },

  async processRefund(token, payload){
    const u = requireUser(token);
    const { data: orig } = await db.from('sales').select('*').eq('no', String(payload.saleNo)).maybeSingle();
    if (!orig) throw new Error('Transaksi asal tidak ditemukan.');
    if (Number(orig.total) < 0) throw new Error('Transaksi ini sudah berupa refund, tidak bisa di-refund lagi.');
    if (String(orig.table) === 'HUTANG') throw new Error('Ini pelunasan hutang. Batalkan lewat menu Hutang → tombol "Batal Lunas".');
    const items = (payload.items||[]).filter(it => Number(it.qty) > 0);
    if (!items.length) throw new Error('Pilih item yang akan di-refund.');
    const amount = items.reduce((a,it)=>a+Number(it.qty)*Number(it.price),0);
    if (payload.returnStock) await applyStock([], items.map(it=>({id:it.id,qty:it.qty})), 'Refund '+orig.no, u.name);
    let negMix = null;
    if (String(orig.method)==='Campur' && orig.mix){ negMix={}; const tot=Number(orig.total)||1;
      Object.keys(orig.mix).forEach(k => negMix[k] = -Math.round((Number(orig.mix[k])||0)*amount/tot)); }
    const negItems = items.map(it => ({ id:it.id, name:it.name, qty:-Number(it.qty), price:Number(it.price) }));
    const no = await insertSale({ datetime:new Date().toISOString(), kasir:u.name, table:'REFUND',
      method:orig.method||'Tunai', sub:-amount, disc:0, total:-amount, cash:-amount, kembalian:0,
      items:negItems, mix:negMix }, 'R');
    db.from('refunds').insert([{ id:'RF'+Date.now(), datetime:new Date().toISOString(), orig_no:orig.no,
      by_user:u.name, amount:amount, reason:payload.reason||'', stock_returned:!!payload.returnStock, items:items }]).then(()=>{});
    return { no:no, amount:amount, products: await getProductsList() };
  },

  /* ================= INVENTORY ================= */

  async restock(token, id, qty){
    const u = requireUser(token);
    if (!isAdminRole(u.role)) throw new Error('Akses ditolak — khusus Admin/Owner.');
    qty = Number(qty); if (!(qty > 0)) throw new Error('Jumlah tidak valid.');
    const { data: prods } = await db.from('products').select('id,name,stock,cost,stok_induk');
    const byId = {}; (prods||[]).forEach(p => byId[String(p.id)] = p);
    const par = String((byId[String(id)]||{}).stok_induk||'').trim();
    const rid = (par && byId[par]) ? par : String(id);
    const p = byId[rid]; if (!p) throw new Error('Produk tidak ditemukan.');
    const after = (Number(p.stock)||0) + qty;
    need(( await db.from('products').update({ stock: after }).eq('id', rid) ).error);
    db.from('stock_log').insert([{ product_id:rid, name:p.name, type:'Masuk', delta:qty, after:after, note:'Restock', by_user:u.name }]).then(()=>{});
    if (Number(p.cost) > 0)
      db.from('expenses').insert([{ id:'E'+Date.now(), date: bizYmd(new Date()), cat:'Belanja Stok',
        name:p.name, amount: qty*Number(p.cost), note:'Restock', by_user:u.name, type:'Harian', untuk:'' }]).then(()=>{});
    return { products: await getProductsList() };
  },

  async opname(token, id, fisik){
    const u = requireUser(token);
    if (!isAdminRole(u.role)) throw new Error('Akses ditolak — khusus Admin/Owner.');
    const { data: prods } = await db.from('products').select('id,name,stock,mitra,stok_induk');
    const byId = {}; (prods||[]).forEach(p => byId[String(p.id)] = p);
    const p = byId[String(id)];
    if (!p) throw new Error('Produk tidak ditemukan.');
    if (String(p.mitra||'').trim() !== '') throw new Error('Produk mitra tidak dilacak stoknya.');
    // kalau produk ini "ikut induk", koreksi diarahkan ke induknya
    const par = String(p.stok_induk||'').trim();
    const target = (par && byId[par]) ? byId[par] : p;
    const nf = Math.max(0, Math.round(Number(fisik)||0));
    const sys = Number(target.stock)||0;
    const delta = nf - sys;
    need(( await db.from('products').update({ stock: nf }).eq('id', target.id) ).error);
    if (delta !== 0)
      db.from('stock_log').insert([{ product_id:target.id, name:target.name, type:'Opname',
        delta:delta, after:nf, note:'Koreksi stok (sistem '+sys+' → fisik '+nf+')', by_user:u.name }]).then(()=>{});
    return { products: await getProductsList() };
  },

  async saveOpname(token, payload){
    const u = requireUser(token);
    if (!isAdminRole(u.role)) throw new Error('Akses ditolak — khusus Admin/Owner.');
    const items = (payload && payload.items) || [];
    if (!items.length) throw new Error('Belum ada angka fisik yang diisi.');
    const { data: prods } = await db.from('products').select('id,name,stock,mitra,stok_induk');
    const byId = {}; (prods||[]).forEach(p => byId[String(p.id)] = p);
    const upd = [], logs = []; let changed = 0;
    items.forEach(it => {
      const p = byId[String(it.id)]; if (!p) return;
      if (String(p.mitra||'').trim() !== '') return;
      if (String(p.stok_induk||'').trim() !== '') return;
      const fisik = Math.max(0, Math.round(Number(it.fisik)||0));
      const sys = Number(p.stock)||0, delta = fisik - sys;
      if (delta === 0) return;
      upd.push({ id:p.id, stock:fisik }); changed++;
      logs.push({ product_id:p.id, name:p.name, type:'Opname', delta:delta, after:fisik,
        note:'Stok opname (sistem '+sys+' → fisik '+fisik+')', by_user:u.name });
    });
    if (upd.length) need(( await db.from('products').upsert(upd) ).error);
    if (logs.length) db.from('stock_log').insert(logs).then(()=>{});
    return { products: await getProductsList(), changed: changed };
  },

  async getStockLog(token){
    const u = requireUser(token);
    if (!isAdminRole(u.role)) throw new Error('Akses ditolak — khusus Admin/Owner.');
    const { data, error } = await db.from('stock_log').select('*').order('id', { ascending:false }).limit(200);
    need(error);
    return (data||[]).map(l => ({ time: l.time?new Date(l.time).getTime():null, name:l.name, type:l.type,
      delta:Number(l.delta)||0, after:Number(l.after)||0, note:l.note||'', by:l.by_user||'' }));
  },

  /* ================= HUTANG / PIUTANG ================= */

  async getDebts(token){
    requireUser(token);
    const { data, error } = await db.from('debts').select('*');
    need(error);
    return (data||[]).filter(d => String(d.id||'').trim()!=='').map(d => ({
      id:d.id, datetime:d.datetime?new Date(d.datetime).getTime():null, name:String(d.name||''), phone:String(d.phone||''),
      items:d.items||[], total:Number(d.total)||0, paid:!!d.paid,
      paidDate:d.paid_date?new Date(d.paid_date).getTime():null, method:d.method||'', note:d.note||'', by:d.by_user||''
    })).sort((a,b)=> (a.paid-b.paid) || ((b.datetime||0)-(a.datetime||0)));
  },

  async createDebt(token, payload){
    const u = requireUser(token);
    const items = payload.items || [];
    if (!items.length) throw new Error('Keranjang kosong.');
    if (!payload.name)  throw new Error('Nama yang berhutang wajib diisi.');
    const fromNo = payload.fromNo ? Number(payload.fromNo) : null;
    if (fromNo) {
      await db.from('tables_').update({ status:'kosong', cust_name:'', note:'', opened:null, items:null }).eq('no', fromNo);
      await cleanTabs();
    } else {
      await applyStock(items, [], 'Hutang', u.name);
    }
    const total = items.reduce((s,it)=>s+Number(it.qty)*Number(it.price),0);
    need(( await db.from('debts').insert([{ id:'D'+Date.now(), datetime:new Date().toISOString(),
      name:String(payload.name), phone:String(payload.phone||''), items:items, total:total,
      paid:false, paid_date:null, method:'', note:String(payload.note||''), by_user:u.name }]) ).error);
    return { products: await getProductsList(), debts: await API.getDebts(token), tables: await getTablesList() };
  },

  async payDebt(token, id, method, cash){
    const u = requireUser(token);
    const { data: d } = await db.from('debts').select('*').eq('id', String(id)).maybeSingle();
    if (!d) throw new Error('Hutang tidak ditemukan.');
    if (d.paid) throw new Error('Hutang ini sudah lunas.');
    const total = Number(d.total)||0;
    const no = await insertSale({ datetime:new Date().toISOString(), kasir:u.name, table:'HUTANG',
      method:method||'Tunai', sub:total, disc:0, total:total, cash:Number(cash)||total,
      kembalian:Math.max(0,(Number(cash)||total)-total), items:d.items||[], mix:null });
    need(( await db.from('debts').update({ paid:true, paid_date:new Date().toISOString(), method:method||'Tunai' }).eq('id', String(id)) ).error);
    return { debts: await API.getDebts(token), no:no, total:total };
  },

  async unpayDebt(token, id){
    const u = requireUser(token);
    if (!isAdminRole(u.role)) throw new Error('Akses ditolak — khusus Admin/Owner.');
    const { data: d } = await db.from('debts').select('*').eq('id', String(id)).maybeSingle();
    if (!d) throw new Error('Hutang tidak ditemukan.');
    if (!d.paid) throw new Error('Hutang ini belum lunas.');
    const amount = Number(d.total)||0;
    const negItems = (d.items||[]).map(it => ({ id:it.id, name:it.name, qty:-Number(it.qty), price:Number(it.price) }));
    const no = await insertSale({ datetime:new Date().toISOString(), kasir:u.name, table:'HUTANG',
      method:d.method||'Tunai', sub:-amount, disc:0, total:-amount, cash:-amount, kembalian:0, items:negItems, mix:null }, 'B');
    need(( await db.from('debts').update({ paid:false, paid_date:null, method:'' }).eq('id', String(id)) ).error);
    return { debts: await API.getDebts(token), no:no };
  },

  async deleteDebt(token, id){
    const u = requireUser(token);
    if (!isAdminRole(u.role)) throw new Error('Akses ditolak — khusus Admin/Owner.');
    const { data: d } = await db.from('debts').select('*').eq('id', String(id)).maybeSingle();
    if (!d) throw new Error('Hutang tidak ditemukan.');
    if (!d.paid) await applyStock([], (d.items||[]).map(it=>({id:it.id,qty:it.qty})), 'Batal hutang', u.name);
    need(( await db.from('debts').delete().eq('id', String(id)) ).error);
    return { debts: await API.getDebts(token), products: await getProductsList() };
  },

  /* ================= PENGELUARAN ================= */

  async getExpenses(token, fromYmd, toYmd){
    const u = requireUser(token);
    if (!isAdminRole(u.role)) throw new Error('Akses ditolak — khusus Admin/Owner.');
    const dcal = d => { const x=new Date(d); const p=n=>String(n).padStart(2,'0'); return x.getFullYear()+'-'+p(x.getMonth()+1)+'-'+p(x.getDate()); };
    const { data, error } = await db.from('expenses').select('*').gte('date', fromYmd).lte('date', toYmd);
    need(error);
    return (data||[]).filter(e => e.date).map(e => ({
      id:e.id||'', date:new Date(e.date).getTime(), cat:e.cat||'Lain-lain', name:e.name||'',
      amount:Number(e.amount)||0, note:e.note||'', by:e.by_user||'',
      type:(e.type==='Bulanan'?'Bulanan':'Harian'), untuk:String(e.untuk||'')
    })).sort((a,b)=> b.date-a.date);
  },

  async addExpense(token, payload){
    const u = requireUser(token);
    if (!isAdminRole(u.role)) throw new Error('Akses ditolak — khusus Admin/Owner.');
    const amount = Number(payload.amount)||0;
    if (!payload.name) throw new Error('Keterangan wajib diisi.');
    if (!(amount > 0)) throw new Error('Jumlah harus lebih dari 0.');
    const day = payload.date || bizYmd(new Date());
    need(( await db.from('expenses').insert([{ id:'E'+Date.now()+Math.floor(Math.random()*1000), date:day,
      cat:payload.cat||'Lain-lain', name:payload.name, amount:amount, note:payload.note||'', by_user:u.name,
      type:(payload.type==='Bulanan'?'Bulanan':'Harian'), untuk:String(payload.untuk||'') }]) ).error);
    return { ok:true };
  },

  async updateExpense(token, id, payload){
    const u = requireUser(token);
    if (!isAdminRole(u.role)) throw new Error('Akses ditolak — khusus Admin/Owner.');
    const amount = Number(payload.amount)||0;
    if (!payload.name) throw new Error('Keterangan wajib diisi.');
    if (!(amount > 0)) throw new Error('Jumlah harus lebih dari 0.');
    const upd = { cat:payload.cat||'Lain-lain', name:payload.name, amount:amount, note:payload.note||'',
      type:(payload.type==='Bulanan'?'Bulanan':'Harian') };
    if (payload.date) upd.date = payload.date;
    if (payload.untuk !== undefined) upd.untuk = String(payload.untuk||'');
    need(( await db.from('expenses').update(upd).eq('id', String(id)) ).error);
    return { ok:true };
  },

  async deleteExpense(token, id){
    const u = requireUser(token);
    if (!isAdminRole(u.role)) throw new Error('Akses ditolak — khusus Admin/Owner.');
    need(( await db.from('expenses').delete().eq('id', String(id)) ).error);
    return { ok:true };
  },

  async quickCashOut(token, payload){
    const u = requireUser(token);
    const amount = Number(payload && payload.amount)||0;
    if (!(amount > 0)) throw new Error('Jumlah harus lebih dari 0.');
    const day = payload.date || bizYmd(new Date());
    need(( await db.from('expenses').insert([{ id:'E'+Date.now()+Math.floor(Math.random()*1000), date:day,
      cat:payload.cat||'Operasional', name:String(payload.name||'Kas keluar'), amount:amount,
      note:String(payload.note||''), by_user:u.name, type:'Harian', untuk:String(payload.untuk||'') }]) ).error);
    return { ok:true, amount:amount, day:day };
  },

  async getCashOutSummary(token, fromYmd, toYmd){
    requireUser(token);
    const dcal = d => { const x=new Date(d); const p=n=>String(n).padStart(2,'0'); return x.getFullYear()+'-'+p(x.getMonth()+1)+'-'+p(x.getDate()); };
    const { data: us } = await db.from('users').select('name');
    const staf = (us||[]).map(u => String(u.name||'').trim()).filter(x=>x);
    const guess = (e) => {
      const u=String(e.untuk||'').trim(); if(u) return u;
      const t=(String(e.name||'')+' '+String(e.note||'')).toLowerCase();
      for (let i=0;i<staf.length;i++){ if(t.indexOf(staf[i].toLowerCase())>=0) return staf[i]; }
      if (/uang\s*kas|ambil\s*kas|kas\s*harian/.test(t)) return 'KAS';
      if (/makan|nasi|jajan/.test(t)) return '(makan — tanpa nama)';
      return '';
    };
    const { data, error } = await db.from('expenses').select('*').gte('date', fromYmd).lte('date', toYmd);
    need(error);
    const rows = (data||[]).filter(e => e.date && e.type!=='Bulanan');
    const byUntuk={}, byCat={}, hari={}; let total=0;
    const list = rows.map(e => {
      const a=Number(e.amount)||0; total+=a;
      const who=guess(e); if(who) byUntuk[who]=(byUntuk[who]||0)+a;
      const c=e.cat||'Lain-lain'; byCat[c]=(byCat[c]||0)+a;
      const k=dcal(e.date); hari[k]=(hari[k]||0)+a;
      return { id:e.id, date:new Date(e.date).getTime(), cat:c, name:String(e.name||''), amount:a, untuk:who, by:e.by_user||'', note:String(e.note||'') };
    }).sort((a,b)=> b.date-a.date);
    const days=Object.keys(hari).length;
    return { from:fromYmd, to:toYmd, total:total, byUntuk:byUntuk, byCat:byCat, list:list,
      perHari:Object.keys(hari).sort().reverse().map(k=>({d:k,v:hari[k]})), rataHari: days?Math.round(total/days):0 };
  },

  /* ================= KONSUMSI ================= */

  async recordConsumption(token, payload){
    const u = requireUser(token);
    const items = (payload.items||[]).filter(it => Number(it.qty) > 0);
    if (!items.length) throw new Error('Pilih produk yang dikonsumsi.');
    const cat = payload.cat||'Lain-lain', note = payload.note||'';
    const { data: prods } = await db.from('products').select('id,name,stock,cost,price,mitra,mitra_cost,stok_induk');
    const byId = {}; (prods||[]).forEach(p => byId[String(p.id)] = p);
    const rootOf = id => { const p=byId[String(id)]; if(!p) return null; const par=String(p.stok_induk||'').trim(); return (par&&byId[par])?par:String(id); };
    const upd = {}, logs = []; let totQty=0, totCost=0;
    items.forEach(it => {
      const p = byId[String(it.id)]; if (!p) return;
      const q = Number(it.qty)||0; if (q<=0) return;
      if (String(p.mitra||'').trim() !== '') {
        totCost += q * (Number(p.mitra_cost)||Number(p.price)||0);
      } else {
        const r = rootOf(it.id); const rp = byId[r];
        const cur = (upd[r]!=null ? upd[r] : Number(rp.stock)||0);
        upd[r] = Math.max(0, cur - q);
        totCost += q * (Number(rp.cost)||Number(p.cost)||0);
        logs.push({ product_id:rp.id, name:rp.name, type:'Konsumsi', delta:-q, after:upd[r],
          note:cat+(note?(' · '+note):''), by_user:u.name });
      }
      totQty += q;
    });
    const updRows = Object.keys(upd).map(id => ({ id:id, stock:upd[id] }));
    if (updRows.length) need(( await db.from('products').upsert(updRows) ).error);
    if (logs.length) db.from('stock_log').insert(logs).then(()=>{});
    need(( await db.from('consumption').insert([{ id:'K'+Date.now(), datetime:new Date().toISOString(),
      by_user:u.name, cat:cat, note:note, items:items.map(it=>({id:it.id,name:it.name,qty:Number(it.qty)})),
      qty:totQty, cost_value:totCost }]) ).error);
    return { products: await getProductsList(), qty:totQty, costValue:totCost };
  },

  async getConsumption(token, fromYmd, toYmd){
    requireUser(token);
    const { data, error } = await db.from('consumption').select('*');
    need(error);
    return (data||[]).filter(c => c.datetime).map(c => ({
      id:c.id, datetime:new Date(c.datetime).getTime(), by:c.by_user||'', cat:c.cat||'Lain-lain', note:c.note||'',
      qty:Number(c.qty)||0, costValue:Number(c.cost_value)||0, items:c.items||[]
    })).filter(c => { const k=bizYmd(c.datetime); return k>=fromYmd && k<=toYmd; })
      .sort((a,b)=> b.datetime-a.datetime);
  },

  async deleteConsumption(token, id){
    const u = requireUser(token);
    if (!isAdminRole(u.role)) throw new Error('Akses ditolak — khusus Admin/Owner.');
    const { data: c } = await db.from('consumption').select('*').eq('id', String(id)).maybeSingle();
    if (!c) throw new Error('Catatan konsumsi tidak ditemukan.');
    await applyStock([], (c.items||[]).map(it=>({id:it.id,qty:it.qty})), 'Batal konsumsi', u.name);
    need(( await db.from('consumption').delete().eq('id', String(id)) ).error);
    return { products: await getProductsList() };
  },

  /* ================= PENGATURAN TOKO ================= */

  async saveShop(token, payload){
    const u = requireUser(token);
    if (!/owner/i.test(u.role)) throw new Error('Khusus Owner.');
    let c = Number(payload.cutoff); if (isNaN(c)||c<0||c>12) c = 7;
    const rows = [
      { key:'cafe', value: String(payload.name||'').trim() || '3 Rakan Kupi' },
      { key:'alamat', value: String(payload.addr||'').trim() },
      { key:'struk_footer', value: String(payload.footer||'').trim() || 'Terima Kasih! 🙏' },
      { key:'biz_cutoff', value: String(c) }
    ];
    if (payload.logo !== undefined) {
      const lg = String(payload.logo||'');
      if (lg === '' || (lg.indexOf('data:image/')===0 && lg.length <= 2000000)) rows.push({ key:'shop_logo', value: lg });
      else throw new Error('Foto terlalu besar — pilih ulang.');
    }
    need(( await db.from('settings').upsert(rows) ).error);
    CUTOFF = c;
    return await getShop();
  },

  /* ================= STAFF ================= */

  async saveUser(token, payload){
    const me = requireUser(token);
    if (!isAdminRole(me.role)) throw new Error('Akses ditolak — khusus Admin/Owner.');
    const pin = String(payload.pin||'').trim();
    if (!payload.name) throw new Error('Nama wajib diisi.');
    if (/owner/i.test(payload.role) && !/owner/i.test(me.role)) throw new Error('Hanya Owner yang bisa menetapkan role Owner.');
    const { data: users } = await db.from('users').select('id,name,role,color,active,phone,created,last_login');
    const activeOwners = (users||[]).filter(u => u.active && /owner/i.test(u.role)).length;

    if (payload.id) {
      const u = (users||[]).filter(x => String(x.id)===String(payload.id))[0];
      if (!u) throw new Error('Staff tidak ditemukan.');
      if (/owner/i.test(u.role) && !/owner/i.test(me.role)) throw new Error('Akun Owner hanya bisa diubah oleh Owner.');
      if (/owner/i.test(u.role) && (!/owner/i.test(payload.role) || !payload.active) && activeOwners<=1)
        throw new Error('Harus ada minimal 1 Owner aktif.');
      if (pin && !/^\d{4}$/.test(pin)) throw new Error('PIN harus 4 angka.');
      const upd = { name:payload.name, role:payload.role, phone:payload.phone||'', active:!!payload.active };
      if (pin) upd.pin = await hashPin(u.id, pin);
      need(( await db.from('users').update(upd).eq('id', u.id) ).error);
    } else {
      if (!/^\d{4}$/.test(pin)) throw new Error('PIN harus 4 angka.');
      const taken = new Set((users||[]).map(x => String(x.id)));
      let newId = 'U' + Date.now();               // pasti unik (tak mungkin bentrok)
      while (taken.has(newId)) newId = 'U' + (Date.now() + Math.floor(Math.random()*9999));
      const colors = ['#6f5836','#E8733D','#4DABF7','#51CF66','#8B6F47','#b5651d','#3b6fd6','#2f9e44'];
      const cN = (users||[]).length;
      need(( await db.from('users').insert([{ id:newId, name:payload.name, role:payload.role,
        color:colors[cN%colors.length], pin: await hashPin(newId, pin), active:!!payload.active,
        phone:payload.phone||'', created:new Date().toISOString() }]) ).error);
    }
    return { users: await getUsersFull() };
  },

  async resetPin(token, id, newPin){
    const me = requireUser(token);
    if (!isAdminRole(me.role)) throw new Error('Akses ditolak.');
    if (!/^\d{4}$/.test(String(newPin||''))) throw new Error('PIN harus 4 angka.');
    const { data: u } = await db.from('users').select('id,name,role,color,active,phone,created,last_login').eq('id', String(id)).maybeSingle();
    if (!u) throw new Error('Staff tidak ditemukan.');
    if (/owner/i.test(u.role) && !/owner/i.test(me.role)) throw new Error('PIN Owner hanya bisa diatur oleh Owner.');
    need(( await db.from('users').update({ pin: await hashPin(u.id, String(newPin)) }).eq('id', u.id) ).error);
    return { users: await getUsersFull() };
  },

  async toggleUser(token, id){
    const me = requireUser(token);
    if (!isAdminRole(me.role)) throw new Error('Akses ditolak.');
    const { data: users } = await db.from('users').select('id,name,role,color,active,phone,created,last_login');
    const u = (users||[]).filter(x => String(x.id)===String(id))[0];
    if (!u) throw new Error('Staff tidak ditemukan.');
    if (String(u.id)===String(me.id)) throw new Error('Tidak bisa menonaktifkan akun sendiri.');
    if (/owner/i.test(u.role) && !/owner/i.test(me.role)) throw new Error('Akun Owner hanya bisa diatur oleh Owner.');
    const activeOwners = (users||[]).filter(x => x.active && /owner/i.test(x.role)).length;
    if (u.active && /owner/i.test(u.role) && activeOwners<=1) throw new Error('Harus ada minimal 1 Owner aktif.');
    need(( await db.from('users').update({ active: !u.active }).eq('id', u.id) ).error);
    return { users: await getUsersFull() };
  },

  async deleteUser(token, id){
    const me = requireUser(token);
    if (!isAdminRole(me.role)) throw new Error('Akses ditolak.');
    const { data: users } = await db.from('users').select('id,name,role,color,active,phone,created,last_login');
    const u = (users||[]).filter(x => String(x.id)===String(id))[0];
    if (!u) throw new Error('Staff tidak ditemukan.');
    if (String(u.id)===String(me.id)) throw new Error('Tidak bisa menghapus akun sendiri.');
    if (/owner/i.test(u.role) && !/owner/i.test(me.role)) throw new Error('Akun Owner hanya bisa dihapus oleh Owner.');
    const activeOwners = (users||[]).filter(x => x.active && /owner/i.test(x.role)).length;
    if (/owner/i.test(u.role) && activeOwners<=1) throw new Error('Harus ada minimal 1 Owner aktif.');
    need(( await db.from('users').delete().eq('id', u.id) ).error);
    return { users: await getUsersFull() };
  },

  /* ================= MODAL & ASET / NERACA ================= */

  async getCapital(token){
    const u = requireUser(token);
    if (!/owner/i.test(u.role)) throw new Error('Khusus Owner.');
    const [sRes, aRes] = await Promise.all([ db.from('settings').select('*'), db.from('assets').select('*') ]);
    const set = {}; (sRes.data||[]).forEach(s => set[s.key]=s.value);
    const num = k => Number(set[k])||0;
    return {
      values: { modalAwal:num('cap_modalAwal'), setoran:num('cap_setoran'), prive:num('cap_prive'),
        kas:num('cap_kas'), bank:num('cap_bank'), hutangBank:num('cap_hutangBank'), hutangLain:num('cap_hutangLain') },
      assets: (aRes.data||[]).map(a => ({ id:a.id, name:a.name, buyPrice:Number(a.buy_price)||0,
        lifeYears:Number(a.life_years)||0, buyDate: a.buy_date ? String(a.buy_date).slice(0,10) : '' }))
    };
  },

  async saveCapital(token, payload){
    const u = requireUser(token);
    if (!/owner/i.test(u.role)) throw new Error('Khusus Owner.');
    const v = payload.values||{};
    const rows = [
      { key:'cap_modalAwal', value:String(Number(v.modalAwal)||0) }, { key:'cap_setoran', value:String(Number(v.setoran)||0) },
      { key:'cap_prive', value:String(Number(v.prive)||0) }, { key:'cap_kas', value:String(Number(v.kas)||0) },
      { key:'cap_bank', value:String(Number(v.bank)||0) }, { key:'cap_hutangBank', value:String(Number(v.hutangBank)||0) },
      { key:'cap_hutangLain', value:String(Number(v.hutangLain)||0) }
    ];
    need(( await db.from('settings').upsert(rows) ).error);
    const assets = (payload.assets||[]).filter(a => String(a.name||'').trim()!=='').map((a,i)=>({
      id: a.id || ('A'+Date.now()+i), name:String(a.name).trim(), buy_price:Number(a.buyPrice)||0,
      life_years:Number(a.lifeYears)||0, buy_date: a.buyDate || null }));
    await db.from('assets').delete().neq('id', '___none___');   // ganti seluruh daftar aset
    if (assets.length) need(( await db.from('assets').insert(assets) ).error);
    return await API.getCapital(token);
  },

  async getBalanceSheet(token){
    const u = requireUser(token);
    if (!/owner/i.test(u.role)) throw new Error('Khusus Owner.');
    const [sRes, dRes, pRes, aRes, salesRes, expRes] = await Promise.all([
      db.from('settings').select('*'), db.from('debts').select('total,paid'),
      db.from('products').select('stock,cost,stok_induk'), db.from('assets').select('*'),
      db.from('sales').select('total'), db.from('expenses').select('amount,cat')
    ]);
    const set={}; (sRes.data||[]).forEach(s=>set[s.key]=s.value); const num=k=>Number(set[k])||0;
    const allExp = expRes.data||[];
    const priveCat = allExp.filter(x=>String(x.cat)==='Prive (Ambil Pemilik)').reduce((s,x)=>s+(Number(x.amount)||0),0);
    const kas=num('cap_kas'), bank=num('cap_bank');
    const modal=num('cap_modalAwal')+num('cap_setoran');
    const prive=num('cap_prive')+priveCat;
    const hutangBank=num('cap_hutangBank'), hutangLain=num('cap_hutangLain');
    const piutang=(dRes.data||[]).filter(d=>!d.paid).reduce((s,d)=>s+(Number(d.total)||0),0);
    const persediaan=(pRes.data||[]).filter(p=>String(p.stok_induk||'').trim()==='').reduce((s,p)=>s+(Number(p.stock)||0)*(Number(p.cost)||0),0);
    const now=Date.now(); let asetTetap=0;
    (aRes.data||[]).forEach(a=>{ const p=Number(a.buy_price)||0, l=Number(a.life_years)||0;
      if(!a.buy_date){ asetTetap+=p; return; }
      const yrs=(now-new Date(a.buy_date).getTime())/(365.25*86400000);
      const acc=Math.min(p,(l>0?(p/l):0)*Math.max(0,yrs)); asetTetap+=Math.max(0,p-acc); });
    const totalSales=(salesRes.data||[]).reduce((s,x)=>s+(Number(x.total)||0),0);
    const totalExp=allExp.reduce((s,x)=>s+(Number(x.amount)||0),0)-priveCat;
    const labaDitahan=totalSales-totalExp;
    const totalAset=kas+bank+piutang+persediaan+asetTetap;
    const totalLiabilitas=hutangBank+hutangLain;
    const totalEkuitas=modal+labaDitahan-prive;
    return JSON.parse(JSON.stringify({ kas, bank, piutang, persediaan, asetTetap, totalAset,
      hutangBank, hutangLain, totalLiabilitas, modal, labaDitahan, prive, totalEkuitas,
      selisih: totalAset-(totalLiabilitas+totalEkuitas) }));
  },

  /* ================= PERSEDIAAN ================= */

  async getStockReport(token, fromYmd, toYmd){
    const u = requireUser(token);
    if (!isAdminRole(u.role)) throw new Error('Akses ditolak — khusus Admin/Owner.');
    const dcal = d => { const x=new Date(d); const p=n=>String(n).padStart(2,'0'); return x.getFullYear()+'-'+p(x.getMonth()+1)+'-'+p(x.getDate()); };
    const [lRes, pRes] = await Promise.all([
      db.from('stock_log').select('*').order('id', { ascending:true }),
      db.from('products').select('*')
    ]);
    const logById = {};
    (lRes.data||[]).filter(l=>l.time).forEach(l=>{ const id=String(l.product_id);
      (logById[id]=logById[id]||[]).push({ time:new Date(l.time), delta:Number(l.delta)||0, after:Number(l.after)||0 }); });
    const toEnd = new Date(toYmd+'T23:59:59');
    return (pRes.data||[]).filter(p=>String(p.stok_induk||'').trim()==='').map(p=>{
      const ls=logById[String(p.id)]||[]; let masuk=0, keluar=0;
      ls.forEach(l=>{ const k=dcal(l.time); if(k>=fromYmd && k<=toYmd){ if(l.delta>0) masuk+=l.delta; else keluar+=(-l.delta); } });
      const upto=ls.filter(l=>l.time<=toEnd);
      const akhir=upto.length?upto[upto.length-1].after:(Number(p.stock)||0);
      return { name:p.name, cat:p.cat||'', awal:(akhir-masuk+keluar), masuk:masuk, keluar:keluar,
        akhir:akhir, now:Number(p.stock)||0, min:Number(p.min)||0, active:!!p.active };
    }).sort((a,b)=>a.name.localeCompare(b.name));
  },

  /* ================= ANALISA BELANJA ================= */

  async getPurchaseAnalysis(token, winDays){
    const u = requireUser(token);
    if (!isAdminRole(u.role)) throw new Error('Akses ditolak — khusus Admin/Owner.');
    let WIN = Number(winDays)||14; if (WIN<3) WIN=3; if (WIN>60) WIN=60;
    const cut = Date.now() - WIN*86400000;
    const [pRes, sRes, kRes] = await Promise.all([
      db.from('products').select('*'),
      db.from('sales').select('datetime,items').gte('datetime', new Date(cut).toISOString()),
      db.from('consumption').select('datetime,items').gte('datetime', new Date(cut).toISOString())
    ]);
    const byId = {}; (pRes.data||[]).forEach(p => byId[String(p.id)] = p);
    const rootOf = id => { const p=byId[String(id)]; if(!p) return null; const par=String(p.stok_induk||'').trim(); return (par&&byId[par])?par:String(id); };
    const used = {};
    const eat = arr => (arr||[]).forEach(row => (row.items||[]).forEach(it => {
      const q=Number(it.qty)||0; if(q<=0) return; const r=rootOf(it.id);
      if(!r||!byId[r]) return; if(String(byId[r].mitra||'').trim()!=='') return; used[r]=(used[r]||0)+q; }));
    eat(sRes.data); eat(kRes.data);
    const items=[];
    (pRes.data||[]).forEach(p=>{
      if(!p.active) return;
      if(String(p.mitra||'').trim()!=='') return;
      if(String(p.stok_induk||'').trim()!=='') return;
      const id=String(p.id), q=used[id]||0, avg=q/WIN, stock=Number(p.stock)||0;
      items.push({ id:id, name:p.name, cat:p.cat||'', stock:stock, cost:Number(p.cost)||0,
        sold14:q, avgDaily:Math.round(avg*100)/100, daysLeft: avg>0 ? Math.round((stock/avg)*10)/10 : null });
    });
    return { windowDays:WIN, items:items, at:Date.now() };
  },

  /* ================= LAPORAN LABA RUGI ================= */

  async getReport(token, fromYmd, toYmd){
    const usr = requireUser(token);
    if (!isAdminRole(usr.role)) throw new Error('Akses ditolak — khusus Admin/Owner.');
    const fmtM  = d => { const x=new Date(d); const p=n=>String(n).padStart(2,'0'); return x.getFullYear()+'-'+p(x.getMonth()+1); };
    const dcal  = d => { const x=new Date(d); const p=n=>String(n).padStart(2,'0'); return x.getFullYear()+'-'+p(x.getMonth()+1)+'-'+p(x.getDate()); };

    const [salesRes, expRes, prodRes] = await Promise.all([
      db.from('sales').select('*'), db.from('expenses').select('*'), db.from('products').select('*')
    ]);
    const sales = (salesRes.data||[]).filter(s=>s.datetime).map(s=>({
      date:new Date(s.datetime), total:Number(s.total)||0, disc:Number(s.disc)||0,
      method:s.method, mix:s.mix, kasir:s.kasir||'(tanpa nama)', items:s.items||[]
    }));
    const exp = (expRes.data||[]).filter(e=>e.date).map(e=>({ date:new Date(e.date), amount:Number(e.amount)||0, cat:e.cat||'Lain-lain' }));
    const inRange    = d => { const k=dcal(d); return k>=fromYmd && k<=toYmd; };
    const inRangeBiz = d => { const k=bizYmd(d); return k>=fromYmd && k<=toYmd; };

    const prodMitra0 = {}, prodCat = {};
    (prodRes.data||[]).forEach(p => { prodCat[String(p.id)]=p.cat||'';
      const m=String(p.mitra||'').trim(); if(m) prodMitra0[String(p.id)]={m:m,c:Number(p.mitra_cost)||0}; });

    const f = sales.filter(s=>inRangeBiz(s.date));
    const titipanByMitra = {}; let titipanMitra = 0;
    f.forEach(s => { let mp=0;
      s.items.forEach(it => { const pm=prodMitra0[String(it.id)]; if(pm){ const per=pm.c>0?pm.c:Number(it.price); const v=Number(it.qty)*per; mp+=v; titipanByMitra[pm.m]=(titipanByMitra[pm.m]||0)+v; titipanMitra+=v; } });
      s.mitraVal=mp; s.warkopVal=s.total-mp;
    });
    const omzet = f.reduce((a,s)=>a+s.warkopVal,0);
    const disc  = f.reduce((a,s)=>a+s.disc,0);
    const count = f.length, avg = count?omzet/count:0;

    const pay = {}; f.forEach(s => {
      const mix=(String(s.method)==='Campur'&&s.mix)?s.mix:null;
      if (mix && s.total>0){ const fct=s.warkopVal/s.total; Object.keys(mix).forEach(k=>pay[k]=(pay[k]||0)+(Number(mix[k])||0)*fct); }
      else { pay[s.method]=(pay[s.method]||0)+s.warkopVal; }
    });
    const pmap = {}; f.forEach(s => s.items.forEach(it => { if(prodMitra0[String(it.id)]) return;
      if(!pmap[it.name]) pmap[it.name]={qty:0,rev:0}; pmap[it.name].qty+=Number(it.qty); pmap[it.name].rev+=Number(it.qty)*Number(it.price); }));
    const top = Object.keys(pmap).map(n=>({name:n,qty:pmap[n].qty,rev:pmap[n].rev})).sort((a,b)=>b.qty-a.qty);

    const dm = {}; f.forEach(s => { const k=bizYmd(s.date); if(!dm[k])dm[k]={count:0,omzet:0}; dm[k].count++; dm[k].omzet+=s.warkopVal; });
    const daily = Object.keys(dm).map(d=>({d:d,count:dm[d].count,omzet:dm[d].omzet})).sort((a,b)=>b.d.localeCompare(a.d));

    const pengeluaran = exp.filter(e=>inRange(e.date)).reduce((a,e)=>a+e.amount,0);
    const expByCat = {}; exp.filter(e=>inRange(e.date)).forEach(e=>expByCat[e.cat]=(expByCat[e.cat]||0)+e.amount);

    const monMap={}, monExp={};
    sales.forEach(s => { let mp=0; s.items.forEach(it=>{ const pmx=prodMitra0[String(it.id)]; if(pmx) mp+=Number(it.qty)*(pmx.c>0?pmx.c:Number(it.price)); });
      const k=fmtM(bizShift(s.date)); monMap[k]=(monMap[k]||0)+(s.total-mp); });
    exp.forEach(e => { const k=fmtM(e.date); monExp[k]=(monExp[k]||0)+e.amount; });
    const monthsKeys = Object.keys(monMap).concat(Object.keys(monExp)).filter((v,i,a)=>a.indexOf(v)===i).sort().slice(-6).reverse();
    const months = monthsKeys.map(k=>({k:k,omzet:monMap[k]||0,exp:monExp[k]||0}));

    let revMinuman=0, revMakanan=0;
    f.forEach(s => s.items.forEach(it => {
      const pmx=prodMitra0[String(it.id)];
      const v = pmx ? Number(it.qty)*(pmx.c>0?(Number(it.price)-pmx.c):0) : Number(it.qty)*Number(it.price);
      if (v<=0) return;
      if ((prodCat[String(it.id)]||'')==='Makanan') revMakanan+=v; else revMinuman+=v;
    }));
    const hpp = expByCat['Belanja Stok'] || 0;
    const priveAmt = expByCat['Prive (Ambil Pemilik)'] || 0;
    const opCats = {}; Object.keys(expByCat).forEach(c=>{ if(c!=='Belanja Stok' && c!=='Prive (Ambil Pemilik)') opCats[c]=expByCat[c]; });
    const bebanUsaha = pengeluaran - priveAmt;
    const pnl = { revMinuman:revMinuman, revMakanan:revMakanan, grossSales:revMinuman+revMakanan,
      disc:disc, netSales:omzet, hpp:hpp, labaKotor:omzet-hpp,
      opCats:opCats, totalOp:bebanUsaha-hpp, labaBersih:omzet-bebanUsaha, prive:priveAmt };

    const km = {}; f.forEach(s => { const k=s.kasir||'(tanpa nama)'; if(!km[k])km[k]={count:0,omzet:0}; km[k].count++; km[k].omzet+=s.warkopVal; });
    const byKasir = Object.keys(km).map(n=>({name:n,count:km[n].count,omzet:km[n].omzet,avg:km[n].count?km[n].omzet/km[n].count:0})).sort((a,b)=>b.omzet-a.omzet);

    const qtyById={}; f.forEach(s => s.items.forEach(it => { if(prodMitra0[String(it.id)]) return; qtyById[String(it.id)]=(qtyById[String(it.id)]||0)+Number(it.qty); }));
    const slow = (prodRes.data||[]).filter(p=>p.active && String(p.mitra||'').trim()==='')
      .map(p=>({name:p.name, qty:qtyById[String(p.id)]||0, rev:(qtyById[String(p.id)]||0)*(Number(p.price)||0)}))
      .sort((a,b)=>(a.qty-b.qty)||a.name.localeCompare(b.name)).slice(0,3);

    const mitraList = Object.keys(titipanByMitra).map(n=>({name:n,total:titipanByMitra[n],pay:roundRibuan(titipanByMitra[n])})).sort((a,b)=>b.total-a.total);
    const titipanMitraPay = mitraList.reduce((s,m)=>s+m.pay,0);

    return { from:fromYmd, to:toYmd, count, omzet, disc, avg, pay, top, daily, pengeluaran, expByCat, months, pnl, byKasir, titipanMitra, titipanMitraPay, mitraList, slow };
  },

  /* ================= EVALUASI BULANAN (Owner) ================= */

  async getMonthlyReview(token, opts){
    const usr = requireUser(token);
    if (!/owner/i.test(usr.role)) throw new Error('Khusus Owner.');
    if (typeof opts==='string') opts={ym:opts};
    opts = opts||{};
    const pd = n => String(n).padStart(2,'0');
    const ymd2 = d => { const x=new Date(d); return x.getFullYear()+'-'+pd(x.getMonth()+1)+'-'+pd(x.getDate()); };
    let fromY, toY;
    if (opts.from && opts.to){ fromY=String(opts.from); toY=String(opts.to); }
    else {
      const now = bizShift(new Date());
      const ym = opts.ym || (now.getFullYear()+'-'+pd(now.getMonth()+1));
      const dd = new Date(ym+'-01T00:00:00'); const nd = new Date(dd.getFullYear(), dd.getMonth()+1, 0);
      fromY = ym+'-01'; toY = ymd2(nd);
    }
    if (fromY>toY){ const t=fromY; fromY=toY; toY=t; }
    const dayMs=86400000;
    const fd=new Date(fromY+'T00:00:00'), td=new Date(toY+'T00:00:00');
    const lenDays=Math.round((td-fd)/dayMs)+1;
    const pFromY=ymd2(new Date(fd.getTime()-lenDays*dayMs)), pToY=ymd2(new Date(fd.getTime()-dayMs));
    const inCur=k=>k>=fromY&&k<=toY, inPrv=k=>k>=pFromY&&k<=pToY;

    const [salesRes, prodRes, expRes, consRes, ccRes, coRes, debtRes] = await Promise.all([
      db.from('sales').select('*'), db.from('products').select('*'), db.from('expenses').select('*'),
      db.from('consumption').select('*'), db.from('cash_close').select('*'), db.from('cash_open').select('*'),
      db.from('debts').select('total,paid')
    ]);
    const prods = prodRes.data||[]; const byId={}; prods.forEach(p=>byId[String(p.id)]=p);
    const shareOf = it => { const p=byId[String(it.id)]; if(!p) return 0;
      if(String(p.mitra||'').trim()==='') return 0; const c=Number(p.mitra_cost)||0; return Number(it.qty)*(c>0?c:Number(it.price)); };

    const bucket = () => ({omzet:0,count:0,disc:0,refundAmt:0,refundCnt:0,mitra:0,pay:{},days:{},hours:{},prodQty:{}});
    const cur=bucket(), prv=bucket();
    (salesRes.data||[]).forEach(s => {
      if(!s.datetime) return;
      const k=bizYmd(s.datetime); const B=inCur(k)?cur:(inPrv(k)?prv:null); if(!B) return;
      const items=s.items||[]; let mp=0; items.forEach(it=>mp+=shareOf(it));
      const total=Number(s.total)||0, wv=total-mp;
      B.omzet+=wv; B.mitra+=mp; B.disc+=Number(s.disc)||0;
      if(total<0){ B.refundAmt+=-total; B.refundCnt++; } else B.count++;
      const mix=(String(s.method)==='Campur'&&s.mix)?s.mix:null;
      if(mix){ Object.keys(mix).forEach(kk=>B.pay[kk]=(B.pay[kk]||0)+(Number(mix[kk])||0)); }
      else { const mm=s.method||'Lainnya'; B.pay[mm]=(B.pay[mm]||0)+total; }
      B.days[k]=1;
      const h=new Date(s.datetime).getHours();
      if(total>0){ B.hours[h]=(B.hours[h]||0)+wv;
        items.forEach(it=>{ const p=byId[String(it.id)]; if(p&&String(p.mitra||'').trim()==='') B.prodQty[p.name]=(B.prodQty[p.name]||0)+Number(it.qty); }); }
    });

    const expR = (f,t) => { const o={total:0,harian:0,bulanan:0,stok:0};
      (expRes.data||[]).forEach(e=>{ if(!e.date) return; const k=ymd2(e.date); if(k<f||k>t) return;
        const a=Number(e.amount)||0; o.total+=a; if(e.type==='Bulanan')o.bulanan+=a; else o.harian+=a; if((e.cat||'')==='Belanja Stok')o.stok+=a; }); return o; };
    const expC=expR(fromY,toY), expP=expR(pFromY,pToY);
    const consR = (f,t) => { let v=0; (consRes.data||[]).forEach(c=>{ if(!c.datetime)return; const k=bizYmd(c.datetime); if(k>=f&&k<=t) v+=Number(c.cost_value)||0; }); return v; };
    const consC=consR(fromY,toY), consP=consR(pFromY,pToY);

    let closedDays=0,absSel=0,netSel=0,titipanPaid=0;
    (ccRes.data||[]).forEach(z=>{ const k=ymd2(z.date); if(k<fromY||k>toY) return; closedDays++;
      const s=Number(z.selisih)||0; absSel+=Math.abs(s); netSel+=s; titipanPaid+=Number(z.titipan_mitra)||0; });
    let openDays=0; (coRes.data||[]).forEach(o=>{ const k=ymd2(o.date); if(k>=fromY&&k<=toY) openDays++; });
    const piutang = (debtRes.data||[]).filter(x=>!x.paid).reduce((s,x)=>s+(Number(x.total)||0),0);

    const salesDays=Object.keys(cur.days).length;
    const laba=cur.omzet-expC.total, labaP=prv.omzet-expP.total;
    const margin=cur.omzet>0?laba/cur.omzet:0;
    const growth=prv.omzet>0?(cur.omzet-prv.omzet)/prv.omzet:null;
    const qrisShare=(function(){const t=Object.keys(cur.pay).reduce((s,k)=>s+cur.pay[k],0);return t>0?((cur.pay['QRIS']||0)/t):0;})();
    const hoursArr=Object.keys(cur.hours).map(h=>({h:Number(h),v:cur.hours[h]})).sort((a,b)=>b.v-a.v);
    const names={}; Object.keys(cur.prodQty).forEach(n=>names[n]=1); Object.keys(prv.prodQty).forEach(n=>names[n]=1);
    const movers=Object.keys(names).map(n=>({name:n,cur:cur.prodQty[n]||0,prev:prv.prodQty[n]||0,diff:(cur.prodQty[n]||0)-(prv.prodQty[n]||0)})).sort((a,b)=>b.diff-a.diff);
    const dead=(lenDays>=7)?prods.filter(p=>p.active&&String(p.mitra||'').trim()===''&&String(p.stok_induk||'').trim()===''&&!(cur.prodQty[p.name]>0)).map(p=>p.name):[];

    const per=lenDays===1?'hari ini':('periode '+lenDays+' hari');
    const perP='periode sebanding sebelumnya ('+pFromY+' s/d '+pToY+')';
    const ins=[]; let score=100;
    const P=v=>Math.round(v*100);
    const fmtID=n=>Math.round(n).toLocaleString('id-ID');
    if(growth!==null){
      if(growth<=-0.10){ins.push({s:'🔴',t:'Omzet turun '+P(-growth)+'%',d:'DASAR: omzet '+per+' Rp'+fmtID(cur.omzet)+' vs Rp'+fmtID(prv.omzet)+' pada '+perP+'. LANGKAH: cek hari buka ('+salesDays+' hari jualan), jam ramai, dan menu yang melemah.'});score-=15;}
      else if(growth>=0.10){ins.push({s:'🟢',t:'Omzet tumbuh '+P(growth)+'% 🎉',d:'DASAR: Rp'+fmtID(cur.omzet)+' vs Rp'+fmtID(prv.omzet)+' ('+perP+'). LANGKAH: catat apa yang berbeda supaya bisa diulang.'});score+=5;}
      else ins.push({s:'🟢',t:'Omzet stabil ('+(growth>=0?'+':'')+P(growth)+'%)',d:'DASAR: Rp'+fmtID(cur.omzet)+' vs Rp'+fmtID(prv.omzet)+'. LANGKAH: coba 1 eksperimen kecil.'});
    } else ins.push({s:'🟢',t:'Belum ada pembanding',d:'DASAR: tidak ada penjualan pada '+perP+' — wajar bila baru mulai.'});
    if(cur.omzet>0){
      if(margin<0.20){ins.push({s:'🔴',t:'Margin laba tipis: '+P(margin)+'%',d:'DASAR: laba Rp'+fmtID(laba)+' dari omzet Rp'+fmtID(cur.omzet)+' (stok Rp'+fmtID(expC.stok)+'). Sehat umumnya 30%+. LANGKAH: cek harga modal & efisiensi belanja.'});score-=15;}
      else if(margin<0.35){ins.push({s:'🟠',t:'Margin '+P(margin)+'% — bisa ditingkatkan',d:'DASAR: laba Rp'+fmtID(laba)+' / omzet Rp'+fmtID(cur.omzet)+'. LANGKAH: dorong menu margin tinggi.'});score-=7;}
      else ins.push({s:'🟢',t:'Margin sehat: '+P(margin)+'%',d:'DASAR: laba Rp'+fmtID(laba)+' dari omzet Rp'+fmtID(cur.omzet)+'.'});
    }
    const dt=salesDays?closedDays/salesDays:1, dbk=salesDays?openDays/salesDays:1;
    if(salesDays>0){
      if(dt<0.8){ins.push({s:'🔴',t:'Tutup Kas hanya '+closedDays+' dari '+salesDays+' hari',d:'DASAR: '+(salesDays-closedDays)+' hari tanpa tutup kas. LANGKAH: lengkapi lewat Tutup Kas → pilih tanggal.'});score-=15;}
      else if(dt<0.95){ins.push({s:'🟠',t:'Tutup Kas terlewat '+(salesDays-closedDays)+' hari',d:'DASAR: '+closedDays+'/'+salesDays+' hari. LANGKAH: lengkapi tanggal bolong.'});score-=7;}
      else ins.push({s:'🟢',t:'Disiplin Tutup Kas '+P(dt)+'%',d:'DASAR: '+closedDays+'/'+salesDays+' hari ditutup.'});
      if(dbk<0.8){ins.push({s:'🟠',t:'Buka Kas hanya '+openDays+' dari '+salesDays+' hari',d:'DASAR: tanpa modal awal, selisih bias. LANGKAH: ritual 💰 Buka Kas tiap pagi.'});score-=7;}
    }
    if(absSel>300000){ins.push({s:'🔴',t:'Akumulasi selisih kas Rp'+fmtID(absSel),d:'DASAR: total |selisih| '+per+' (bersih '+(netSel>=0?'+':'')+fmtID(netSel)+'). LANGKAH: telusuri pola per hari/shift.'});score-=15;}
    else if(absSel>100000){ins.push({s:'🟠',t:'Akumulasi selisih kas Rp'+fmtID(absSel),d:'DASAR: bersih '+(netSel>=0?'+':'')+fmtID(netSel)+'. Pantau mingguan.'});score-=7;}
    if(cur.omzet>0&&cur.disc/cur.omzet>0.05){ins.push({s:'🟠',t:'Diskon/keringanan '+P(cur.disc/cur.omzet)+'% dari omzet',d:'DASAR: Rp'+fmtID(cur.disc)+'. LANGKAH: tetapkan anggaran traktir.'});score-=7;}
    if(cur.omzet>0&&consC/cur.omzet>0.03){ins.push({s:'🟠',t:'Konsumsi internal Rp'+fmtID(consC)+' ('+P(consC/cur.omzet)+'%)',d:'DASAR: vs sebelumnya Rp'+fmtID(consP)+'. LANGKAH: cek kategori di 🍵 Konsumsi.'});score-=7;}
    if(cur.refundCnt>=5||cur.refundAmt>100000){ins.push({s:'🟠',t:cur.refundCnt+' refund senilai Rp'+fmtID(cur.refundAmt),d:'DASAR: '+P(cur.omzet>0?cur.refundAmt/cur.omzet:0)+'% omzet. LANGKAH: baca alasan di Riwayat.'});score-=7;}
    if(piutang>0&&salesDays>0&&piutang>(cur.omzet/salesDays)*3){ins.push({s:'🟠',t:'Piutang menumpuk Rp'+fmtID(piutang),d:'DASAR: >3 hari omzet. LANGKAH: tagih yang paling lama.'});score-=7;}
    if(dead.length>=3){ins.push({s:'🟠',t:dead.length+' menu tidak laku sama sekali',d:'DASAR: 0 terjual '+per+', contoh: '+dead.slice(0,3).join(', ')+'. LANGKAH: ganti resep/harga/keluarkan.'});score-=5;}
    if(hoursArr.length){const tp=hoursArr.slice(0,2).map(x=>x.h+':00');ins.push({s:'🟢',t:'Jam paling ramai: '+tp.join(' & '),d:'DASAR: omzet per jam. LANGKAH: staf & stok penuh; promo jam sepi.'});}
    if(qrisShare>0.3)ins.push({s:'🟢',t:'QRIS '+P(qrisShare)+'% dari pembayaran',d:'DASAR: non-tunai '+per+'. LANGKAH: rutin tarik saldo & catat di Modal & Aset.'});

    score=Math.max(0,Math.min(100,score));
    const grade=score>=85?'A':score>=70?'B':score>=55?'C':score>=40?'D':'E';
    const gradeNote={A:'Luar biasa — manajemen berjalan. Fokus: pertumbuhan.',B:'Sehat — bereskan catatan 🟠 untuk naik kelas.',C:'Cukup — ada kebocoran disiplin yang harus ditambal.',D:'Rawan — prioritas: disiplin kas & margin.',E:'Darurat — kembali ke dasar: Buka Kas, Tutup Kas, catat semua.'}[grade];

    return { from:fromY, to:toY, prevFrom:pFromY, prevTo:pToY, lenDays:lenDays,
      cur:{omzet:cur.omzet,count:cur.count,avg:cur.count?cur.omzet/cur.count:0,disc:cur.disc,refundAmt:cur.refundAmt,refundCnt:cur.refundCnt,mitra:cur.mitra,exp:expC,cons:consC,laba:laba,margin:margin,salesDays:salesDays,qrisShare:qrisShare},
      prev:{omzet:prv.omzet,count:prv.count,laba:labaP,exp:expP,cons:consP},
      disiplin:{tutup:dt,buka:dbk,closedDays:closedDays,openDays:openDays,absSel:absSel,netSel:netSel},
      titipanPaid:titipanPaid, piutang:piutang,
      movers:{naik:movers.slice(0,3),turun:movers.slice(-3).reverse()}, dead:dead.slice(0,5),
      insights:ins, score:score, grade:grade, gradeNote:gradeNote,
      dasarNilai:'Skor mulai 100: tiap 🔴 −15, tiap 🟠 −5 s/d −7, pertumbuhan ≥10% +5. Periode banding: '+pFromY+' s/d '+pToY+'.' };
  },

  /* ================= KELOLA PRODUK ================= */

  async saveProduct(token, payload){
    const u = requireUser(token);
    if (!isAdminRole(u.role)) throw new Error('Akses ditolak — khusus Admin/Owner.');
    if (!payload.name) throw new Error('Nama produk wajib diisi.');
    if (payload.id){
      const { data: p } = await db.from('products').select('id').eq('id', String(payload.id)).maybeSingle();
      if (!p) throw new Error('Produk tidak ditemukan.');
      let induk = String(payload.stokInduk||'').trim();
      if (induk === String(payload.id)) induk = '';
      if (induk){ const { data: pj } = await db.from('products').select('stok_induk').eq('id', induk).maybeSingle();
        if (pj && String(pj.stok_induk||'').trim()) induk = String(pj.stok_induk).trim(); }
      const upd = { name:payload.name, cat:payload.cat, price:Number(payload.price)||0,
        stock:Number(payload.stock)||0, active:!!payload.active, mitra:String(payload.mitra||'').trim(),
        mitra_cost:Number(payload.mitraCost)||0, stok_induk:induk };
      if (payload.cost!==undefined && payload.cost!=='') upd.cost = Number(payload.cost)||0;
      need(( await db.from('products').update(upd).eq('id', String(payload.id)) ).error);
    } else {
      const { data: all } = await db.from('products').select('id');
      const maxN = (all||[]).reduce((m,p)=>{ const n=parseInt(String(p.id).replace(/\D/g,''))||0; return Math.max(m,n); },0);
      const newId = 'P'+String(maxN+1).padStart(2,'0');
      need(( await db.from('products').insert([{ id:newId, name:payload.name, cat:payload.cat,
        price:Number(payload.price)||0, cost:Number(payload.cost)||0, stock:Number(payload.stock)||0, min:10,
        active:!!payload.active, mitra:String(payload.mitra||'').trim(), mitra_cost:Number(payload.mitraCost)||0,
        stok_induk:String(payload.stokInduk||'').trim() }]) ).error);
    }
    return { products: await getProductsList() };
  },

  async deleteProduct(token, id){
    const u = requireUser(token);
    if (!isAdminRole(u.role)) throw new Error('Akses ditolak — khusus Admin/Owner.');
    need(( await db.from('products').delete().eq('id', String(id)) ).error);
    return { products: await getProductsList() };
  },

  async updateProductSettings(token, id, payload){
    const u = requireUser(token);
    if (!isAdminRole(u.role)) throw new Error('Akses ditolak — khusus Admin/Owner.');
    const upd = {};
    if (payload.min !== undefined)   upd.min = Number(payload.min)||0;
    if (payload.cost !== undefined)  upd.cost = Number(payload.cost)||0;
    if (payload.price !== undefined) upd.price = Number(payload.price)||0;
    if (Object.keys(upd).length) need(( await db.from('products').update(upd).eq('id', String(id)) ).error);
    return { products: await getProductsList() };
  },

  /* ================= BACKUP DATA (Owner) ================= */

  async getBackup(token){
    const u = requireUser(token);
    if (!/owner/i.test(u.role)) throw new Error('Khusus Owner.');
    const tabs = ['products','users','tables_','settings','sales','expenses','stock_log','debts','consumption','cash_close','cash_open','assets'];
    const out = { _app:'3 Rakan Kupi POS', _backupAt:new Date().toISOString(), _by:u.name };
    for (const t of tabs){
      const cols = (t==='users') ? 'id,name,role,color,active,phone,created,last_login' : '*';
      const { data, error } = await db.from(t).select(cols);
      out[t] = error ? [] : (data||[]);
    }
    return out;
  },

  /* ================= DASHBOARD (Owner/Admin) ================= */

  async getDashboard(token){
    const u = requireUser(token);
    if (!isAdminRole(u.role)) throw new Error('Akses ditolak — khusus Admin/Owner.');
    const today = bizYmd(new Date());
    const p7 = new Date(); p7.setDate(p7.getDate()-6);
    const from7 = bizYmd(p7);

    const [salesRes, prodRes, debtRes, expRes, coRes] = await Promise.all([
      db.from('sales').select('datetime,total,method,mix,items,kasir'),
      db.from('products').select('id,name,stock,min,mitra,stok_induk,active'),
      db.from('debts').select('total,paid'),
      db.from('expenses').select('date,amount,type'),
      db.from('cash_open').select('opening').eq('date', today).maybeSingle()
    ]);
    need(salesRes.error);

    const prodM = {}; (prodRes.data||[]).forEach(p => { const m=String(p.mitra||'').trim(); if(m) prodM[String(p.id)]=1; });

    // hari ini
    let omzetToday=0, txToday=0, cashToday=0;
    const payToday={}, byHour={}, prodQty={};
    const daily={}; // 7 hari
    for(let i=0;i<7;i++){ const d=new Date(); d.setDate(d.getDate()-i); daily[bizYmd(d)]=0; }

    (salesRes.data||[]).forEach(s => {
      if(!s.datetime) return;
      const k = bizYmd(s.datetime);
      const t = Number(s.total)||0;
      if(k===today){
        if(t>0){ txToday++; omzetToday+=t;
          const h=new Date(s.datetime).getHours(); byHour[h]=(byHour[h]||0)+t;
        }
        const mix=(String(s.method)==='Campur'&&s.mix)?s.mix:null;
        if(mix){ Object.keys(mix).forEach(m=>{ payToday[m]=(payToday[m]||0)+(Number(mix[m])||0); if(m==='Tunai')cashToday+=Number(mix[m])||0; }); }
        else { const m=s.method||'Lainnya'; payToday[m]=(payToday[m]||0)+t; if(m==='Tunai')cashToday+=t; }
      }
      if(k>=from7 && daily[k]!==undefined && t>0){ daily[k]+=t;
        (s.items||[]).forEach(it=>{ if(prodM[String(it.id)])return; prodQty[it.name]=(prodQty[it.name]||0)+Number(it.qty); });
      }
    });

    // kas laci hari ini = modal awal + tunai - pengeluaran harian hari ini
    const opening = coRes.data ? Number(coRes.data.opening)||0 : 0;
    const expToday = (expRes.data||[]).filter(e=>{ if(!e.date)return false; const k=(new Date(e.date)).toISOString().slice(0,10); return k===today && e.type!=='Bulanan'; }).reduce((a,e)=>a+(Number(e.amount)||0),0);
    const kasLaci = opening + cashToday - expToday;

    // stok menipis
    const lowStock = (prodRes.data||[]).filter(p=> p.active && String(p.mitra||'').trim()==='' && String(p.stok_induk||'').trim()==='' && Number(p.stock) <= Number(p.min||0))
      .map(p=>({name:p.name, stock:Number(p.stock)||0, min:Number(p.min)||0}))
      .sort((a,b)=>a.stock-b.stock);

    // piutang
    const piutang = (debtRes.data||[]).filter(d=>!d.paid).reduce((a,d)=>a+(Number(d.total)||0),0);
    const piutangCount = (debtRes.data||[]).filter(d=>!d.paid).length;

    // chart data
    const chart7 = Object.keys(daily).sort().map(k=>({d:k, v:daily[k]}));
    const topProduk = Object.keys(prodQty).map(n=>({name:n, qty:prodQty[n]})).sort((a,b)=>b.qty-a.qty).slice(0,7);
    const payArr = Object.keys(payToday).map(m=>({name:m, v:payToday[m]}));
    const hours = []; for(let h=6;h<=23;h++) hours.push({h:h, v:byHour[h]||0});

    return {
      today: today,
      cards: { omzet:omzetToday, tx:txToday, kasLaci:kasLaci, lowCount:lowStock.length, piutang:piutang, piutangCount:piutangCount },
      lowStock: lowStock.slice(0,8),
      chart7: chart7,
      topProduk: topProduk,
      pay: payArr,
      hours: hours
    };
  }

};

/* Node (tes) */
if (typeof module !== 'undefined') module.exports = { API, db };
/* Browser (aplikasi) */
if (typeof window !== 'undefined') window.API = API;