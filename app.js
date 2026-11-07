'use strict';
/* ===== ثوابت ===== */
const COLORS = {Red:'RED',Pink:'PNK',White:'WHT',Black:'BLK',Blue:'BLU',Green:'GRN',Beige:'BGE',Purple:'PRP',
  Yellow:'YLW',Gray:'GRY',Orange:'ORG',Brown:'BRN',Tiffany:'TIF',Gold:'GLD',Silver:'SLV',Navy:'NVY',Mint:'MNT',Peach:'PCH'};
const COLOR_AR = {Red:'أحمر',Pink:'وردي',White:'أبيض',Black:'أسود',Blue:'أزرق',Green:'أخضر',Beige:'بيج',Purple:'بنفسجي',
  Yellow:'أصفر',Gray:'رمادي',Orange:'برتقالي',Brown:'بني',Tiffany:'تيفاني',Gold:'ذهبي',Silver:'فضي',Navy:'كحلي',Mint:'نعناعي',Peach:'خوخي'};
const SIZES = ['1M','3M','6M','9M','12M','18M','2Y','3Y','4Y','5Y','6Y','7Y','8Y','9Y','10Y','11Y','12Y','13Y','14Y','16Y','18Y'];
const CATEGORIES = ['Eid Dress','Daily Dress','Wedding Dress','Summer Dress','Winter Dress'];
const CAT_AR = {'Eid Dress':'فستان عيد','Daily Dress':'فستان يومي','Wedding Dress':'فستان زفاف','Summer Dress':'فستان صيفي','Winter Dress':'فستان شتوي'};
const LS_KEY = 'br_items_v1';

/* ===== أدوات ===== */
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num = v => { if (v === '' || v == null) return null; const n = Number(v); return isNaN(n) ? null : n; };
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const money = n => (n == null ? '—' : Number(n).toLocaleString('en-US')) ;
function normColor(c){ if(!c) return ''; c=String(c).trim(); c=c.charAt(0).toUpperCase()+c.slice(1).toLowerCase(); return c; }
function normSize(s){ return s==null?'':String(s).trim().toUpperCase(); }
function normModel(m){ if(m==null||m==='') return ''; const n=Number(m); return isNaN(n)?String(m).trim():String(Math.round(n)); }
function colorCode(c){ return COLORS[c] || (c ? c.replace(/[^A-Za-z]/g,'').slice(0,3).toUpperCase() : ''); }
function skuOf(it){ return (it.model && it.color && it.size) ? `${it.model}-${colorCode(it.color)}-${it.size}` : ''; }
function groupKey(it){ return `${it.model||'?'}-${colorCode(it.color)}`; }
function sizeIdx(s){ const i=SIZES.indexOf(s); return i<0?999:i; }
function toast(msg){ const t=$('#toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(t._h); t._h=setTimeout(()=>t.classList.remove('show'),2200); }
function download(name, blob){ const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name; document.body.appendChild(a); a.click(); setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},1000); }
function today(){ return new Date().toISOString().slice(0,10); }

/* ===== الشعار ===== */
const LOGO = {};
for(const [k,src] of Object.entries({icon:'assets/icon.png', iconBlack:'assets/icon-black.png', full:'assets/logo.png', black:'assets/logo-black.png', white:'assets/logo-white.png', wordBlack:'assets/wordmark-black.png'})){
  const im=new Image(); im.onload=()=>{ LOGO[k]=im; if(k==='iconBlack'||k==='wordBlack') window.renderLabels&&document.querySelector('#tab-labels.active')&&renderLabels(); }; im.src=src; }

/* ===== التخزين ===== */
let items = [];
const CFG = window.APP_CONFIG || {};
const REMOTE = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY && window.supabase);
const sb = REMOTE ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY) : null;
let me = {username:'', role:'admin'};           // في الوضع المحلي: صلاحية كاملة
const isAdmin = () => me.role === 'admin';
let snap = new Map();                            // آخر نسخة متزامنة مع السيرفر: id → JSON

const localItems = () => { try{ return JSON.parse(localStorage.getItem(LS_KEY)) || []; }catch{ return []; } };
let HAS_V2 = !REMOTE;   // هل شُغّل تحديث قاعدة البيانات 002 (التكلفة/الموقع/العمليات)
const nOrNull = v => v==null ? null : Number(v);
const toRow = i => ({id:i.id, sku:skuOf(i)||null, model:i.model||'', brand:i.brand||'', category:i.category||'Eid Dress', color:i.color, size:i.size,
  qty:Math.max(0, Math.round(i.qty||0)), price:i.price, compare_at:i.compareAt, title:i.title||'', descr:i.desc||'', counted:i.counted,
  ...(HAS_V2 ? {location:i.location||'', title_ar:i.titleAr||'', descr_en:i.descEn||''} : {})});   // التكلفة في جدول item_costs (للمدير فقط)
const fromRow = r => ({id:r.id, model:r.model, brand:r.brand, category:r.category, color:r.color, size:r.size, qty:r.qty,
  price:nOrNull(r.price), compareAt:nOrNull(r.compare_at), title:r.title, desc:r.descr, counted:r.counted,
  cost:null, location:r.location||'', titleAr:r.title_ar||'', descEn:r.descr_en||''});
const rowKey = i => JSON.stringify(toRow(i));

