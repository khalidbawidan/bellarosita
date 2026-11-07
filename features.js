'use strict';
/* =====================================================================
   features.js — البيع والعمليات، الحجوزات، التكلفة، التسويق، التقارير
   يعتمد على app.js (items, save, load, sb, REMOTE, HAS_V2, ...)
   ===================================================================== */

/* ===== الإعدادات ===== */
const SETTINGS = {markup_pct:100, low_stock:1, whatsapp:'', studio_name:'Bellarosita'};
const LS_SET='br_settings_v1', LS_MOV='br_movements_v1', LS_RES='br_res_v1';
const lsGet = (k,d) => { try{ return JSON.parse(localStorage.getItem(k)) ?? d; }catch{ return d; } };
const lsSet = (k,v) => localStorage.setItem(k, JSON.stringify(v));

async function loadSettings(){
  if(REMOTE){ if(!HAS_V2) return; const {data}=await sb.from('settings').select('*'); (data||[]).forEach(r=>SETTINGS[r.key]=r.value); }
  else Object.assign(SETTINGS, lsGet(LS_SET,{}));
}
async function saveSettings(obj){
  if(REMOTE){ if(!HAS_V2) throw new Error(V2_MSG);
    const {error}=await sb.from('settings').upsert(Object.entries(obj).map(([key,value])=>({key,value}))); if(error) throw error; }
  Object.assign(SETTINGS,obj); if(!REMOTE) lsSet(LS_SET, SETTINGS);
}
const V2_MSG = 'قاعدة البيانات تحتاج تحديث 002 (ملف supabase/002_operations.sql) — شغّله في SQL Editor.';
function renderSettings(){
  $('#setMarkup').value=SETTINGS.markup_pct; $('#setLow').value=SETTINGS.low_stock; $('#setWa').value=SETTINGS.whatsapp||''; $('#setName').value=SETTINGS.studio_name||'';
}
$('#setSave').onclick=async()=>{
  try{ await saveSettings({markup_pct:num($('#setMarkup').value)??100, low_stock:num($('#setLow').value)??1, whatsapp:waNumber($('#setWa').value), studio_name:$('#setName').value.trim()||'Bellarosita'});
    toast('تم حفظ الإعدادات'); renderSettings(); }catch(err){ alert(err.message); }
};

/* ===== أدوات ===== */
function waNumber(p){ let d=String(p||'').replace(/\D/g,''); if(d.startsWith('00')) d=d.slice(2); if(d.startsWith('05')) d='966'+d.slice(1); else if(d.length===9&&d.startsWith('5')) d='966'+d; return d; }
function waLink(phone, text){ const n=waNumber(phone); return `https://wa.me/${n}?text=${encodeURIComponent(text)}`; }
const TYPE_AR = {sale:'بيع',receive:'استلام',return:'مرتجع',damage:'تالف',adjust:'تعديل'};
const SIGN = {sale:-1,receive:1,return:1,damage:-1};
const fmtDate = d => new Date(d).toLocaleString('ar-SA',{dateStyle:'short',timeStyle:'short'});
const sar = n => n==null ? '—' : `${money(Math.round(n*100)/100)} ر.س`;
function ageAr(s){ const n=parseInt(s), m=s.endsWith('M');
  if(n===1) return m?'شهر':'سنة'; if(n===2) return m?'شهرين':'سنتين'; return `${n} ${m?(n<=10?'شهور':'شهر'):(n<=10?'سنوات':'سنة')}`; }
function ageEn(s){ const n=parseInt(s), m=s.endsWith('M'); return `${n} ${m?(n===1?'month':'months'):(n===1?'year':'years')}`; }
function itemByCode(code){ code=String(code).trim().toUpperCase(); return items.find(i=>skuOf(i)===code); }

/* ===== الحجوزات وحركات المخزون ===== */
let reservations=[], movements=[];
async function loadOps(){
  if(REMOTE){ if(!HAS_V2){ reservations=[]; movements=[]; return; }
    const r=await sb.from('reservations').select('*').eq('status','active').order('id',{ascending:false}); reservations=r.data||[];
    const m=await sb.from('movements').select('*').order('id',{ascending:false}).limit(40); movements=m.data||[]; }
  else { reservations=lsGet(LS_RES,[]).filter(r=>r.status==='active'); movements=lsGet(LS_MOV,[]).slice(-40).reverse(); }
}
function reservedQty(id){ return reservations.filter(r=>r.item_id===id).reduce((s,r)=>s+r.qty,0); }
const availQty = it => (it.qty||0) - reservedQty(it.id);

