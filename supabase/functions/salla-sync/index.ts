// رفع المنتجات والكميات من الموقع إلى سلة
// يستدعيه الموقع بتوكن المستخدم المسجّل؛ المفاتيح السرية تبقى هنا فقط
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { SALLA_API, SALLA_TOKEN_URL, expiryDate, productPayload, productUpdatePayload, mapVariants, optionIdOf, sallaError, type Item } from '../_shared/salla.ts';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const CLIENT_ID = Deno.env.get('SALLA_CLIENT_ID') || '', CLIENT_SECRET = Deno.env.get('SALLA_CLIENT_SECRET') || '';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'content-type': 'application/json' } });
const log = (kind: string, message: string, payload?: unknown) => db.from('salla_log').insert({ kind, message, payload: payload ?? null }).then(() => {}, () => {});
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---------- مفتاح سلة مع التجديد الآمن (مرة وحدة فقط — توكن التجديد يُستخدم مرة) ----------
async function accessToken(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data: t } = await db.from('salla_tokens').select('*').order('updated_at', { ascending: false }).limit(1).maybeSingle();
    if (!t) throw new Error('المتجر غير مربوط بعد — ثبّت التطبيق على متجرك في سلة');
    const exp = t.expires_at ? Date.parse(t.expires_at) : 0;
    if (exp > Date.now() + 2 * 864e5) return t.access_token;                       // صالح أكثر من يومين
    if (!t.refresh_token) { if (exp > Date.now()) return t.access_token; throw new Error('انتهى مفتاح سلة — أعد تثبيت التطبيق'); }
    // قفل: طلب واحد فقط يجدّد
    const now = new Date().toISOString();
    const { data: lock } = await db.from('salla_tokens').update({ refreshing_until: new Date(Date.now() + 60_000).toISOString() })
      .eq('merchant', t.merchant).or(`refreshing_until.is.null,refreshing_until.lt.${now}`).select('merchant').maybeSingle();
    if (!lock) { await sleep(2500); continue; }                                     // غيرنا يجدّد — ننتظر ونقرأ من جديد
    try {
      const res = await fetch(SALLA_TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: CLIENT_ID, client_secret: CLIENT_SECRET }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.access_token) throw new Error(`فشل تجديد مفتاح سلة: ${j.error_description || j.error || res.status}`);
      await db.from('salla_tokens').update({ access_token: j.access_token, refresh_token: j.refresh_token ?? t.refresh_token,
        expires_at: expiryDate(j.expires_in ?? j.expires), scope: j.scope ?? t.scope, refreshing_until: null, updated_at: new Date().toISOString() }).eq('merchant', t.merchant);
      await log('event', 'تم تجديد مفتاح سلة');
      return j.access_token;
    } catch (e) {
      await db.from('salla_tokens').update({ refreshing_until: null }).eq('merchant', t.merchant);
      await log('error', (e as Error).message); throw e;
    }
  }
  throw new Error('تعذّر الحصول على مفتاح سلة — حاول بعد قليل');
}