async function load(){
  if(!REMOTE){ items = localItems(); return; }
  HAS_V2 = !(await sb.from('movements').select('id').limit(1)).error;
  const all=[]; for(let from=0;;from+=1000){
    const {data,error}=await sb.from('items').select('*').range(from,from+999); if(error) throw error;
    all.push(...data); if(data.length<1000) break; }
  items = all.map(fromRow); snap = new Map(items.map(i=>[i.id,rowKey(i)]));
  if(HAS_V2 && isAdmin()){ const {data}=await sb.from('item_costs').select('item_id,cost'); const m=new Map((data||[]).map(r=>[r.item_id,nOrNull(r.cost)]));
    items.forEach(i=>i.cost=m.get(i.id)??null); }
}
let saving = Promise.resolve();
function save(){
  if(!REMOTE){ localStorage.setItem(LS_KEY, JSON.stringify(items)); renderAll(); return; }
  renderAll();
  saving = saving.then(pushChanges).catch(async err=>{ alert('لم يتم الحفظ: '+(err.message||err)); await load(); renderAll(); });
  return saving;
}
async function pushChanges(){
  const ids=new Set(items.map(i=>i.id));
  const removed=[...snap.keys()].filter(id=>!ids.has(id));
  const changed=items.filter(i=>snap.get(i.id)!==rowKey(i));
  if(removed.length){ const {error}=await sb.from('items').delete().in('id',removed); if(error) throw error; removed.forEach(id=>snap.delete(id)); }
  if(!changed.length) return;
  if(isAdmin()){
    for(let k=0;k<changed.length;k+=500){ const part=changed.slice(k,k+500);
      const {error}=await sb.from('items').upsert(part.map(toRow)); if(error) throw error; part.forEach(i=>snap.set(i.id,rowKey(i))); }
  } else { // الموظف: عدّاد الجرد فقط
    for(const i of changed){
      if(!snap.has(i.id)){ items=items.filter(x=>x!==i); continue; }           // لا يضيف منتجات
      Object.assign(i, fromRow(JSON.parse(snap.get(i.id))), {counted:i.counted}); // يرجّع أي تعديل غير العدّاد
      const {error}=await sb.from('items').update({counted:i.counted}).eq('id',i.id); if(error) throw error; snap.set(i.id,rowKey(i)); }
    renderAll();
  }
}
// تحديثات مباشرة من الأجهزة الأخرى
let rtTimer;
function subscribeRealtime(){
  sb.channel('items-live').on('postgres_changes',{event:'*',schema:'public',table:'items'},p=>{
    if(p.eventType==='DELETE'){ items=items.filter(i=>i.id!==p.old.id); snap.delete(p.old.id); }
    else { const it=fromRow(p.new), ix=items.findIndex(i=>i.id===it.id); if(ix<0) items.push(it); else { it.cost=items[ix].cost; items[ix]=it; } snap.set(it.id,rowKey(it)); }
    clearTimeout(rtTimer); rtTimer=setTimeout(()=>{ if(!document.activeElement?.closest?.('#productList')) renderAll(); },300);
  }).on('postgres_changes',{event:'*',schema:'public',table:'photos'},()=>{ clearTimeout(rtTimer); rtTimer=setTimeout(async()=>{ await refreshPhotos(); thumbUrls.clear(); renderAll(); },500); })
  .subscribe();
}

// IndexedDB للصور
let dbP;
function db(){ return dbP ||= new Promise((res,rej)=>{ const r=indexedDB.open('br_photos',1);
  r.onupgradeneeded=()=>r.result.createObjectStore('photos',{keyPath:'id'}); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); }
async function idb(mode, fn){ const d=await db(); return new Promise((res,rej)=>{ const tx=d.transaction('photos',mode); const st=tx.objectStore('photos'); const out=fn(st); tx.oncomplete=()=>res(out&&out.result!==undefined?out.result:out); tx.onerror=()=>rej(tx.error); }); }
const photosAll = () => idb('readonly', st => st.getAll());
const photoPut = p => idb('readwrite', st => st.put(p));
const photoDel = id => idb('readwrite', st => st.delete(id));

/* ===== إضافة / دمج ===== */
function upsert(rec, addQty=true){
  const sku = skuOf(rec);
  const ex = sku ? items.find(i => skuOf(i) === sku) : null;
  if (ex){
    if (addQty) ex.qty = (ex.qty||0) + (rec.qty||0); else ex.qty = rec.qty;
    for (const k of ['brand','category','price','compareAt','title','desc']) if (ex[k]==null||ex[k]==='') ex[k]=rec[k];
    return ex;
  }
  const it = {id:uid(), model:'', brand:'', category:'Eid Dress', color:'', size:'', qty:0, price:null, compareAt:null, title:'', desc:'', counted:null, ...rec};
  items.push(it); return it;
}
function issuesOf(it){
  const p=[]; if(!it.model) p.push('رقم الموديل'); if(it.price==null) p.push('السعر');
  if(it.qty==null) p.push('الكمية'); if(!it.brand) p.push('البراند'); if(!it.title) p.push('الاسم'); return p;
}

/* ===== التبويبات ===== */
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('#tabs button').forEach(x=>x.classList.toggle('active', x===b));
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active', t.id==='tab-'+b.dataset.tab));
  if (b.dataset.tab!=='count') stopScan();
  renderAll();
});

/* ===== نموذج الإضافة ===== */
function initForm(){
  $('#fCategory').innerHTML = CATEGORIES.map(c=>`<option value="${c}">${CAT_AR[c]} — ${c}</option>`).join('');
  $('#fColor').innerHTML = '<option value="">اختر اللون</option>' + Object.keys(COLORS).map(c=>`<option value="${c}">${COLOR_AR[c]} — ${c}</option>`).join('');
  $('#sizeGrid').innerHTML = SIZES.map(s=>`<label>${s}<input type="number" min="0" inputmode="numeric" data-size="${s}"></label>`).join('');
  $('#fModel').addEventListener('change', () => { // تعبئة تلقائية من موديل موجود
    const m = normModel($('#fModel').value); const ex = items.find(i=>i.model===m); if(!ex) return;
    if(!$('#fBrand').value) $('#fBrand').value = ex.brand||''; $('#fCategory').value = ex.category||'Eid Dress';
    if(!$('#fPrice').value && ex.price!=null) $('#fPrice').value = ex.price;
  });
  $('#btnAdd').onclick = () => {
    const base = {model:normModel($('#fModel').value), brand:$('#fBrand').value.trim(), category:$('#fCategory').value,
      color:$('#fColor').value, price:num($('#fPrice').value), compareAt:num($('#fCompare').value),
      title:$('#fTitle').value.trim(), desc:$('#fDesc').value.trim()};
    if(!base.model) return toast('اكتب رقم الموديل');
    if(!base.color) return toast('اختر اللون');
    let n=0; const added=[];
    document.querySelectorAll('#sizeGrid input').forEach(inp => { const q=num(inp.value); if(q!=null && q>0){ const it=upsert({...base,size:inp.dataset.size,qty:q}); added.push({id:it.id,qty:q}); n++; inp.value=''; } });
    if(!n) return toast('اكتب الكمية لمقاس واحد على الأقل');
    window.lastReceipt = added;   // لطباعة ليبلات القطع المضافة فقط
    save(); toast(`تم حفظ ${n} مقاس للموديل ${base.model} — ليبلاتها في "آخر استلام"`);
  };
}