async function moveStock(type, lines, {customer='',note='',channel='studio',ref=''}={}){
  if(REMOTE){
    if(!HAS_V2) throw new Error(V2_MSG);
    await saving;
    const {data,error}=await sb.rpc('stock_move',{p_type:type, p_lines:lines.map(l=>({id:l.id,qty:l.qty,price:l.price??null})),
      p_ref:ref||null, p_customer:customer||null, p_note:note||null, p_channel:channel});
    if(error) throw error; await load(); await loadOps(); renderAll(); return data;
  }
  const sign=SIGN[type];
  for(const l of lines){ const it=items.find(i=>i.id===l.id); if(!it) throw new Error('منتج غير موجود');
    if(!(l.qty>0)) throw new Error('كمية غير صحيحة');
    if(sign<0 && (it.qty||0)<l.qty) throw new Error(`الكمية غير كافية للكود ${skuOf(it)} (المتوفر ${it.qty||0})`); }
  const r = ref || ({sale:'S',receive:'IN',return:'RT',damage:'D'}[type]) + Date.now().toString(36).toUpperCase();
  const all=lsGet(LS_MOV,[]);
  for(const l of lines){ const it=items.find(i=>i.id===l.id); it.qty=(it.qty||0)+sign*l.qty;
    all.push({id:all.length+1, at:new Date().toISOString(), username:me.username||'محلي', type, ref:r, item_id:it.id, sku:skuOf(it), model:it.model, color:it.color, size:it.size,
      qty:l.qty, price:l.price??it.price, cost:it.cost??null, channel, customer, note}); }
  lsSet(LS_MOV, all); await loadOps(); save(); return r;
}
async function createReservations(lines,{customer,phone,until,note}){
  if(!customer) throw new Error('اكتب اسم العميلة للحجز');
  for(const l of lines){ const it=items.find(i=>i.id===l.id); if(l.qty>availQty(it)) throw new Error(`المتاح للحجز من ${skuOf(it)} هو ${availQty(it)} فقط`); }
  const rows=lines.map(l=>({item_id:l.id, sku:skuOf(items.find(i=>i.id===l.id)), qty:l.qty, customer, phone:phone||null, note:note||null, until:until||null}));
  if(REMOTE){ if(!HAS_V2) throw new Error(V2_MSG); const {error}=await sb.from('reservations').insert(rows); if(error) throw error; }
  else { const all=lsGet(LS_RES,[]); rows.forEach(r=>all.push({...r,id:Date.now()+all.length,at:new Date().toISOString(),status:'active'})); lsSet(LS_RES,all); }
  await loadOps(); renderAll();
}
async function completeReservation(id, price){
  if(REMOTE){ const {error}=await sb.rpc('complete_reservation',{p_id:id, p_price:price??null}); if(error) throw error; await load(); await loadOps(); renderAll(); return; }
  const all=lsGet(LS_RES,[]), r=all.find(x=>x.id===id); r.status='sold'; lsSet(LS_RES,all);
  try{ await moveStock('sale',[{id:r.item_id,qty:r.qty,price}],{customer:r.customer,note:'من حجز'}); }
  catch(e){ r.status='active'; lsSet(LS_RES,all); await loadOps(); throw e; }
}
async function cancelReservation(id){
  if(REMOTE){ const {error}=await sb.from('reservations').update({status:'cancelled',closed_at:new Date().toISOString()}).eq('id',id); if(error) throw error; }
  else { const all=lsGet(LS_RES,[]); const r=all.find(x=>x.id===id); r.status='cancelled'; lsSet(LS_RES,all); }
  await loadOps(); renderAll();
}

/* ===== تبويب البيع والعمليات ===== */
const OPS = {
  sale:   {hint:'امسح باركود القطع المباعة (أو اخترها يدوياً). تقدر تعدّل سعر كل قطعة للخصم.', btn:'✔ تأكيد البيع', price:true, cust:true, chan:true},
  reserve:{hint:'احجز قطعة لعميلة باسمها وجوالها. المحجوز ما يُعتبر متاح للبيع لين تتم البيعة أو تلغي الحجز.', btn:'📌 تأكيد الحجز', cust:true, until:true},
  return: {hint:'قطعة رجعت من عميلة — ترجع للمخزون وتنخصم من المبيعات.', btn:'↩️ تأكيد المرتجع', price:true, cust:true},
  receive:{hint:'استلام بضاعة جديدة: اختر الموديل يدوياً واكتب الكمية لكل مقاس، أو امسح باركود. بعد التأكيد تطبع ليبلات القطع الجديدة فقط. لموديل جديد كلياً أضفه أولاً من تبويب المنتجات.', btn:'📦 تأكيد الاستلام', allSizes:true},
  damage: {hint:'قطعة تالفة أو مفقودة — تنخصم من المخزون وتنسجل في التقارير.', btn:'⚠️ تأكيد الخصم'},
};
let opsMode='sale', cart=[], opsScanner=null, opsLast='', opsLastAt=0;
window.lastReceipt=null;

$('#opsMode').addEventListener('click',e=>{ const m=e.target.dataset.mode; if(!m) return; opsMode=m;
  document.querySelectorAll('#opsMode button').forEach(b=>b.classList.toggle('on',b.dataset.mode===m)); $('#opsResult').innerHTML=''; renderOps(); });

function addToCart(it, qty=1){
  if(!it) return;
  const l=cart.find(x=>x.id===it.id);
  if(l) l.qty+=qty; else cart.push({id:it.id, qty, price: opsMode==='sale'||opsMode==='return' ? it.price : null});
  const line=cart.find(x=>x.id===it.id);
  if(opsMode==='sale' && line.qty>availQty(it)) toast(`⚠️ المتاح من ${skuOf(it)}: ${availQty(it)}${reservedQty(it.id)?` (محجوز ${reservedQty(it.id)})`:''}`);
  renderCart();
}
function opsCode(code){
  const now=Date.now(); code=String(code).trim().toUpperCase(); if(!code) return;
  if(code===opsLast && now-opsLastAt<1500) return; opsLast=code; opsLastAt=now;
  const it=itemByCode(code); if(!it){ beep(false); return toast('كود غير معروف: '+code); }
  beep(true); addToCart(it);
}
$('#opsCodeBtn').onclick=()=>{ opsCode($('#opsCode').value); $('#opsCode').value=''; $('#opsCode').focus(); };
$('#opsCode').addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); $('#opsCodeBtn').click(); } });
async function opsStopScan(){ if(!opsScanner) return; try{ await opsScanner.stop(); opsScanner.clear(); }catch{} opsScanner=null; $('#opsScanBtn').textContent='📷 مسح باركود'; }
$('#opsScanBtn').onclick=async()=>{
  if(opsScanner) return opsStopScan();
  if(!window.Html5Qrcode) return toast('مكتبة الماسح لم تُحمّل');
  const F=Html5QrcodeSupportedFormats;
  opsScanner=new Html5Qrcode('opsReader',{formatsToSupport:[F.CODE_128,F.CODE_39,F.EAN_13,F.QR_CODE],verbose:false});
  try{ await opsScanner.start({facingMode:'environment'},{fps:10,qrbox:{width:280,height:120}}, opsCode); $('#opsScanBtn').textContent='⏹ إيقاف'; }
  catch(err){ opsScanner=null; toast('تعذّر فتح الكاميرا: '+err); }
};
document.querySelectorAll('#tabs button').forEach(b=>b.addEventListener('click',()=>{ if(b.dataset.tab!=='ops') opsStopScan(); }));

