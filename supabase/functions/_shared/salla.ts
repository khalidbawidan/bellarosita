// منطق مشترك للربط مع سلة — بدون أي اعتماديات خارجية (يُختبر محلياً)

export const SALLA_API = 'https://api.salla.dev/admin/v2';
export const SALLA_TOKEN_URL = 'https://accounts.salla.sa/oauth2/token';

export const SIZES = ['1M','3M','6M','9M','12M','18M','2Y','3Y','4Y','5Y','6Y','7Y','8Y','9Y','10Y','11Y','12Y','13Y','14Y','16Y','18Y'];
export const sizeIdx = (s: string) => { const i = SIZES.indexOf(s); return i < 0 ? 999 : i; };

// ---------- التحقق من توقيع webhook ----------
const enc = new TextEncoder();
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
export async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}
/** يقبل استراتيجية Signature (HMAC-SHA256 للجسم الخام) أو Token (السر نفسه في الهيدر) */
export async function verifyWebhook(rawBody: string, headers: Headers, secret: string): Promise<boolean> {
  if (!secret) return false;
  const strategy = (headers.get('x-salla-security-strategy') || 'signature').toLowerCase();
  const sig = (headers.get('x-salla-signature') || '').trim().toLowerCase();
  if (strategy === 'token') {
    const auth = (headers.get('authorization') || '').replace(/^bearer\s+/i, '').trim();
    return (!!auth && timingSafeEqual(auth, secret)) || (!!sig && timingSafeEqual(sig, secret.toLowerCase()));
  }
  if (!sig) return false;
  return timingSafeEqual(sig, await hmacHex(secret, rawBody));
}

// ---------- الوقت ----------
/** expires من سلة: أحياناً epoch بالثواني، أحياناً مدة بالثواني */
export function expiryDate(expires: unknown, now = Date.now()): string {
  const n = Number(expires);
  if (!n || !isFinite(n)) return new Date(now + 13 * 864e5).toISOString();
  if (n > 1e12) return new Date(n).toISOString();            // ملّي ثانية
  if (n > 1e9) return new Date(n * 1000).toISOString();      // epoch ثواني
  return new Date(now + n * 1000).toISOString();             // مدة
}