/* ===== عرض المنتجات ===== */
let photoCache = [];
const blobUrls = new WeakMap();
function photoSrc(p){ if(p.url) return p.url; if(!blobUrls.has(p)) blobUrls.set(p, URL.createObjectURL(p.blob)); return blobUrls.get(p); }
async function photoBlob(p){ return p.blob || await fetch(p.url).then(r=>r.blob()); }
async function refreshPhotos(){
  if(!REMOTE){ photoCache = await photosAll(); return; }
  const {data,error}=await sb.from('photos').select('*'); if(error) throw error;
  photoCache = data.map(r=>({id:r.id, group:r.grp, n:r.n, path:r.path, shot:r.shot||'other', url:sb.storage.from('photos').getPublicUrl(r.path).data.publicUrl}));
}
async function addPhoto(group, blob, shot='other'){
  const n=Math.max(0,...photoCache.filter(p=>p.group===group).map(p=>p.n))+1, id=`${group}-${n}`;
  if(!REMOTE){ const p={id,group,n,blob,shot,at:Date.now()}; await photoPut(p); photoCache.push(p); return; }
  const path=`${group}/${n}-${Date.now()}.jpg`;
  const up=await sb.storage.from('photos').upload(path, blob, {contentType:'image/jpeg'}); if(up.error) throw up.error;
  const {error}=await sb.from('photos').insert({id,grp:group,n,path,...(HAS_V2?{shot}:{})}); if(error){ await sb.storage.from('photos').remove([path]); throw error; }
  photoCache.push({id,group,n,path,shot,url:sb.storage.from('photos').getPublicUrl(path).data.publicUrl});
}
async function removePhoto(id){
  if(!REMOTE) return photoDel(id);
  const p=photoCache.find(x=>x.id===id); const {error}=await sb.from('photos').delete().eq('id',id); if(error) throw error;
  if(p) await sb.storage.from('photos').remove([p.path]);
}
function groups(list){
  const g = new Map();
  for(const it of list){ const k=groupKey(it); if(!g.has(k)) g.set(k,[]); g.get(k).push(it); }
  for(const arr of g.values()) arr.sort((a,b)=>sizeIdx(a.size)-sizeIdx(b.size));
  return [...g.entries()].sort((a,b)=>a[0].localeCompare(b[0]));
}
function thumbFor(key){ const p=photoCache.find(x=>x.group===key); return p ? photoSrc(p) : ''; }
const thumbUrls = new Map();
function thumb(key){ if(!thumbUrls.has(key)) thumbUrls.set(key, thumbFor(key)); return thumbUrls.get(key); }

function renderProducts(){
  const q = $('#search').value.trim().toLowerCase(), fm = $('#filterModel').value;
  const models = [...new Set(items.map(i=>i.model).filter(Boolean))].sort();
  const cur = fm; $('#filterModel').innerHTML = '<option value="">كل الموديلات</option>' + models.map(m=>`<option ${m===cur?'selected':''}>${esc(m)}</option>`).join('');
  $('#brandList').innerHTML = [...new Set(items.map(i=>i.brand).filter(Boolean))].map(b=>`<option value="${esc(b)}">`).join('');
  const list = items.filter(i => (!fm || i.model===fm) && (!q || [skuOf(i),i.model,i.color,COLOR_AR[i.color],i.size,i.brand,i.title,i.titleAr,i.location].join(' ').toLowerCase().includes(q)));
  // تحذيرات
  const bad = items.filter(i=>issuesOf(i).length);
  const noModel = items.filter(i=>!i.model);
  $('#warnings').innerHTML = bad.length ? `<div class="warnBox">⚠️ <b>${bad.length}</b> صف ينقصه بيانات.
    <ul>${noModel.length?`<li>${noModel.length} بدون رقم موديل — لا يمكن إنشاء كود لها (تظهر بأعلى القائمة تحت "?")</li>`:''}
    <li>${items.filter(i=>i.price==null).length} بدون سعر · ${items.filter(i=>!i.brand).length} بدون براند · ${items.filter(i=>!i.title).length} بدون اسم</li></ul></div>` : '';
  const ro = isAdmin() ? '' : 'disabled';
  $('#productList').innerHTML = groups(list).map(([key, arr]) => {
    const f=arr[0], tot=arr.reduce((s,i)=>s+(i.qty||0),0), t=thumb(key);
    return `<div class="group"><div class="groupHead">
      ${t?`<img src="${t}" alt="">`:''}
      <div style="flex:1"><b>${esc(f.model||'? بدون موديل')}</b> · ${esc(COLOR_AR[f.color]||f.color)} <small>${esc(f.brand||'')} · ${esc(CAT_AR[f.category]||f.category||'')}</small>
      ${f.location?`<span class="badge loc">📍 ${esc(f.location)}</span>`:''}<br>
      <small>${esc(f.titleAr||f.title||'— بدون اسم —')}</small></div>
      <div><b>${tot}</b> <small>قطعة</small>${f.model?` <button class="small adminOnly" data-edit="${esc(key)}">✏️</button>`:''}</div></div>
      <table><tr><th>الكود</th><th>المقاس</th><th>الموديل</th><th>الكمية</th><th>السعر</th><th></th></tr>
      ${arr.map(i=>`<tr data-id="${i.id}"><td class="sku">${esc(skuOf(i)||'—')}</td><td>${esc(i.size)}${typeof reservedQty==='function'&&reservedQty(i.id)?`<span class="badge">محجوز ${reservedQty(i.id)}</span>`:''}</td>
        <td><input data-f="model" value="${esc(i.model)}" inputmode="numeric" ${ro}></td>
        <td><input data-f="qty" type="number" min="0" value="${i.qty??''}" ${ro}></td>
        <td><input data-f="price" type="number" value="${i.price??''}" ${ro}></td>
        <td>${ro?'':`<button class="small" data-del="${i.id}">🗑</button>`}</td></tr>`).join('')}
      </table></div>`;
  }).join('') || '<p class="hint">لا توجد منتجات. أضف موديل من الأعلى أو استورد ملف Excel من تبويب "البيانات".</p>';
}
$('#productList').addEventListener('change', e => {
  const inp=e.target; const tr=inp.closest('tr'); if(!tr||!inp.dataset.f) return;
  const it=items.find(i=>i.id===tr.dataset.id); if(!it) return;
  const f=inp.dataset.f;
  if(f==='model'){
    const m=normModel(inp.value); const target = m ? items.find(i=>i!==it && i.model===m && i.color===it.color && i.size===it.size) : null;
    if(target){ target.qty=(target.qty||0)+(it.qty||0); items=items.filter(i=>i!==it); toast('تم الدمج مع كود موجود'); }
    else { it.model=m; const ref=items.find(i=>i!==it && i.model===m); if(ref){ for(const k of ['brand','price','title','desc','category']) if(it[k]==null||it[k]==='') it[k]=ref[k]; } }
  } else it[f]=num(inp.value);
  save();
});
$('#productList').addEventListener('click', e => {
  const id=e.target.dataset?.del; if(!id) return;
  const it=items.find(i=>i.id===id); if(!confirm(`حذف ${skuOf(it)||it.size}؟`)) return;
  items=items.filter(i=>i.id!==id); save();
});
$('#search').oninput = renderProducts; $('#filterModel').onchange = renderProducts;