function renderOpsPick(){
  const gs=groups(items.filter(i=>i.model)); const cur=$('#opsGroup').value;
  $('#opsGroup').innerHTML='<option value="">اختر…</option>'+gs.map(([k,a])=>`<option value="${esc(k)}" ${k===cur?'selected':''}>${esc(k)} — ${esc(COLOR_AR[a[0].color]||a[0].color)} (${a.reduce((s,i)=>s+(i.qty||0),0)})</option>`).join('');
  renderOpsSizes();
}
function renderOpsSizes(){
  const k=$('#opsGroup').value; if(!k){ $('#opsSizeGrid').innerHTML=''; return; }
  const arr=items.filter(i=>groupKey(i)===k); const sizes = OPS[opsMode].allSizes ? SIZES : arr.map(i=>i.size);
  $('#opsSizeGrid').innerHTML=sizes.map(s=>{ const it=arr.find(i=>i.size===s);
    return `<label>${s}<small style="display:block">${it?`متوفر ${it.qty||0}`:'جديد'}</small><input type="number" min="0" inputmode="numeric" data-size="${s}"></label>`; }).join('');
}
$('#opsGroup').onchange=renderOpsSizes;
$('#opsPickAdd').onclick=async()=>{
  const k=$('#opsGroup').value; if(!k) return toast('اختر الموديل');
  const arr=items.filter(i=>groupKey(i)===k), base=arr[0]; let n=0, created=false;
  for(const inp of document.querySelectorAll('#opsSizeGrid input')){ const q=num(inp.value); if(!(q>0)) continue;
    let it=arr.find(i=>i.size===inp.dataset.size);
    if(!it){ // مقاس جديد لموديل موجود (استلام فقط)
      const {id,counted,qty,size,...rest}=base; it=upsert({...rest,size:inp.dataset.size,qty:0}); created=true; }
    addToCart(it,q); n++; inp.value=''; }
  if(created){ save(); await saving; }
  if(!n) toast('اكتب الكمية لمقاس واحد على الأقل'); else renderOpsSizes();
};

function renderCart(){
  const cfg=OPS[opsMode];
  $('#cartTitle').textContent = {sale:'فاتورة البيع',reserve:'قطع الحجز',return:'القطع المرتجعة',receive:'البضاعة المستلمة',damage:'القطع التالفة'}[opsMode];
  if(!cart.length){ $('#cart').innerHTML='<p class="hint">القائمة فارغة — امسح باركود أو اختر يدوياً.</p>'; return; }
  const tot=cart.reduce((s,l)=>s+(l.qty*(l.price||0)),0), pcs=cart.reduce((s,l)=>s+l.qty,0);
  $('#cart').innerHTML=`<table><tr><th>الكود</th><th>متاح</th><th>الكمية</th>${cfg.price?'<th>السعر</th>':''}<th></th></tr>${cart.map((l,ix)=>{const it=items.find(i=>i.id===l.id);
    return `<tr><td class="sku">${esc(skuOf(it))}</td><td>${availQty(it)}</td><td><input type="number" min="1" data-cq="${ix}" value="${l.qty}"></td>
    ${cfg.price?`<td><input type="number" data-cp="${ix}" value="${l.price??''}"></td>`:''}<td><button class="small" data-cx="${ix}">✕</button></td></tr>`;}).join('')}</table>
    <div class="cartTotal"><b>${pcs}</b> قطعة${cfg.price?` · الإجمالي <b>${sar(tot)}</b>`:''}</div>`;
}
$('#cart').addEventListener('change',e=>{ const d=e.target.dataset;
  if(d.cq!=null){ cart[d.cq].qty=Math.max(1,num(e.target.value)||1); }
  if(d.cp!=null){ cart[d.cp].price=num(e.target.value); } renderCart(); });
$('#cart').addEventListener('click',e=>{ const x=e.target.dataset.cx; if(x==null) return; cart.splice(+x,1); renderCart(); });
$('#opsClear').onclick=()=>{ cart=[]; $('#opsResult').innerHTML=''; renderCart(); };

$('#opsConfirm').onclick=async()=>{
  if(!cart.length) return toast('القائمة فارغة');
  const customer=$('#opsCustomer').value.trim(), phone=$('#opsPhone').value.trim(), note=$('#opsNote').value.trim();
  const btn=$('#opsConfirm'); btn.disabled=true;
  try{
    if(opsMode==='reserve'){
      await createReservations(cart,{customer,phone,until:$('#opsUntil').value,note});
      const txt=`مرحباً ${customer} 🌹\nتم حجز طلبك لدى ${SETTINGS.studio_name}:\n${cart.map(l=>{const it=items.find(i=>i.id===l.id); return `• موديل ${it.model} ${COLOR_AR[it.color]||it.color} مقاس ${it.size}`;}).join('\n')}${$('#opsUntil').value?`\nالحجز ساري حتى ${$('#opsUntil').value}`:''}`;
      $('#opsResult').innerHTML=`<p class="ok">✔ تم الحجز.</p>${phone?`<a class="fileBtn" target="_blank" rel="noopener" href="${esc(waLink(phone,txt))}">💬 إرسال تأكيد واتساب</a>`:''}`;
    } else {
      if(opsMode==='sale'){ const over=cart.filter(l=>l.qty>availQty(items.find(i=>i.id===l.id)));
        if(over.length && !confirm(`بعض القطع محجوزة لعميلات أخريات (${over.map(l=>skuOf(items.find(i=>i.id===l.id))).join('، ')}). متابعة البيع؟`)) return; }
      const lines=cart.map(l=>({...l})), snapshot=lines.map(l=>({...l,it:{...items.find(i=>i.id===l.id)}}));
      const ref=await moveStock(opsMode, lines, {customer, note, channel: opsMode==='sale'?$('#opsChannel').value:'studio'});
      let html=`<p class="ok">✔ تمت العملية رقم <b>${esc(ref)}</b></p>`;
      if(opsMode==='sale'){
        const tot=snapshot.reduce((s,l)=>s+l.qty*(l.price||0),0);
        const txt=`فاتورة ${SETTINGS.studio_name} 🌹\nرقم: ${ref}\n${snapshot.map(l=>`• موديل ${l.it.model} ${COLOR_AR[l.it.color]||l.it.color} مقاس ${l.it.size} × ${l.qty} = ${(l.price||0)*l.qty} ر.س`).join('\n')}\nالإجمالي: ${tot} ر.س\nشكراً لتسوقك معنا 💕`;
        if(phone) html+=`<a class="fileBtn" target="_blank" rel="noopener" href="${esc(waLink(phone,txt))}">💬 إرسال الفاتورة واتساب</a>`;
      }
      if(opsMode==='receive'){ window.lastReceipt=lines.map(l=>({id:l.id,qty:l.qty}));
        html+=`<button class="primary" id="goReceiptLabels">🏷 طباعة ليبلات هذا الاستلام (${lines.reduce((s,l)=>s+l.qty,0)})</button>`; }
      $('#opsResult').innerHTML=html;
      $('#goReceiptLabels')?.addEventListener('click',()=>{ document.querySelector('[data-tab=labels]').click(); $('#lModel').value='__receipt'; renderLabels(); });
    }
    cart=[]; ['#opsCustomer','#opsPhone','#opsNote','#opsUntil'].forEach(s=>$(s).value=''); renderOps();
  }catch(err){ alert('لم تتم العملية: '+(err.message||err)); }
  finally{ btn.disabled=false; }
};