// ---------- الطلبات ----------
const amount = (v: any): number | null => {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return Number(v);
  if (typeof v === 'object' && 'amount' in v) return amount(v.amount);
  return null;
};
export interface OrderLine { sku: string; qty: number; price: number | null; product_id: number | null; option: string | null }
/** يستخرج القطع من طلب سلة (نموذج order.created أو order.status.updated) */
export function orderLines(order: any): OrderLine[] {
  const items: any[] = order?.items || [];
  return items.map(i => {
    const qty = Number(i.quantity) || 0;
    const unit = amount(i.amounts?.price_without_tax) ?? amount(i.price) ?? amount(i.product?.price);
    const opt = (i.options || [])[0];
    const optName = opt ? (opt.value?.name ?? opt.value ?? opt.name ?? null) : null;
    return {
      sku: String(i.sku || i.product?.sku || '').trim().toUpperCase(),
      qty, price: unit,
      product_id: Number(i.product?.id ?? i.product_id) || null,
      option: optName == null ? null : String(optName).trim().toUpperCase(),
    };
  }).filter(l => l.qty > 0);
}
export function orderCustomer(order: any): string | null {
  const c = order?.customer; if (!c) return null;
  const n = [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || c.name || '';
  return n || null;
}
export function isCancelStatus(slug: unknown): boolean {
  return ['canceled', 'cancelled', 'restored', 'refunded'].includes(String(slug || '').toLowerCase());
}

// ---------- بناء منتج سلة ----------
export interface Item {
  id: string; sku: string | null; model: string; brand: string; category: string; color: string; size: string; qty: number;
  price: number | null; compare_at: number | null; title: string; descr: string; title_ar: string; descr_en: string;
  seo_title: string; seo_desc: string; seo_keywords: string;
}
const CAT_AR: Record<string, string> = { 'Eid Dress': 'فستان عيد', 'Daily Dress': 'فستان يومي', 'Wedding Dress': 'فستان زفاف', 'Summer Dress': 'فستان صيفي', 'Winter Dress': 'فستان شتوي' };
const esc = (s: string) => String(s || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
export const OPTION_NAME = 'المقاس';

export function productName(f: Item): string {
  return (f.title_ar || f.title || `${CAT_AR[f.category] || 'فستان'} - موديل ${f.model}`).slice(0, 250);
}
/** السعر في سلة: price = السعر الأصلي، sale_price = سعر البيع إذا فيه خصم */
export function prices(f: Item): { price: number; sale_price?: number } {
  const p = Number(f.price ?? 0), cmp = Number(f.compare_at ?? 0);
  return cmp > p && p > 0 ? { price: cmp, sale_price: p } : { price: p };
}
export function productPayload(items: Item[], photos: { url: string }[], cost: number | null) {
  const arr = [...items].sort((a, b) => sizeIdx(a.size) - sizeIdx(b.size));
  const f = arr[0];
  const name = productName(f);
  const parts = [f.descr && `<p>${esc(f.descr).replace(/\n/g, '<br>')}</p>`, f.descr_en && `<p dir="ltr">${esc(f.descr_en).replace(/\n/g, '<br>')}</p>`].filter(Boolean);
  const body: Record<string, unknown> = {
    name,
    product_type: 'product',
    ...prices(f),
    description: parts.join('') || `<p>${esc(name)}</p>`,
    metadata_title: (f.seo_title || name).slice(0, 70),
    metadata_description: (f.seo_desc || f.descr || name).slice(0, 300),
    weight: 0.5, weight_type: 'kg',
    options: [{
      name: OPTION_NAME, display_type: 'text',
      values: arr.map(i => ({ name: i.size, price: 0, quantity: Math.max(0, i.qty || 0) })),
    }],
  };
  if (cost != null) body.cost_price = cost;
  if (photos.length) body.images = photos.map((p, i) => ({ original: p.url, thumbnail: p.url, alt: name, default: i === 0, sort: i + 1 }));
  return body;
}
/** نفس البيانات بدون الخيارات — للتحديث */
export function productUpdatePayload(items: Item[], photos: { url: string }[], cost: number | null) {
  const b = productPayload(items, photos, cost); delete b.options; return b;
}

/** يربط كل مقاس بمتغيّر سلة من تفاصيل المنتج */
export function mapVariants(details: any): Map<string, { variant_id: number; option_value_id: number }> {
  const out = new Map<string, { variant_id: number; option_value_id: number }>();
  const opt = (details?.options || []).find((o: any) => o.name === OPTION_NAME) || (details?.options || [])[0];
  if (!opt) return out;
  const valByName = new Map<number, string>();
  for (const v of opt.values || []) valByName.set(Number(v.id), String(v.name).trim().toUpperCase());
  for (const s of details?.skus || []) {
    for (const vid of s.related_option_values || []) {
      const size = valByName.get(Number(vid));
      if (size) out.set(size, { variant_id: Number(s.id), option_value_id: Number(vid) });
    }
  }
  return out;
}
export function optionIdOf(details: any): number | null {
  const opt = (details?.options || []).find((o: any) => o.name === OPTION_NAME) || (details?.options || [])[0];
  return opt ? Number(opt.id) : null;
}
export function sallaError(json: any, status: number): string {
  const e = json?.error; if (!e) return `HTTP ${status}`;
  const f = e.fields ? Object.entries(e.fields).map(([k, v]) => `${k}: ${(v as string[]).join('، ')}`).join(' | ') : '';
  return [e.message, f].filter(Boolean).join(' — ') || `HTTP ${status}`;
}