/* ===== الجرد ===== */
let scanner=null, lastCode='', lastAt=0, unknown=new Map();
function beep(ok){ try{ const c=new (window.AudioContext||window.webkitAudioContext)(); const o=c.createOscillator(); o.frequency.value=ok?1200:300; o.connect(c.destination); o.start(); setTimeout(()=>{o.stop();c.close();},ok?90:300);}catch{} }
function registerCode(code){
  code=String(code).trim().toUpperCase(); if(!code) return;
  const now=Date.now(); if(code===lastCode && now-lastAt<1500) return; lastCode=code; lastAt=now;
  const it=items.find(i=>skuOf(i)===code); const msg=$('#scanMsg');
  if(it && REMOTE){ // زيادة ذرّية على السيرفر — آمنة عند الجرد من أكثر من جوال
    sb.rpc('count_scan',{p_sku:code}).then(({data,error})=>{
      if(error||!data?.length){ beep(false); msg.innerHTML=`<span class="bad">✖ لم يُحفظ المسح: ${esc(error?.message||code)}</span>`; return; }
      Object.assign(it, fromRow(data[0])); snap.set(it.id,rowKey(it)); beep(true);
      msg.innerHTML=`<span class="ok">✔ ${esc(code)} — العدد: ${it.counted} / ${it.qty??0}</span>`; renderCount(); });
    return; }
  if(it){ it.counted=(it.counted||0)+1; localStorage.setItem(LS_KEY, JSON.stringify(items)); beep(true);
    msg.innerHTML=`<span class="ok">✔ ${esc(code)} — العدد: ${it.counted} / ${it.qty??0}</span>`; renderCount(); renderHead(); }
  else { unknown.set(code,(unknown.get(code)||0)+1); beep(false); msg.innerHTML=`<span class="bad">✖ كود غير معروف: ${esc(code)}</span>`; renderCount(); }
}
async function startScan(){
  if(scanner) return stopScan();
  if(!window.Html5Qrcode) return toast('مكتبة الماسح لم تُحمّل — تحقق من الإنترنت');
  const F=Html5QrcodeSupportedFormats;
  scanner=new Html5Qrcode('reader',{formatsToSupport:[F.CODE_128,F.CODE_39,F.EAN_13,F.QR_CODE],verbose:false});
  try{ await scanner.start({facingMode:'environment'},{fps:10,qrbox:{width:280,height:120}}, registerCode); $('#btnScan').textContent='⏹ إيقاف الكاميرا'; }
  catch(err){ scanner=null; toast('تعذّر فتح الكاميرا: '+err); }
}
async function stopScan(){ if(!scanner) return; try{ await scanner.stop(); scanner.clear(); }catch{} scanner=null; $('#btnScan').textContent='📷 فتح الكاميرا'; }
$('#btnScan').onclick=startScan;
$('#btnManual').onclick=()=>{ registerCode($('#manualCode').value); $('#manualCode').value=''; $('#manualCode').focus(); };
$('#manualCode').addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); $('#btnManual').click(); } });
$('#btnNewCount').onclick=()=>{ if(!confirm('بدء جرد جديد؟ سيتم تصفير عدّاد الجرد لكل الأكواد (الكميات المسجلة لا تتغير).')) return;
  unknown.clear();
  if(REMOTE){ sb.rpc('start_count').then(async({error})=>{ if(error) return alert(error.message); await load(); renderAll(); toast('بدأ جرد جديد'); }); return; }
  items.forEach(i=>i.counted=0); save(); toast('بدأ جرد جديد'); };
$('#btnApplyCount').onclick=()=>{ const c=items.filter(i=>i.counted!=null && i.counted!==i.qty);
  if(!c.length) return toast('لا توجد فروقات');
  if(!confirm(`اعتماد نتائج الجرد؟ سيتم تحديث الكمية لـ ${c.length} كود لتساوي العدد الفعلي.`)) return;
  if(REMOTE){ sb.rpc('apply_count').then(async({data,error})=>{ if(error) return alert(error.message); await load(); renderAll(); toast(`تم تحديث ${data} كود`); }); return; }
  c.forEach(i=>i.qty=i.counted); save(); toast('تم تحديث الكميات'); };
$('#onlyDiff').onchange=renderCount;
function renderCount(){
  const active=items.some(i=>i.counted!=null);
  const coded=items.filter(i=>skuOf(i));
  const counted=coded.reduce((s,i)=>s+(i.counted||0),0), expected=coded.reduce((s,i)=>s+(i.qty||0),0);
  $('#countStats').innerHTML = active ? `<p>تم عدّ <b>${counted}</b> من <b>${expected}</b> قطعة مسجلة · فروقات: <b>${coded.filter(i=>(i.counted||0)!==(i.qty||0)).length}</b> كود
    ${unknown.size?` · <span class="bad">أكواد غير معروفة: ${[...unknown.keys()].map(esc).join('، ')}</span>`:''}</p>` : '<p class="hint">اضغط "بدء جرد جديد" للبدء.</p>';
  if(!active){ $('#countList').innerHTML=''; return; }
  let list=coded.slice().sort((a,b)=>skuOf(a).localeCompare(skuOf(b)));
  if($('#onlyDiff').checked) list=list.filter(i=>(i.counted||0)!==(i.qty||0));
  $('#countList').innerHTML=`<table><tr><th>الكود</th><th>المسجل</th><th>الفعلي</th><th>الفرق</th><th></th></tr>${list.map(i=>{const d=(i.counted||0)-(i.qty||0);
    return `<tr class="${d>0?'diff-pos':d<0?'diff-neg':''}"><td class="sku">${esc(skuOf(i))}</td><td>${i.qty??0}</td><td>${i.counted||0}</td><td><b>${d>0?'+':''}${d}</b></td>
    <td><button class="small" data-dec="${i.id}">−</button> <button class="small" data-inc="${i.id}">+</button></td></tr>`;}).join('')}</table>`;
}
$('#countList').addEventListener('click',e=>{ const id=e.target.dataset.inc||e.target.dataset.dec; if(!id) return;
  const it=items.find(i=>i.id===id); it.counted=Math.max(0,(it.counted||0)+(e.target.dataset.inc?1:-1)); save(); });
