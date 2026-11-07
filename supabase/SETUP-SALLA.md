# تفعيل الربط مع سلة

الربط له ثلاثة أجزاء:
- **قاعدة البيانات:** تحديث 003.
- **الخدمات:** `salla-sync` و`salla-webhook`، وتشتغل على Supabase.
- **تطبيق في بوابة شركاء سلة.**

## 1) تحديث قاعدة البيانات
1. افتح **SQL Editor** ثم **New query**.
2. الصق محتوى ملف [`003_salla.sql`](003_salla.sql).
3. اضغط **Run**.

## 2) إنشاء تطبيق في سلة
1. ادخل **partners.salla.sa** ثم **التطبيقات**، واختر **إنشاء تطبيق** من نوع **تطبيق خاص** (Private).
2. **طريقة الربط (OAuth Mode):** اختر **Easy Mode**.
3. **الصلاحيات (Scopes):**
   - المنتجات: قراءة وكتابة `products.read_write`
   - الطلبات: قراءة `orders.read` (إذا ما كانت موجودة اختر `orders.read_write`)
   - `offline_access`، وهي ضرورية عشان يتجدد مفتاح الربط تلقائياً
4. **Webhook URL:**
   ```
   https://gjjkdzxmpvjzahujddxo.supabase.co/functions/v1/salla-webhook
   ```
5. **Webhook Security Strategy:** اختر **Signature**، وانسخ **Webhook Secret**.
6. **الأحداث (Events):** فعّل التالي:
   - `order.created`
   - `order.cancelled`
   - `order.refunded`
   - `order.status.updated`
   - `app.uninstalled`
7. من صفحة التطبيق انسخ **Client ID** و**Client Secret**.

> ⚠️ **لا ترسل Client Secret أو Webhook Secret لأي أحد**، حتى في المحادثة.

## 3) حفظ المفاتيح في Supabase
افتح **Edge Functions** ثم **Secrets**، وأضف هذي الثلاثة:

| الاسم | القيمة |
|---|---|
| `SALLA_CLIENT_ID` | Client ID |
| `SALLA_CLIENT_SECRET` | Client Secret |
| `SALLA_WEBHOOK_SECRET` | Webhook Secret |

## 4) نشر الخدمات
في Terminal داخل مجلد المشروع:
```bash
npx supabase login
npx supabase functions deploy salla-sync --project-ref gjjkdzxmpvjzahujddxo
npx supabase functions deploy salla-webhook --project-ref gjjkdzxmpvjzahujddxo --no-verify-jwt
```
أمر `login` يفتح المتصفح وتسجّل فيه دخولك لـ Supabase بنفسك.

## 5) تثبيت التطبيق على متجرك
1. من صفحة التطبيق في بوابة الشركاء، ثبّته على متجرك.
2. سلة ترسل مفاتيح الربط تلقائياً للخدمة.
3. في الموقع ادخل **البيانات** ← **الربط مع سلة**، ولازم يطلع لك **✓ المتجر مربوط**.

## 6) أول تجربة
1. ارفع **منتج واحد** من زر **⬆️ رفع** بجانبه في تبويب المنتجات.
2. افتح متجرك في سلة، وتأكد من الاسم والسعر والمقاسات والصور.
3. إذا كل شيء صحيح، ارفع الباقي من **رفع المنتجات الجديدة إلى سلة**.
