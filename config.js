// إعدادات الربط مع Supabase.
// اتركها فارغة = الموقع يعمل محلياً (البيانات في هذا الجهاز فقط).
// المفتاح هنا هو "anon public key" — مصمم ليكون عاماً، والحماية عبر تسجيل الدخول وسياسات قاعدة البيانات.
// لا تضع هنا مفتاح service_role أبداً.
window.APP_CONFIG = {
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: '',
  // اسم المستخدم "sara" يتحول داخلياً إلى sara@doubleroses.local
  USERNAME_DOMAIN: 'doubleroses.local',
};