function renderOps(){
  const cfg=OPS[opsMode];
  $('#opsHint').innerHTML=esc(cfg.hint)+(REMOTE&&!HAS_V2?`<br><b class="bad">${esc(V2_MSG)}</b>`:'');
  $('#opsConfirm').textContent=cfg.btn;
  $('#opsCustomer').closest('label').hidden=!cfg.cust; $('#opsPhone').closest('label').hidden=!cfg.cust;
  $('#opsChannelL').hidden=!cfg.chan; $('#opsUntilL').hidden=!cfg.until;
  $('#opsCustomer').placeholder = opsMode==='reserve' ? 'مطلوب' : 'اختياري';
  renderOpsPick(); renderCart(); renderReservations(); renderMovements();
}
function renderReservations(){
  $('#resList').innerHTML = reservations.length ? `<table><tr><th>العميلة</th><th>الكود</th><th>العدد</th><th>حتى</th><th></th></tr>${reservations.map(r=>{
    const late=r.until && r.until<today();
    return `<tr><td>${esc(r.customer)}<br><small>${esc(r.phone||'')}</small></td><td class="sku">${esc(r.sku)}</td><td>${r.qty}</td><td class="${late?'bad':''}">${esc(r.until||'—')}</td>
      <td><button class="small primary" data-rsell="${r.id}">بيع</button> <button class="small" data-rcancel="${r.id}">إلغاء</button>
      ${r.phone?`<a class="small fileBtn" style="padding:4px 8px" target="_blank" rel="noopener" href="${esc(waLink(r.phone,`مرحباً ${r.customer} 🌹 تذكير بحجزك لدى ${SETTINGS.studio_name}: ${r.sku}`))}">💬</a>`:''}</td></tr>`;}).join('')}</table>` : '<p class="hint">لا توجد حجوزات نشطة.</p>';
}
$('#resList').addEventListener('click',async e=>{ const d=e.target.dataset;
  try{
    if(d.rsell){ const r=reservations.find(x=>String(x.id)===d.rsell); const it=items.find(i=>i.id===r.item_id);
      const p=prompt(`سعر البيع للقطعة (${r.sku}):`, it?.price??''); if(p===null) return;
      await completeReservation(r.id, num(p)); toast('تم البيع وإغلاق الحجز'); }
    if(d.rcancel){ if(!confirm('إلغاء الحجز؟ القطعة ترجع متاحة للبيع.')) return; await cancelReservation(Number(d.rcancel)); toast('تم إلغاء الحجز'); }
  }catch(err){ alert(err.message||err); }
});
function renderMovements(){
  $('#movList').innerHTML = movements.length ? `<table><tr><th>الوقت</th><th>العملية</th><th>الكود</th><th>العدد</th><th>السعر</th><th>بواسطة</th></tr>${movements.map(m=>`<tr>
    <td><small>${esc(fmtDate(m.at))}</small></td><td>${esc(TYPE_AR[m.type]||m.type)}${m.customer?`<br><small>${esc(m.customer)}</small>`:''}</td><td class="sku">${esc(m.sku||'')}</td>
    <td class="${(SIGN[m.type]||1)<0?'bad':'ok'}">${m.type==='adjust'?(m.qty>0?'+':'')+m.qty:((SIGN[m.type]||1)<0?'−':'+')+m.qty}</td><td>${m.price!=null&&m.type==='sale'?money(m.price):''}</td><td><small>${esc(m.username||'')}</small></td></tr>`).join('')}</table>` : '<p class="hint">لا توجد عمليات بعد.</p>';
}
TABS.ops = renderOps;

/* ===== تعديل المنتج (التكلفة، المكان، الأسماء والأوصاف) ===== */
const FEATURES = {tulle:['تول','tulle'],lace:['دانتيل','lace'],flowers:['ورود','floral details'],belt:['حزام','a waist belt'],bow:['فيونكة','a bow'],
  pearls:['لؤلؤ','pearl accents'],glitter:['لمعة ناعمة','subtle sparkle'],puff:['أكمام منفوخة','puff sleeves'],layers:['تنورة بطبقات','a layered skirt'],
  satin:['ساتان','satin'],embroidery:['تطريز','embroidery'],cape:['كاب','a cape']};