async function salla(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(SALLA_API + path, { method, headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) { const err = new Error(sallaError(j, res.status)) as Error & { status?: number; fields?: unknown }; err.status = res.status; err.fields = j?.error?.fields; throw err; }
  return j.data ?? j;
}

// ---------- رفع منتج (موديل + لون) ----------
async function pushGroup(token: string, grp: string, itemIds: string[]) {
  const { data: items, error } = await db.from('items').select('*').in('id', itemIds);
  if (error) throw error;
  const list = (items as Item[]).filter(i => i.sku && i.model);
  if (!list.length) throw new Error('لا توجد مقاسات بكود صالح');
  const { data: ph } = await db.from('photos').select('path,shot,n').eq('grp', grp);
  const photos = (ph || []).sort((a: any, b: any) => (a.shot === 'front' ? -1 : 0) - (b.shot === 'front' ? -1 : 0) || a.n - b.n)
    .map((p: any) => ({ url: db.storage.from('photos').getPublicUrl(p.path).data.publicUrl }));
  const { data: costs } = await db.from('item_costs').select('cost').in('item_id', list.map(i => i.id)).not('cost', 'is', null).limit(1);
  const cost = costs?.[0]?.cost != null ? Number(costs[0].cost) : null;
  const { data: link } = await db.from('salla_products').select('*').eq('grp', grp).maybeSingle();
  const warnings: string[] = [];
  let productId: number | null = link?.product_id ?? null;

  if (productId) {
    try { await salla(token, 'PUT', `/products/${productId}`, productUpdatePayload(list, photos, cost)); }
    catch (e) { if ((e as any).status === 404) productId = null; else throw e; }       // انحذف من سلة → ننشئه من جديد
  }
  if (!productId) {
    const body = productPayload(list, photos, cost);
    let created: any;
    try { created = await salla(token, 'POST', '/products', body); }
    catch (e) {
      const f = (e as any).fields || {};
      if ((e as any).status === 422 && f.price) {                                         // سلة أحياناً ترفض السعر مع الخيارات
        const { price, sale_price, ...rest } = body as any; created = await salla(token, 'POST', '/products', rest);
        warnings.push('السعر يُضبط لكل مقاس');
      } else throw e;
    }
    productId = Number(created.id);
  }

  // تفاصيل المنتج → ربط المقاسات بالمتغيّرات
  let details = await salla(token, 'GET', `/products/${productId}`);
  let map = mapVariants(details);
  const optId = optionIdOf(details);
  for (const i of list) {                                                                 // مقاس جديد غير موجود في سلة
    if (map.has(i.size.toUpperCase())) continue;
    if (!optId) { warnings.push(`لم يُضف المقاس ${i.size}`); continue; }
    try { await salla(token, 'POST', `/products/options/${optId}/values`, { name: i.size, price: 0, quantity: Math.max(0, i.qty) }); }
    catch (e) { warnings.push(`المقاس ${i.size}: ${(e as Error).message}`); }
  }
  if (list.some(i => !map.has(i.size.toUpperCase()))) { details = await salla(token, 'GET', `/products/${productId}`); map = mapVariants(details); }

  const p = list[0]; const priceFix = warnings.includes('السعر يُضبط لكل مقاس');
  const rows = [];
  for (const i of list) {
    const v = map.get(i.size.toUpperCase()); if (!v) continue;
    const vb: Record<string, unknown> = { sku: i.sku, barcode: i.sku, stock_quantity: Math.max(0, i.qty) };
    if (priceFix) { const cmp = Number(p.compare_at ?? 0), pr = Number(p.price ?? 0); vb.price = cmp > pr ? cmp : pr; if (cmp > pr) vb.sale_price = pr; }
    try { await salla(token, 'PUT', `/products/variants/${v.variant_id}`, vb); }
    catch (e) { warnings.push(`${i.sku}: ${(e as Error).message}`); }
    rows.push({ item_id: i.id, product_id: productId, variant_id: v.variant_id, synced_qty: Math.max(0, i.qty), synced_at: new Date().toISOString() });
  }
  if (rows.length) await db.from('salla_variants').upsert(rows);
  await db.from('salla_products').upsert({ grp, product_id: productId, synced_at: new Date().toISOString(), last_error: warnings.join(' | ') || null });
  await log('push', `رفع ${grp} → منتج ${productId}`, { warnings });
  return { grp, product_id: productId, variants: rows.length, warnings, url: details?.urls?.customer ?? null };
}

// ---------- مزامنة الكميات ----------
async function pushStock(token: string, itemIds: string[]) {
  const { data } = await db.from('salla_variants').select('item_id, variant_id, synced_qty, items!inner(qty, sku)').in('item_id', itemIds);
  const done: string[] = [], failed: string[] = [];
  for (const r of (data || []) as any[]) {
    const q = Math.max(0, r.items.qty);
    if (r.synced_qty === q) continue;
    try { await salla(token, 'PUT', `/products/variants/${r.variant_id}`, { stock_quantity: q });
      await db.from('salla_variants').update({ synced_qty: q, synced_at: new Date().toISOString() }).eq('item_id', r.item_id); done.push(r.items.sku); }
    catch (e) { failed.push(`${r.items.sku}: ${(e as Error).message}`); }
  }
  if (failed.length) await log('error', 'فشل تحديث كميات', failed);
  return { updated: done.length, failed };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const jwt = (req.headers.get('authorization') || '').replace(/^bearer\s+/i, '');
    const { data: { user } } = await db.auth.getUser(jwt);
    if (!user) return json({ error: 'سجّل الدخول أولاً' }, 401);
    const { data: prof } = await db.from('profiles').select('role').eq('id', user.id).maybeSingle();
    const admin = prof?.role === 'admin';
    const body = await req.json().catch(() => ({}));

    if (body.action === 'status') {
      const { data: t } = await db.from('salla_tokens').select('merchant, expires_at, scope, updated_at').order('updated_at', { ascending: false }).limit(1).maybeSingle();
      return json({ connected: !!t, merchant: t?.merchant ?? null, expires_at: t?.expires_at ?? null, scope: admin ? t?.scope : undefined });
    }
    if (body.action === 'push_stock') {
      const ids: string[] = (body.item_ids || []).slice(0, 500);
      if (!ids.length) return json({ updated: 0, failed: [] });
      return json(await pushStock(await accessToken(), ids));
    }
    if (body.action === 'push_products') {
      if (!admin) return json({ error: 'رفع المنتجات للمدير فقط' }, 403);
      const token = await accessToken(); const results = [];
      for (const g of (body.groups || []).slice(0, 20)) {                            // 20 منتج كحد أقصى في الطلب الواحد
        try { results.push(await pushGroup(token, String(g.grp), (g.item_ids || []).map(String))); }
        catch (e) { const m = (e as Error).message; results.push({ grp: g.grp, error: m });
          await db.from('salla_products').upsert({ grp: String(g.grp), last_error: m }, { onConflict: 'grp', ignoreDuplicates: false }); await log('error', `${g.grp}: ${m}`); }
      }
      return json({ results });
    }
    return json({ error: 'عملية غير معروفة' }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