$('#btnCountReport').onclick=()=>{
  const rows=items.filter(i=>skuOf(i)).map(i=>({'الكود':skuOf(i),'الموديل':i.model,'اللون':i.color,'المقاس':i.size,'المسجل':i.qty??0,'الفعلي':i.counted??'','الفرق':(i.counted||0)-(i.qty||0)}));
  for(const [c,n] of unknown) rows.push({'الكود':c,'الموديل':'غير معروف','الفعلي':n});
  writeXlsx(`تقرير-الجرد-${today()}.xlsx`, {'الجرد':rows});
};

/* ===== الصور ===== */
let photoTarget=null, photoShot='other';
const SHOTS = {front:'أمام', back:'خلف', detail:'تفاصيل', mannequin:'مانيكان', other:'أخرى'};
async function renderPhotos(){
  const gs=groups(items.filter(i=>i.model));
  const only=$('#onlyNoPhoto').checked;
  const done=gs.filter(([k])=>['front','back','detail'].every(s=>photoCache.some(p=>p.group===k&&p.shot===s))).length;
  $('#photoStats').innerHTML=`<p>مكتمل التصوير (أمام + خلف + تفاصيل): <b>${done}</b> من <b>${gs.length}</b> · إجمالي الصور: <b>${photoCache.length}</b></p>`;
  $('#photoList').innerHTML=gs.filter(([k])=>!only||!photoCache.some(p=>p.group===k)).map(([key,arr])=>{
    const ps=photoCache.filter(p=>p.group===key).sort((a,b)=>a.n-b.n);
    return `<div class="group"><div class="groupHead"><div style="flex:1"><b>${esc(key)}</b> <small>${esc(COLOR_AR[arr[0].color]||'')} · ${esc(arr[0].title||'')}</small></div>
      <span class="pill ${ps.length?'ok':'warn'}">${ps.length} صورة</span></div>
      <div class="shots">${Object.entries(SHOTS).map(([k,v])=>`<button class="${k!=='other'&&ps.some(p=>p.shot===k)?'done':''}" data-shoot="${esc(key)}" data-shot="${k}">${k!=='other'&&ps.some(p=>p.shot===k)?'✓ ':'📷 '}${v}</button>`).join('')}</div>
      ${ps.length?`<div class="photos">${ps.map(p=>`<div class="ph"><img src="${esc(photoSrc(p))}" loading="lazy" alt="${esc(p.id)}"><button data-pdel="${esc(p.id)}">✕</button></div>`).join('')}</div>`:''}</div>`;
  }).join('') || '<p class="hint">لا توجد موديلات مكتملة (برقم موديل) للتصوير.</p>';
}
$('#onlyNoPhoto').onchange=renderPhotos;
$('#photoList').addEventListener('click',async e=>{
  if(e.target.dataset.shoot){ photoTarget=e.target.dataset.shoot; photoShot=e.target.dataset.shot||'other'; $('#photoInput').value=''; $('#photoInput').click(); }
  if(e.target.dataset.pdel){ if(!confirm('حذف الصورة؟')) return; try{ await removePhoto(e.target.dataset.pdel); }catch(err){ return alert('تعذّر الحذف: '+err.message); } await refreshPhotos(); thumbUrls.clear(); renderPhotos(); }
});
function compress(file, max=1600){ return new Promise((res,rej)=>{ const img=new Image(); img.onload=()=>{ const s=Math.min(1,max/Math.max(img.width,img.height));
  const c=document.createElement('canvas'); c.width=Math.round(img.width*s); c.height=Math.round(img.height*s); c.getContext('2d').drawImage(img,0,0,c.width,c.height);
  c.toBlob(b=>{URL.revokeObjectURL(img.src); res(b);},'image/jpeg',0.85); }; img.onerror=rej; img.src=URL.createObjectURL(file); }); }
$('#photoInput').onchange=async e=>{
  const files=[...e.target.files]; if(!files.length||!photoTarget) return;
  toast('جارٍ حفظ الصور…');
  try{ for(const f of files) await addPhoto(photoTarget, await compress(f), photoShot); }
  catch(err){ alert('تعذّر رفع الصورة: '+(err.message||err)); }
  thumbUrls.clear(); toast(`تم حفظ ${files.length} صورة لـ ${photoTarget}`); renderPhotos();
};
$('#btnZip').onclick=async()=>{ if(!photoCache.length) return toast('لا توجد صور');
  toast('جارٍ تجهيز الملف…'); const z=new JSZip(); for(const p of photoCache) z.file(`${p.id}.jpg`, await photoBlob(p)); download(`صور-المنتجات-${today()}.zip`, await z.generateAsync({type:'blob'})); };

