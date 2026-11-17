# Online4Tech Meta Connector

خدمة خلفية مستقلة لربط صفحة Online4Tech وحساب Instagram الاحترافي المرتبط بها مع Meta Graph API.

## الإعداد مرة واحدة في Cloudflare

1. أنشئ Workers KV namespace باسم `online4tech-meta`.
2. انسخ Namespace ID وضعه بدل `REPLACE_WITH_KV_NAMESPACE_ID` في `wrangler.toml`.
3. أضف Worker Secrets التالية من إعدادات Cloudflare، ولا تضعها في GitHub:
   - `META_APP_SECRET`: App Secret الخاص بتطبيق Meta.
   - `API_KEY`: مفتاح طويل عشوائي لحماية واجهة الربط.
4. قيمة `META_APP_ID` موجودة كإعداد عام في `wrangler.toml`.
5. أضف رابط إعادة التوجيه التالي في Valid OAuth Redirect URIs داخل Meta:
   `https://online4tech-meta.<workers-subdomain>.workers.dev/auth/callback`
6. افتح `https://online4tech-meta.<workers-subdomain>.workers.dev/auth/start` وسجّل الدخول ووافق على الصلاحيات المطلوبة.

يتم اشتقاق مفاتيح التحقق والتشفير داخليًا من App Secret، وتُشفّر رموز الوصول قبل حفظها في KV. لا ترفع أي Token أو App Secret إلى GitHub أو ترسله في المحادثة.

## المسارات الحالية

- `GET /health`: فحص الخدمة.
- `GET /auth/start`: بدء تسجيل الدخول إلى Meta.
- `GET /auth/callback`: التحقق من OAuth state، تبادل كود OAuth، جلب الصفحات والحسابات المرتبطة، وتخزين بيانات الاتصال مشفّرة في KV.
- `GET /api/status`: حالة الاتصال، ويتطلب `Authorization: Bearer <API_KEY>`.
- `GET /api/pages`: الصفحات والحسابات المرتبطة، ويتطلب المفتاح نفسه.

**مهم:** هذه نسخة تأسيسية للربط والقراءة فقط. لن يتم نشر محتوى أو الرد على تعليقات أو رسائل قبل اختبار الاتصال وإضافة المسارات المناسبة وموافقتك الصريحة.