const CAT_EN = {'Eid Dress':'Eid dress','Daily Dress':'everyday dress','Wedding Dress':'wedding & party dress','Summer Dress':'summer dress','Winter Dress':'winter dress'};
const OCC_AR = {'Eid Dress':'العيد والمناسبات','Daily Dress':'الطلعات اليومية','Wedding Dress':'الأعراس والحفلات','Summer Dress':'أيام الصيف','Winter Dress':'أيام الشتاء'};
const OCC_EN = {'Eid Dress':'Eid and special occasions','Daily Dress':'everyday outings','Wedding Dress':'weddings and parties','Summer Dress':'summer days','Winter Dress':'winter days'};
const joinAr = a => a.length<2 ? a.join('') : a.slice(0,-1).join('، ')+' و'+a[a.length-1];
const joinEn = a => a.length<2 ? a.join('') : a.slice(0,-1).join(', ')+' and '+a[a.length-1];
function genTexts(f, sizes, feats){
  const s=sizes.slice().sort((a,b)=>sizeIdx(a)-sizeIdx(b)); const cAr=COLOR_AR[f.color]||f.color, cEn=(f.color||'').toLowerCase();
  const catAr=CAT_AR[f.category]||'فستان', fa=feats.map(k=>FEATURES[k][0]), fe=feats.map(k=>FEATURES[k][1]);
  const rangeAr = s.length ? (s.length===1?`مقاس ${ageAr(s[0])}`:`من عمر ${ageAr(s[0])} إلى ${ageAr(s[s.length-1])}`) : '';
  const rangeEn = s.length ? (s.length===1?`size ${ageEn(s[0])}`:`ages ${ageEn(s[0])} to ${ageEn(s[s.length-1])}`) : '';
  return {
    titleAr: `${catAr} ${cAr}${fa.length?` ب${fa[0]}`:''} - موديل ${f.model}`,
    title: f.title || `Girls ${cEn} ${CAT_EN[f.category]||'dress'}${fe.length?` with ${fe[0]}`:''} - Model ${f.model}`,
    desc: `${catAr} للبنات باللون ال${cAr}${fa.length?`، مزيّن ب${joinAr(fa)}`:''}، بتصميم أنيق يمنح طفلتك إطلالة الأميرات في ${OCC_AR[f.category]||'المناسبات'}. خامة ناعمة ومريحة تناسب ساعات الفرح الطويلة. متوفر ${rangeAr}.${f.brand?` من ${f.brand}.`:''}`,
    descEn: `A ${cEn} girls' ${CAT_EN[f.category]||'dress'}${fe.length?` featuring ${joinEn(fe)}`:''}, designed to give your little one a princess look for ${OCC_EN[f.category]||'special occasions'}. Soft, comfortable fabric for long celebrations. Available in ${rangeEn}.${f.brand?` By ${f.brand}.`:''}`,
  };
}
let editKey=null;
$('#eCategory').innerHTML=CATEGORIES.map(c=>`<option value="${c}">${CAT_AR[c]} — ${c}</option>`).join('');
$('#eChips').innerHTML=Object.entries(FEATURES).map(([k,[ar]])=>`<label><input type="checkbox" value="${k}">${ar}</label>`).join('');
const suggestPrice = cost => cost ? Math.ceil(cost*(1+(SETTINGS.markup_pct||0)/100)/5)*5 : null;
function updSuggest(){ const c=num($('#eCost').value), p=num($('#ePrice').value), sp=suggestPrice(c);
  $('#eSuggest').textContent = sp ? `${sp} ر.س${p&&c?` · ربحك الحالي ${Math.round((p-c)/c*100)}%`:''}` : '—'; }
$('#eCost').oninput=updSuggest; $('#ePrice').oninput=updSuggest;
$('#productList').addEventListener('click',e=>{ const k=e.target.dataset?.edit; if(k) openEdit(k); });
function openEdit(key){
  const arr=items.filter(i=>groupKey(i)===key), f=arr[0]; if(!f) return; editKey=key;
  $('#editTitle').textContent=`تعديل ${key} — ${COLOR_AR[f.color]||f.color}`;
  $('#eBrand').value=f.brand||''; $('#eCategory').value=f.category||'Eid Dress'; $('#ePrice').value=f.price??''; $('#eCompare').value=f.compareAt??'';
  $('#eCost').value=f.cost??''; $('#eLocation').value=f.location||''; $('#eTitleAr').value=f.titleAr||''; $('#eTitle').value=f.title||'';
  $('#eDesc').value=f.desc||''; $('#eDescEn').value=f.descEn||''; document.querySelectorAll('#eChips input').forEach(c=>c.checked=false);
  $('#eCost').closest('label').hidden = REMOTE&&!HAS_V2; updSuggest(); $('#editDlg').showModal();
}
$('#eGen').onclick=()=>{
  const arr=items.filter(i=>groupKey(i)===editKey), f={...arr[0], brand:$('#eBrand').value.trim(), category:$('#eCategory').value, title:''};
  const t=genTexts(f, arr.map(i=>i.size), [...document.querySelectorAll('#eChips input:checked')].map(c=>c.value));
  $('#eTitleAr').value=t.titleAr; if(!$('#eTitle').value) $('#eTitle').value=t.title; $('#eDesc').value=t.desc; $('#eDescEn').value=t.descEn;
};
$('#editDlg').addEventListener('close',()=>{
  if($('#editDlg').returnValue!=='save' || !editKey) return;
  const patch={brand:$('#eBrand').value.trim(), category:$('#eCategory').value, price:num($('#ePrice').value), compareAt:num($('#eCompare').value),
    cost:num($('#eCost').value), location:$('#eLocation').value.trim(), titleAr:$('#eTitleAr').value.trim(), title:$('#eTitle').value.trim(),
    desc:$('#eDesc').value.trim(), descEn:$('#eDescEn').value.trim()};
  items.filter(i=>groupKey(i)===editKey).forEach(i=>Object.assign(i,patch)); save(); toast('تم الحفظ');
});