/* ===== الليبلات ===== */
const LABEL_PX = {'50x30':[400,240],'40x30':[320,240],'50x40':[400,320]}; // 203dpi ≈ 8px/مم
function labelRows(){
  const m=$('#lModel').value, mode=$('#lMode').value, out=[];
  if(m==='__receipt'){ for(const l of (window.lastReceipt||[])){ const it=items.find(i=>i.id===l.id); if(it) for(let k=0;k<l.qty;k++) out.push(it); } return out; }
  items.filter(i=>skuOf(i) && (!m||i.model===m)).sort((a,b)=>skuOf(a).localeCompare(skuOf(b))).forEach(i=>{
    const n= mode==='qty' ? (i.qty||0) : 1; for(let k=0;k<n;k++) out.push(i); });
  return out;
}
function drawLabel(it, size){
  const [W,H]=LABEL_PX[size]; const c=document.createElement('canvas'); c.width=W; c.height=H; const g=c.getContext('2d');
  g.fillStyle='#fff'; g.fillRect(0,0,W,H); g.fillStyle='#000'; g.textAlign='center';
  // التصميم المعتمد: اسم البراند بخط الشعار أعلى الليبل (بدون أيقونة الوردة)
  if(LOGO.wordBlack){ let w=W*0.88, h=w*LOGO.wordBlack.height/LOGO.wordBlack.width; if(h>H*0.13){ h=H*0.13; w=h*LOGO.wordBlack.width/LOGO.wordBlack.height; } g.drawImage(LOGO.wordBlack,(W-w)/2,H*0.025,w,h); }
  else { g.font=`${Math.round(H*0.11)}px Georgia, serif`; g.fillText('BELLA ROSITA', W/2, H*0.13); }
  const bc=document.createElement('canvas');
  JsBarcode(bc, skuOf(it), {format:'CODE128', displayValue:false, margin:0, height:Math.round(H*0.38), width:2});
  const bw=Math.min(W-20, bc.width); g.drawImage(bc,(W-bw)/2,H*0.17,bw,H*0.38);
  g.font=`bold ${Math.round(H*0.085)}px monospace`; g.fillText(skuOf(it), W/2, H*0.66);
  g.font=`bold ${Math.round(H*0.1)}px Arial`; g.textAlign='left'; g.fillText(`M: ${it.model}   ${it.size}`, 12, H*0.83);
  g.textAlign='right'; g.font=`bold ${Math.round(H*0.14)}px Arial`; g.fillText(it.price!=null?`${it.price} SAR`:'', W-12, H*0.86);
  if(it.brand){ g.textAlign='left'; g.font=`${Math.round(H*0.075)}px Arial`; g.fillText(it.brand, 12, H*0.96); }
  return c;
}
function renderLabels(){
  const models=[...new Set(items.map(i=>i.model).filter(Boolean))].sort(); const cur=$('#lModel').value;
  $('#lModel').innerHTML='<option value="">كل الموديلات</option>'+(window.lastReceipt?.length?`<option value="__receipt" ${cur==='__receipt'?'selected':''}>📦 آخر استلام (${window.lastReceipt.reduce((s,l)=>s+l.qty,0)} قطعة)</option>`:'')+models.map(m=>`<option ${m===cur?'selected':''}>${esc(m)}</option>`).join('');
  const rows=labelRows(); const noPrice=rows.filter(i=>i.price==null).length;
  $('#labelStats').innerHTML=`عدد الليبلات: <b>${rows.length}</b>${noPrice?` · <span class="warn">${noPrice} بدون سعر</span>`:''} · المعاينة تعرض أول 12`;
  const box=$('#labelPreview'); box.innerHTML='';
  if(window.JsBarcode) [...new Map(rows.map(r=>[r.id,r])).values()].slice(0,12).forEach(r=>box.appendChild(drawLabel(r,$('#lSize').value)));
}
['#lModel','#lMode','#lSize'].forEach(s=>$(s).addEventListener('change',renderLabels));
$('#btnLabelsXlsx').onclick=()=>{ const rows=labelRows(); if(!rows.length) return toast('لا توجد ليبلات');
  writeXlsx(`ليبلات-niimbot-${today()}.xlsx`, {'Labels':rows.map(i=>({Barcode:skuOf(i),Model:i.model,Size:i.size,Color:i.color,Price:i.price!=null?`${i.price} SAR`:'',Brand:i.brand||'',Store:'BELLA ROSITA'}))}); };
$('#btnLabelsPng').onclick=async()=>{ const rows=labelRows(); if(!rows.length) return toast('لا توجد ليبلات');
  const z=new JSZip(), cnt={}; const size=$('#lSize').value;
  for(const it of rows){ const s=skuOf(it); cnt[s]=(cnt[s]||0)+1; const b=await new Promise(r=>drawLabel(it,size).toBlob(r,'image/png')); z.file(`${s}_${cnt[s]}.png`,b); }
  download(`ليبلات-${today()}.zip`, await z.generateAsync({type:'blob'})); };

/* ===== الملخص ===== */
function renderSummary(){
  const pcs=items.reduce((s,i)=>s+(i.qty||0),0), val=items.reduce((s,i)=>s+(i.qty||0)*(i.price||0),0);
  const models=new Set(items.map(i=>i.model).filter(Boolean)).size;
  $('#summaryCards').innerHTML=[['الموديلات',models],['الأكواد (مقاس/لون)',items.filter(i=>skuOf(i)).length],['إجمالي القطع',pcs],['قيمة المخزون (ر.س)',money(val)],['صفوف ناقصة',items.filter(i=>issuesOf(i).length).length],['موديل/لون مصوّر',`${new Set(photoCache.map(p=>p.group)).size}/${groups(items.filter(i=>i.model)).length}`]]
    .map(([t,v])=>`<div class="stat"><b>${v}</b><span>${t}</span></div>`).join('');
  const bs={}; items.forEach(i=>bs[i.size]=(bs[i.size]||0)+(i.qty||0)); const mx=Math.max(1,...Object.values(bs));
  $('#bySize').innerHTML=`<table>${Object.keys(bs).sort((a,b)=>sizeIdx(a)-sizeIdx(b)).map(s=>`<tr><td style="width:50px">${esc(s)}</td><td><div class="bar" style="width:${bs[s]/mx*100}%"></div></td><td style="width:40px"><b>${bs[s]}</b></td></tr>`).join('')}</table>`;
  const bm={}; items.forEach(i=>{const k=i.model||'?'; (bm[k] ||= {brand:i.brand,colors:new Set(),pcs:0,val:0,sizes:new Set()}); bm[k].colors.add(COLOR_AR[i.color]||i.color); bm[k].sizes.add(i.size); bm[k].pcs+=i.qty||0; bm[k].val+=(i.qty||0)*(i.price||0);});
  $('#byModel').innerHTML=`<table><tr><th>الموديل</th><th>البراند</th><th>الألوان</th><th>مقاسات</th><th>قطع</th><th>القيمة</th></tr>${Object.entries(bm).sort().map(([m,v])=>`<tr><td><b>${esc(m)}</b></td><td>${esc(v.brand||'—')}</td><td>${esc([...v.colors].join('، '))}</td><td>${v.sizes.size}</td><td>${v.pcs}</td><td>${money(v.val)}</td></tr>`).join('')}</table>`;
}

