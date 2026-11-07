// يستقبل أحداث سلة: تفويض المتجر (المفاتيح)، الطلبات الجديدة، الإلغاء
// يُنشر بدون التحقق من JWT (سلة لا ترسل JWT) — الحماية بتوقيع سلة
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { verifyWebhook, expiryDate, orderLines, orderCustomer, isCancelStatus } from '../_shared/salla.ts';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const SECRET = Deno.env.get('SALLA_WEBHOOK_SECRET') || '';

const log = (kind: string, message: string, payload?: unknown) =>
  db.from('salla_log').insert({ kind, message, payload: payload ?? null }).then(() => {}, () => {});
const ok = (o: unknown = { ok: true }) => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });

/** يكمّل الطلبات اللي قطعها بدون SKU عن طريق رقم المنتج في سلة + اسم المقاس */
async function fillSkus(lines: ReturnType<typeof orderLines>) {
  for (const l of lines) {
    if (l.sku || !l.product_id || !l.option) continue;
    const { data } = await db.from('salla_variants').select('item_id, items!inner(sku,size)').eq('product_id', l.product_id);
    const hit = (data || []).find((r: any) => String(r.items.size).toUpperCase() === l.option);
    if (hit) l.sku = (hit as any).items.sku;
  }
  return lines;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const raw = await req.text();
  if (!(await verifyWebhook(raw, req.headers, SECRET))) {
    await log('error', 'توقيع غير صحيح — تم رفض الطلب');
    return new Response('invalid signature', { status: 401 });
  }
  let ev: any; try { ev = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }
  const event: string = ev.event || '', data = ev.data || {}, merchant = Number(ev.merchant) || null;

  try {
    if (event === 'app.store.authorize') {
      const { error } = await db.from('salla_tokens').upsert({
        merchant, access_token: data.access_token, refresh_token: data.refresh_token ?? null,
        expires_at: expiryDate(data.expires), scope: data.scope ?? null, refreshing_until: null, updated_at: new Date().toISOString(),
      });
      if (error) throw error;
      await log('event', `تم ربط متجر سلة ${merchant}`, { scope: data.scope });   // بدون المفاتيح
      return ok();
    }
    if (event === 'app.uninstalled' || event === 'app.store.uninstalled') {
      await db.from('salla_tokens').delete().eq('merchant', merchant);
      await log('event', 'تم إلغاء تثبيت التطبيق من سلة');
      return ok();
    }
    if (event === 'order.created') {
      const lines = await fillSkus(orderLines(data));
      const { data: res, error } = await db.rpc('apply_salla_order', {
        p_order_id: Number(data.id), p_reference: String(data.reference_id ?? data.id),
        p_lines: lines.map(l => ({ sku: l.sku, qty: l.qty, price: l.price })), p_customer: orderCustomer(data),
      });
      if (error) throw error;
      await log('event', `طلب سلة #${data.reference_id ?? data.id}: ${JSON.stringify(res)}`, { order: data.id, lines });
      return ok(res);
    }
    if (event === 'order.cancelled' || event === 'order.refunded' || event === 'order.deleted') {
      const { data: res, error } = await db.rpc('cancel_salla_order', { p_order_id: Number(data.id) });
      if (error) throw error;
      await log('event', `${event} #${data.reference_id ?? data.id}: ${JSON.stringify(res)}`);
      return ok(res);
    }
    if (event === 'order.status.updated') {
      const order = data.order || {};
      if (isCancelStatus(order.status?.slug)) {
        const { data: res, error } = await db.rpc('cancel_salla_order', { p_order_id: Number(order.id) });
        if (error) throw error;
        await log('event', `إلغاء طلب #${order.reference_id ?? order.id}: ${JSON.stringify(res)}`);
        return ok(res);
      }
      return ok({ ignored: order.status?.slug });
    }
    await log('event', `حدث غير مستخدم: ${event}`);
    return ok({ ignored: event });
  } catch (e) {
    await log('error', `${event}: ${(e as Error).message}`);
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500 });   // سلة تعيد المحاولة
  }
});