/* ===== التسويق ===== */
let mkPhoto=null;
const mkGroups = () => groups(items.filter(i=>i.model));
function renderMarketing(){
  const cur=$('#mkGroup').value;
  $('#mkGroup').innerHTML=mkGroups().map(([k,a])=>`<option value="${esc(k)}" ${k===cur?'selected':''}>${photoCache.some(p=>p.group===k)?'📷 ':''}${esc(k)} — ${esc(COLOR_AR[a[0].color]||a[0].color)}</option>`).join('');
  if(!$('#mkCta').value && SETTINGS.whatsapp) $('#mkCta').value=`للطلب واتساب: ${SETTINGS.whatsapp.replace(/^966/,'0')}`;
  renderMkPhotos();
}
function renderMkPhotos(){
  const k=$('#mkGroup').value, ps=photoCache.filter(p=>p.group===k).sort((a,b)=>(a.shot==='front'?-1:0)-(b.shot==='front'?-1:0)||a.n-b.n);
  if(!ps.some(p=>p===mkPhoto)) mkPhoto=ps[0]||null;
  $('#mkPhotos').innerHTML=ps.length?ps.map((p,i)=>`<img src="${esc(photoSrc(p))}" data-mk="${i}" class="${p===mkPhoto?'sel':''}" style="width:64px;height:64px;object-fit:cover;border-radius:8px">`).join(''):'<p class="hint">لا توجد صور لهذا المنتج — صوّره من تبويب الصور.</p>';
  $('#mkPhotos').onclick=e=>{ const i=e.target.dataset.mk; if(i==null) return; mkPhoto=ps[+i]; renderMkPhotos(); };
  drawCard();
}
['#mkGroup','#mkFormat','#mkHeadline','#mkCta','#mkPrice','#mkSizes'].forEach(s=>$(s).addEventListener(s==='#mkGroup'?'change':'input', s==='#mkGroup'?renderMkPhotos:drawCard));
$('#mkFormat').addEventListener('change',drawCard); $('#mkPrice').addEventListener('change',drawCard); $('#mkSizes').addEventListener('change',drawCard);
function loadImg(src){ return new Promise((res,rej)=>{ const im=new Image(); im.crossOrigin='anonymous'; im.onload=()=>res(im); im.onerror=rej; im.src=src; }); }
function wrapText(g, text, maxW){ const words=String(text).split(' '), lines=[]; let line='';
  for(const w of words){ const t=line?line+' '+w:w; if(g.measureText(t).width>maxW && line){ lines.push(line); line=w; } else line=t; } if(line) lines.push(line); return lines; }
let drawSeq=0;
async function drawCard(){
  const seq=++drawSeq, k=$('#mkGroup').value, arr=items.filter(i=>groupKey(i)===k); const c=$('#mkCanvas');
  if(!arr.length){ c.width=c.height=1; return; }
  const f=arr[0], W=1080, H={post:1350,story:1920,square:1080}[$('#mkFormat').value], g=c.getContext('2d');
  let img=null; if(mkPhoto){ try{ img=await loadImg(photoSrc(mkPhoto)); }catch{} } if(seq!==drawSeq) return;
  c.width=W; c.height=H; g.direction='rtl';
  const brand='#8a3d5c', panelH=Math.round(H*0.24), imgH=H-panelH;
  g.fillStyle='#f6e9ee'; g.fillRect(0,0,W,imgH);
  if(img){ const s=Math.max(W/img.width, imgH/img.height), w=img.width*s, h=img.height*s; g.drawImage(img,(W-w)/2,(imgH-h)/2,w,h); }
  else { g.fillStyle=brand; g.font='bold 60px Tahoma, Arial'; g.textAlign='center'; g.fillText('📷 بدون صورة', W/2, imgH/2); }
  // اسم الاستديو أعلى الصورة
  g.font='bold 44px Georgia, serif'; g.textAlign='center'; const nm=SETTINGS.studio_name||'Bellarosita', nw=g.measureText(nm).width+60;
  g.fillStyle='rgba(255,255,255,.85)'; g.fillRect((W-nw)/2,36,nw,70); g.fillStyle=brand; g.fillText(nm, W/2, 86);
  const head=$('#mkHeadline').value.trim();
  if(head){ g.font='bold 50px Tahoma, Arial'; const hw=g.measureText(head).width+70; g.fillStyle=brand; g.fillRect(W-hw-40,imgH-110,hw,80); g.fillStyle='#fff'; g.textAlign='right'; g.fillText(head, W-75, imgH-52); }
  // شارة السعر (دائرة على الصورة)
  if($('#mkPrice').checked && f.price!=null){
    const cx=170, cy=imgH-150, r=120;
    g.fillStyle='#fff'; g.beginPath(); g.arc(cx,cy,r,0,Math.PI*2); g.fill(); g.lineWidth=8; g.strokeStyle=brand; g.stroke();
    g.fillStyle=brand; g.textAlign='center'; g.direction='ltr';
    g.font='bold 78px Tahoma, Arial'; g.fillText(`${f.price}`, cx, cy+(f.compareAt>f.price?10:22));
    g.font='bold 34px Tahoma, Arial'; g.fillText('SAR', cx, cy+(f.compareAt>f.price?52:66));
    if(f.compareAt>f.price){ g.font='36px Tahoma, Arial'; g.globalAlpha=.6; const t=`${f.compareAt}`, tw=g.measureText(t).width; g.fillText(t, cx, cy-62); g.fillRect(cx-tw/2,cy-74,tw,4); g.globalAlpha=1; }
    g.direction='rtl';
  }
  // اللوحة السفلية
  g.fillStyle=brand; g.fillRect(0,imgH,W,panelH); g.fillStyle='#fff'; g.textAlign='right';
  const title=f.titleAr || `${CAT_AR[f.category]||'فستان'} ${COLOR_AR[f.color]||f.color} - موديل ${f.model}`;
  let fs=58; do { g.font=`bold ${fs}px Tahoma, Arial`; fs-=2; } while(g.measureText(title).width>W-100 && fs>30);
  g.fillText(title, W-50, imgH+82);
  const avail=arr.filter(i=>availQty(i)>0).map(i=>i.size).sort((a,b)=>sizeIdx(a)-sizeIdx(b));
  if($('#mkSizes').checked){
    g.font='bold 38px Tahoma, Arial'; const lab='المقاسات المتوفرة:'; g.fillText(lab, W-50, imgH+150);
    const lw=g.measureText(lab).width; g.font='38px Tahoma, Arial'; g.direction='ltr'; g.textAlign='right';
    const txt=avail.length?avail.join(' · '):'—'; const lines=wrapText(g, txt, W-140-lw);
    lines.slice(0,2).forEach((l,i)=>g.fillText(l, W-70-lw, imgH+150+i*48)); g.direction='rtl';
  }
  const cta=$('#mkCta').value.trim(); if(cta){ g.textAlign='center'; g.font='34px Tahoma, Arial'; g.fillText(cta, W/2, H-28); }
}
async function cardBlob(){ await drawCard(); return new Promise(r=>$('#mkCanvas').toBlob(r,'image/jpeg',0.92)); }
$('#mkDownload').onclick=async()=>{ try{ download(`${$('#mkGroup').value}-${$('#mkFormat').value}.jpg`, await cardBlob()); }catch(e){ alert('تعذّر إنشاء الصورة: '+e.message); } };
$('#mkShare').onclick=async()=>{
  try{ const b=await cardBlob(), file=new File([b],`${$('#mkGroup').value}.jpg`,{type:'image/jpeg'});
    if(navigator.canShare?.({files:[file]})) await navigator.share({files:[file]}); else download(file.name,b); }
  catch(e){ if(e.name!=='AbortError') alert('تعذّرت المشاركة: '+e.message); }
};
$('#catBuild').onclick=async()=>{
  const inStock=$('#catInStock').checked, prices=$('#catPrices').checked, noPh=$('#catNoPhoto').checked;
  const list=mkGroups().map(([k,arr])=>({k,arr,f:arr[0],ph:photoCache.filter(p=>p.group===k).sort((a,b)=>(a.shot==='front'?-1:0)-(b.shot==='front'?-1:0)||a.n-b.n)[0],
    avail:arr.filter(i=>availQty(i)>0).map(i=>i.size).sort((a,b)=>sizeIdx(a)-sizeIdx(b))}))
    .filter(x=>(!inStock||x.avail.length)&&(noPh||x.ph));
  if(!list.length) return alert('لا توجد منتجات مطابقة (جرّب "يشمل بدون صور").');
  const wa=SETTINGS.whatsapp?SETTINGS.whatsapp.replace(/^966/,'0'):'';
  $('#printArea').innerHTML=`<div class="catPage"><div class="catHead"><h1>${esc(SETTINGS.studio_name||'Bellarosita')}</h1><div>كتالوج ${esc(today())}${wa?` · للطلب واتساب ${esc(wa)}`:''}</div></div>
    <div class="catGrid">${list.map(x=>`<div class="catItem">${x.ph?`<img src="${esc(photoSrc(x.ph))}">`:'<div class="noimg">بدون صورة</div>'}
      <div class="t"><b>${esc(x.f.titleAr||`${CAT_AR[x.f.category]||'فستان'} ${COLOR_AR[x.f.color]||x.f.color}`)}</b><br>موديل ${esc(x.f.model)}${prices&&x.f.price!=null?` · <b>${x.f.price} ر.س</b>`:''}<br><small>المقاسات: ${esc(x.avail.join(' · ')||'—')}</small></div></div>`).join('')}</div></div>`;
  await Promise.all([...$('#printArea').querySelectorAll('img')].map(im=>im.complete?0:new Promise(r=>{im.onload=im.onerror=r;})));
  window.print();
};
$('#descBulk').onclick=()=>{
  const ow=$('#descOverwrite').checked; let n=0;
  for(const [k,arr] of mkGroups()){ const f=arr[0]; if(!ow && f.desc && f.descEn && f.titleAr) continue;
    const t=genTexts(f, arr.map(i=>i.size), []);
    arr.forEach(i=>{ if(ow||!i.titleAr) i.titleAr=t.titleAr; if(!i.title) i.title=t.title; if(ow||!i.desc) i.desc=t.desc; if(ow||!i.descEn) i.descEn=t.descEn; }); n++; }
  if(!n) return toast('كل المنتجات عندها أوصاف'); save(); toast(`تم توليد أوصاف ${n} منتج`);
};
TABS.marketing = renderMarketing;