/* ===== استيراد / تصدير ===== */
function writeXlsx(name, sheets){ const wb=XLSX.utils.book_new();
  for(const [n,rows] of Object.entries(sheets)){ const ws=XLSX.utils.json_to_sheet(rows); ws['!cols']=Object.keys(rows[0]||{}).map(()=>({wch:16})); XLSX.utils.book_append_sheet(wb,ws,n.slice(0,31)); }
  XLSX.writeFile(wb,name); }

function importWorkbook(wb){
  let added=0, rowsRead=0, pieceRows=0;
  for(const sn of wb.SheetNames){
    const aoa=XLSX.utils.sheet_to_json(wb.Sheets[sn],{header:1,defval:null,raw:true});
    // قالب Shopify القديم
    let h=aoa.findIndex(r=>r&&r.includes('Option1 Value')&&r.includes('Variant Inventory Qty'));
    if(h>=0){
      const H=aoa[h], ix=n=>H.indexOf(n), next=aoa[h+1]||[];
      // عمود الموديل معرّف بكلمة model تحت العناوين — الأوراق بدونها (مثل ورقة المثال) تُتجاهل
      const mc=next.findIndex(v=>String(v||'').trim().toLowerCase()==='model'); if(mc<0 || /مثال/.test(sn)) continue;
      const C={title:ix('Title'),desc:ix('Body (HTML)'),brand:ix('Vendor'),cat:ix('Type'),size:ix('Option1 Value'),color:ix('Option2 Value'),price:ix('Variant Price'),cmp:ix('Variant Compare At Price'),qty:ix('Variant Inventory Qty')};
      for(let r=h+1;r<aoa.length;r++){ const R=aoa[r]; if(!R) continue;
        const title=R[C.title]; if(title==='اسم المنتج') continue;
        const size=normSize(R[C.size]), color=normColor(R[C.color]), model=normModel(R[mc]);
        if(!size||!color||!SIZES.includes(size)) continue;
        if(!model && !title && R[C.qty]==null && R[C.price]==null && !R[C.cat]) continue;
        let qty=num(R[C.qty]);
        if(!model && qty==null){ qty=1; pieceRows++; } // صف بدون موديل وبدون كمية = قطعة واحدة
        rowsRead++;
        const rec={model,brand:R[C.brand]?String(R[C.brand]).trim():'',category:R[C.cat]||'Eid Dress',color,size,qty:qty??0,price:num(R[C.price]),compareAt:num(R[C.cmp]),title:title?String(title).trim():'',desc:R[C.desc]?String(R[C.desc]).trim():''};
        if(model) upsert(rec); else { const ex=items.find(i=>!i.model&&i.color===color&&i.size===size); if(ex) ex.qty+=rec.qty; else items.push({id:uid(),counted:null,...rec}); }
        added++;
      }
      continue;
    }
    // ملف جرد مُصدّر من هذا الموقع
    h=aoa.findIndex(r=>r&&r.includes('الموديل')&&r.includes('المقاس')&&r.includes('الكمية'));
    if(h>=0){ const H=aoa[h], g=(R,n)=>R[H.indexOf(n)];
      for(let r=h+1;r<aoa.length;r++){ const R=aoa[r]; if(!R) continue; const size=normSize(g(R,'المقاس')), color=normColor(g(R,'اللون')); if(!size||!color) continue;
        rowsRead++; upsert({model:normModel(g(R,'الموديل')),brand:g(R,'البراند')||'',category:g(R,'الفئة')||'Eid Dress',color,size,qty:num(g(R,'الكمية'))??0,price:num(g(R,'السعر')),compareAt:num(g(R,'السعر قبل الخصم')),title:g(R,'الاسم')||'',desc:g(R,'الوصف')||''}, false); added++; }
    }
  }
  return {rowsRead, pieceRows};
}
$('#importXlsx').onchange=async e=>{ const f=e.target.files[0]; if(!f) return;
  if(items.length && !confirm(`يوجد ${items.length} كود حالياً. الاستيراد سيضيف الكميات فوق الموجود. متابعة؟`)) { e.target.value=''; return; }
  try{ const wb=XLSX.read(await f.arrayBuffer()); const r=importWorkbook(wb); save();
    alert(`تم قراءة ${r.rowsRead} صف ← ${items.length} كود.${r.pieceRows?`\n${r.pieceRows} صف بدون موديل وبدون كمية اعتُبر كل صف قطعة واحدة — راجعها في تبويب المنتجات.`:''}`); }
  catch(err){ alert('خطأ في قراءة الملف: '+err.message); }
  e.target.value=''; };
const invRows=()=>items.slice().sort((a,b)=>(skuOf(a)||'~').localeCompare(skuOf(b)||'~')).map(i=>({'الكود':skuOf(i),'الموديل':i.model,'البراند':i.brand,'الفئة':i.category,'اللون':i.color,'المقاس':i.size,'الكمية':i.qty,'السعر':i.price,'السعر قبل الخصم':i.compareAt,'الاسم':i.title,'الوصف':i.desc,'نواقص':issuesOf(i).join('، ')}));
$('#btnExportInv').onclick=()=>writeXlsx(`جرد-المخزون-${today()}.xlsx`,{'الجرد':invRows()});
$('#btnExportSalla').onclick=()=>{
  const ok=items.filter(i=>skuOf(i)); const skipped=items.length-ok.length;
  const prods=groups(ok).map(([key,arr])=>{ const f=arr[0]; return {'معرف المنتج':key,'اسم المنتج':f.title||`${CAT_AR[f.category]||'فستان'} ${COLOR_AR[f.color]||f.color} - موديل ${f.model}`,'رقم الموديل':f.model,'البراند':f.brand,'التصنيف':f.category,'اللون':f.color,'الوصف':f.desc,'السعر':f.price,'السعر قبل الخصم':f.compareAt,'المقاسات':arr.map(i=>i.size).join(','),'الكمية الكلية':arr.reduce((s,i)=>s+(i.qty||0),0),'الصور':photoCache.filter(p=>p.group===key).map(p=>p.id+'.jpg').join(',')}; });
  const vars=ok.map(i=>({'معرف المنتج':groupKey(i),'SKU':skuOf(i),'المقاس':i.size,'الكمية':i.qty,'السعر':i.price}));
  writeXlsx(`منتجات-سلة-${today()}.xlsx`,{'المنتجات':prods,'المقاسات':vars});
  if(skipped) toast(`تم استبعاد ${skipped} صف بدون موديل`); };