/* ===== التقارير ===== */
function renderReports(){
  const withCost=items.filter(i=>i.cost!=null), costVal=withCost.reduce((s,i)=>s+(i.qty||0)*i.cost,0), retail=withCost.reduce((s,i)=>s+(i.qty||0)*(i.price||0),0);
  $('#summaryCards').insertAdjacentHTML('beforeend', [
    ['قيمة المخزون بالتكلفة', withCost.length?money(Math.round(costVal)):'—'],
    ['الربح المتوقع', withCost.length?money(Math.round(retail-costVal)):'—'],
    ['محجوز', reservations.reduce((s,r)=>s+r.qty,0)],
    ['أكواد بدون تكلفة', items.filter(i=>i.model&&i.cost==null).length]].map(([t,v])=>`<div class="stat"><b>${v}</b><span>${t}</span></div>`).join(''));
  renderLow();
  if(!$('#repFrom').value){ const d=new Date(); $('#repTo').value=today(); d.setDate(1); $('#repFrom').value=d.toISOString().slice(0,10); }
}
function lowList(){ const th=SETTINGS.low_stock??1, out=[];
  for(const [k,arr] of groups(items.filter(i=>i.model))){ const low=arr.filter(i=>availQty(i)<=th); if(low.length) out.push({k,f:arr[0],low}); } return out; }
function renderLow(){ const L=lowList();
  $('#lowStock').innerHTML = L.length ? `<p class="hint">المقاسات اللي المتاح فيها ${SETTINGS.low_stock??1} أو أقل (بعد خصم المحجوز):</p><table><tr><th>الموديل</th><th>نفد</th><th>قليل</th></tr>${L.map(x=>`<tr><td><b>${esc(x.k)}</b> <small>${esc(COLOR_AR[x.f.color]||'')}</small></td>
    <td class="bad">${esc(x.low.filter(i=>availQty(i)<=0).map(i=>i.size).join(' · ')||'—')}</td><td class="warn">${esc(x.low.filter(i=>availQty(i)>0).map(i=>`${i.size}(${availQty(i)})`).join(' · ')||'—')}</td></tr>`).join('')}</table>` : '<p class="ok">كل المقاسات متوفرة ✔</p>';
}
$('#lowXlsx').onclick=()=>{ const rows=[]; lowList().forEach(x=>x.low.forEach(i=>rows.push({'الموديل':i.model,'البراند':i.brand,'اللون':i.color,'المقاس':i.size,'المتاح':availQty(i),'الكمية المطلوبة':''})));
  if(!rows.length) return toast('لا يوجد نقص'); writeXlsx(`طلب-مورد-${today()}.xlsx`,{'الطلب':rows}); };
$('#lowCopy').onclick=async()=>{ const L=lowList(); if(!L.length) return toast('لا يوجد نقص');
  const txt=`طلبية ${SETTINGS.studio_name} — ${today()}\n`+L.map(x=>`موديل ${x.f.model} ${x.f.color}: ${x.low.map(i=>i.size).join('، ')}`).join('\n');
  try{ await navigator.clipboard.writeText(txt); toast('تم النسخ — الصقه في واتساب المورد'); }catch{ prompt('انسخ النص:', txt); } };

let repRows=[];
$('#repRun').onclick=async()=>{
  const from=$('#repFrom').value, to=$('#repTo').value; if(!from||!to) return toast('اختر الفترة');
  const toEnd=new Date(to); toEnd.setDate(toEnd.getDate()+1); const toIso=toEnd.toISOString().slice(0,10);
  if(REMOTE){ if(!HAS_V2) return alert(V2_MSG);
    const all=[]; for(let f=0;;f+=1000){ const {data,error}=await sb.from('movements').select('*').in('type',['sale','return','damage']).gte('at',from).lt('at',toIso).order('id').range(f,f+999); if(error) return alert(error.message); all.push(...data); if(data.length<1000) break; }
    repRows=all; }
  else repRows=lsGet(LS_MOV,[]).filter(m=>['sale','return','damage'].includes(m.type)&&m.at>=from&&m.at<toIso);
  const sales=repRows.filter(m=>m.type==='sale'), rets=repRows.filter(m=>m.type==='return'), dmg=repRows.filter(m=>m.type==='damage');
  const pcs=sales.reduce((s,m)=>s+m.qty,0)-rets.reduce((s,m)=>s+m.qty,0);
  const rev=sales.reduce((s,m)=>s+m.qty*(+m.price||0),0)-rets.reduce((s,m)=>s+m.qty*(+m.price||0),0);
  const costed=[...sales,...rets].filter(m=>m.cost!=null), cost=costed.reduce((s,m)=>s+(m.type==='sale'?1:-1)*m.qty*m.cost,0);
  const by=(key)=>{ const o={}; sales.forEach(m=>{ const k=key(m); (o[k] ||= {pcs:0,rev:0}); o[k].pcs+=m.qty; o[k].rev+=m.qty*(+m.price||0); });
    rets.forEach(m=>{ const k=key(m); (o[k] ||= {pcs:0,rev:0}); o[k].pcs-=m.qty; o[k].rev-=m.qty*(+m.price||0); }); return Object.entries(o).sort((a,b)=>b[1].pcs-a[1].pcs); };
  const tbl=(t,rows,lab)=>`<h4>${t}</h4><table><tr><th>${lab}</th><th>قطع</th><th>المبيعات</th></tr>${rows.map(([k,v])=>`<tr><td>${esc(k)}</td><td>${v.pcs}</td><td>${money(v.rev)}</td></tr>`).join('')}</table>`;
  $('#repOut').innerHTML = repRows.length ? `<div class="statCards">
    <div class="stat"><b>${pcs}</b><span>قطع مباعة (صافي)</span></div><div class="stat"><b>${money(rev)}</b><span>المبيعات ر.س</span></div>
    <div class="stat"><b>${costed.length?money(Math.round(rev-cost)):'—'}</b><span>الربح${costed.length<sales.length+rets.length?' (لما فيه تكلفة)':''}</span></div>
    <div class="stat"><b>${rets.reduce((s,m)=>s+m.qty,0)} / ${dmg.reduce((s,m)=>s+m.qty,0)}</b><span>مرتجع / تالف</span></div></div>
    ${tbl('الأكثر مبيعاً حسب الموديل', by(m=>`${m.model} ${COLOR_AR[m.color]||m.color||''}`).slice(0,10),'الموديل')}
    ${tbl('حسب المقاس', by(m=>m.size).sort((a,b)=>sizeIdx(a[0])-sizeIdx(b[0])),'المقاس')}
    ${tbl('حسب اللون', by(m=>COLOR_AR[m.color]||m.color),'اللون')}
    ${tbl('حسب القناة', by(m=>({studio:'الاستديو',online:'أونلاين',salla:'متجر سلة'}[m.channel]||m.channel)),'القناة')}` : '<p class="hint">لا توجد مبيعات في هذه الفترة.</p>';
};
$('#repXlsx').onclick=()=>{ if(!repRows.length) return toast('اعرض التقرير أولاً');
  writeXlsx(`تقرير-مبيعات-${$('#repFrom').value}_${$('#repTo').value}.xlsx`,{'الحركات':repRows.map(m=>({'التاريخ':fmtDate(m.at),'العملية':TYPE_AR[m.type],'رقم':m.ref,'الكود':m.sku,'الموديل':m.model,'اللون':m.color,'المقاس':m.size,'العدد':m.qty,'السعر':m.price,'التكلفة':m.cost,'القناة':m.channel,'العميلة':m.customer,'بواسطة':m.username,'ملاحظة':m.note}))}); };
{ const base=TABS.summary; TABS.summary=()=>{ base(); renderReports(); }; }
{ const base=TABS.data; TABS.data=()=>{ base(); renderSettings(); }; }

/* ===== التحميل والتحديث المباشر ===== */
onReady.push(async()=>{
  await loadSettings(); await loadOps();
  if(REMOTE && !HAS_V2 && isAdmin()) document.querySelector('main').insertAdjacentHTML('afterbegin', `<div class="warnBox">⚠️ ${esc(V2_MSG)}</div>`);
  if(REMOTE && HAS_V2){ let t;
    sb.channel('ops-live').on('postgres_changes',{event:'*',schema:'public',table:'reservations'},()=>{ clearTimeout(t); t=setTimeout(async()=>{ await loadOps(); renderAll(); },400); })
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'movements'},()=>{ clearTimeout(t); t=setTimeout(async()=>{ await loadOps(); renderAll(); },400); }).subscribe(); }
});