$('#btnBackup').onclick=()=>download(`نسخة-احتياطية-${today()}.json`, new Blob([JSON.stringify({v:1,at:new Date().toISOString(),items},null,1)],{type:'application/json'}));
$('#importJson').onchange=async e=>{ const f=e.target.files[0]; if(!f) return;
  try{ const d=JSON.parse(await f.text()); if(!Array.isArray(d.items)) throw new Error('ملف غير صالح');
    if(!confirm(`استرجاع ${d.items.length} كود؟ سيتم استبدال البيانات الحالية.`)) return; items=d.items; save(); toast('تم الاسترجاع'); }
  catch(err){ alert(err.message); } e.target.value=''; };
$('#btnClear').onclick=async()=>{ if(!confirm('مسح كل المنتجات والصور من هذا الجهاز؟ لا يمكن التراجع. ننصح بأخذ نسخة احتياطية أولاً.')) return;
  items=[]; await idb('readwrite',st=>st.clear()); await refreshPhotos(); save(); };

/* ===== تشغيل ===== */
function renderHead(){ const pcs=items.reduce((s,i)=>s+(i.qty||0),0); $('#headStats').textContent=`${new Set(items.map(i=>i.model).filter(Boolean)).size} موديل · ${pcs} قطعة`; }
const TABS = {products:()=>renderProducts(),count:()=>renderCount(),photos:()=>renderPhotos(),labels:()=>renderLabels(),summary:()=>renderSummary(),data:()=>renderData()};
function renderAll(){ renderHead(); const t=document.querySelector('.tab.active').id.slice(4); (TABS[t]||(()=>{}))(); }
function renderData(){
  if(!REMOTE) return;
  const li=localItems(); $('#migrateCard').hidden = !isAdmin();
  photosAll().then(ph=>{ $('#migrateInfo').textContent = `في هذا الجهاز: ${li.length} كود و ${ph.length} صورة محفوظة محلياً. النقل يضيف الكميات فوق الموجود في قاعدة البيانات للأكواد المتطابقة.`;
    $('#btnMigrate').disabled = !li.length && !ph.length; }).catch(()=>{});
  $('#auditCard').hidden = !isAdmin();
}
$('#btnMigrate').onclick=async()=>{
  const li=localItems(), ph=await photosAll().catch(()=>[]);
  if(!confirm(`نقل ${li.length} كود و ${ph.length} صورة من هذا الجهاز إلى قاعدة البيانات؟`)) return;
  try{
    $('#btnMigrate').disabled=true; $('#btnMigrate').textContent='جارٍ النقل…';
    for(const r of li){ const {id,counted,...rest}=r; upsert({...rest}); }
    await save(); await saving;
    let n=0; for(const p of ph){ if(photoCache.some(x=>x.group===p.group && x.n===p.n)) continue; await addPhoto(p.group, p.blob); n++; $('#btnMigrate').textContent=`صور: ${n}/${ph.length}`; }
    alert(`تم النقل: ${li.length} كود و ${n} صورة.\nالبيانات المحلية ما زالت في الجهاز ولم تُحذف.`);
  }catch(err){ alert('توقف النقل: '+(err.message||err)); }
  $('#btnMigrate').textContent='نقل الآن'; await load(); await refreshPhotos(); renderAll();
};
$('#btnAudit').onclick=async()=>{
  const {data,error}=await sb.from('audit_log').select('*').order('id',{ascending:false}).limit(100); if(error) return alert(error.message);
  const fmt=c=>c? Object.entries(c).filter(([k])=>!['id','updated_at','updated_by'].includes(k)).map(([k,v])=>Array.isArray(v)?`${k}: ${v[0]??'—'} ← ${v[1]??'—'}`:'').filter(Boolean).join(' · ') : '';
  $('#auditList').innerHTML=`<table class="audit"><tr><th>الوقت</th><th>المستخدم</th><th>العملية</th><th>الكود</th><th>التغيير</th></tr>${data.map(r=>`<tr><td>${esc(new Date(r.at).toLocaleString('ar-SA'))}</td><td>${esc(r.username||'')}</td><td>${esc({insert:'إضافة',update:'تعديل',delete:'حذف',start_count:'بدء جرد'}[r.action]||r.action)}</td><td class="sku">${esc(r.sku||'')}</td><td>${esc(r.action==='update'?fmt(r.changes):'')}</td></tr>`).join('')}</table>`;
};

async function enterApp(){
  const {data:{user}}=await sb.auth.getUser(); if(!user) return showLogin();
  const {data:prof}=await sb.from('profiles').select('username,role').eq('id',user.id).maybeSingle();
  me={username:prof?.username||user.email.split('@')[0], role:prof?.role||'staff'};
  document.body.classList.toggle('staff', !isAdmin());
  $('#userName').textContent=`${me.username}${isAdmin()?' (مدير)':''}`; $('#userBar').hidden=false; $('#login').hidden=true;
  $('#clearCard').hidden=true;
  try{ await load(); await refreshPhotos(); for(const f of onReady) await f(); }catch(err){ alert('تعذّر تحميل البيانات: '+err.message); }
  renderAll(); subscribeRealtime();
}
function showLogin(){ $('#login').hidden=false; setTimeout(()=>$('#lUser').focus(),50); }
$('#loginForm').onsubmit=async e=>{
  e.preventDefault(); $('#loginErr').textContent='';
  let u=$('#lUser').value.trim().toLowerCase(); if(!u.includes('@')) u=`${u}@${CFG.USERNAME_DOMAIN||'doubleroses.local'}`;
  const {error}=await sb.auth.signInWithPassword({email:u,password:$('#lPass').value});
  if(error) return $('#loginErr').textContent = /invalid/i.test(error.message)?'اسم المستخدم أو كلمة المرور غير صحيحة':error.message;
  $('#lPass').value=''; enterApp();
};
$('#btnLogout').onclick=async()=>{ await sb.auth.signOut(); location.reload(); };

const onReady = [];   // دوال تُستدعى بعد تحميل البيانات (من features.js)
window.addEventListener('DOMContentLoaded', () => {
  initForm();
  if(REMOTE){ document.body.classList.add('remote'); enterApp(); }
  else { load(); refreshPhotos().then(()=>{ onReady.forEach(f=>f()); renderAll(); }).catch(renderAll); renderAll(); }
});
