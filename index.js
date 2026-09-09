require('dotenv').config(); // ده المحرك اللي بيسحب البيانات من ملف الـ .env
const express = require('express');
const cors = require('cors'); // تأكد من وجود هذا السطر
const app = express();
const admin = require('firebase-admin');
//const { getMessaging } = require('firebase-admin/messaging'); // أضف هذا السطر
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios'); // ضيف السطر ده فوق خالص في أول الملف 
// بيانات الربط (هتلاقيها في إعدادات سوبابيز عندك - API Settings)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);
const { Pool } = require('pg'); // استدعاء واحد فقط هنا
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');

const { initializeApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');
const serviceAccount = require('./serviceAccountKey.json');

// التهيئة الصحيحة للمكتبة الحديثة
initializeApp({
  credential: cert(serviceAccount)
});

console.log("✅ Firebase Admin initialized successfully!");
// 3. التحقق (عشان السيرفر ميهنجش لو الملف مش مقروء)
if (!supabaseUrl || !supabaseKey) {
  console.error("❌ خطأ: لم يتم العثور على بيانات Supabase في ملف .env");
  process.exit(1);
}
// --- 1. الإعدادات العامة ---
app.use(cors());
app.use(express.json());
// إعداد مجلد الرفع (Uploads) للتأكد من وجوده
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}
// جعل مجلد الصور متاحاً للوصول عبر الرابط
app.use('/uploads', express.static(uploadDir));
// إعدادات التخزين لـ Multer
// التخزين في الذاكرة المؤقتة فقط (Memory Storage)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });
// إعدادات الاتصال بـ PostgreSQL (تمت إزالة التكرار)
const pool = new Pool({
  connectionString: "postgresql://postgres.jvaiadgohuvgzgmwqnom:Aioota2026as@aws-1-eu-central-1.pooler.supabase.com:5432/postgres",
  ssl: {
    rejectUnauthorized: false
  }
});
// ==========================================
// 🚀 كود السيرفر المصلح لخدمة الإشعارات (server.js)
// ==========================================
// 🔔 الـ API المصلح لإرسال الإشعارات الجماعية والفردية بالتوافق مع كروت الإرسال
app.post('/api/send-bulk-notification', async (req, res) => {
    // توحيد الحقول المستلمة من طريقتي الإرسال (Dashboard أو NotificationsManager)
    let { targetType, targetId, targetGroup, title, body } = req.body; 

    // إذا جاء الطلب بالصيغة القديمة من لوحة التحكم (targetGroup = 'patients' أو 'doctors')
    if (targetGroup) {
        if (targetGroup === 'patients') targetType = 'all_patients';
        if (targetGroup === 'doctors') targetType = 'all_doctors';
    }

    // التحقق الفوري من صحة المدخلات الأساسية لمنع الفشل
    if (!title || !body) {
        return res.status(400).json({ error: "يرجى ملء كافة حقول العنوان ونص الإشعار تلقائياً" });
    }
    try {
        let query = '';
        let values = [];
        // تحديد الاستعلام المناسب لجمع التوكنات FCM المسجلة بناءً على رغبة الإرسال
        if (targetType === 'all_doctors') {
            query = "SELECT fcm_token FROM doctors WHERE fcm_token IS NOT NULL AND fcm_token != ''";
        } else if (targetType === 'all_patients') {
            query = "SELECT fcm_token FROM patients WHERE fcm_token IS NOT NULL AND fcm_token != ''";
        } else if (targetType === 'specific_doctor' && targetId) {
            query = "SELECT fcm_token FROM doctors WHERE id = $1 AND fcm_token IS NOT NULL AND fcm_token != ''";
            values = [targetId];
        } else {
            return res.status(400).json({ error: "بيانات الإرسال غير متوافقة أو نوع المستلم خاطئ" });
        }

        // تنفيذ الاستعلام لجلب توكنات التطبيقات النشطة
        const result = await pool.query(query, values);
        
        // استخلاص وتنظيف التوكنات (التخلص من المسافات الفارغة والتكرار)
        const rawTokens = result.rows.map(row => row.fcm_token?.trim()).filter(Boolean);
        const tokens = [...new Set(rawTokens)];

        if (tokens.length === 0) {
            return res.status(404).json({ error: "تنبيه: لم يتم العثور على أي توكنات FCM نشطة لهذه الفئة!" });
        }

        let successCount = 0;
        let failureCount = 0;

        // إرسال الإشعارات على دفعات (مجموعة 500 كحد أقصى لكل نداء لفايربيز)
        for (let i = 0; i < tokens.length; i += 500) {
            const chunk = tokens.slice(i, i + 500);
            
            const message = {
                notification: { title, body },
                tokens: chunk,
                // إعدادات مخصصة لأندرويد لتشغيل شاشة التنبيه الفوري بهزاز وصوت مرتفع الأهمية
                android: {
                    priority: 'high',
                    notification: {
                        channelId: 'high_importance_channel',
                        clickAction: 'FLUTTER_NOTIFICATION_CLICK',
                        sound: 'default'
                    }
                },
                // إعدادات IOS لتفعيل الشارة الخارجية وصوت التنبيه
                apns: {
                    payload: {
                        aps: {
                            badge: 1,
                            sound: 'default'
                        }
                    }
                }
            };
            
            // تنفيذ الإرسال الآمن باستخدام مكتبة Messaging الموصى بها رسمياً
            const response = await getMessaging().sendEachForMulticast(message);
            successCount += response.successCount;
            failureCount += response.failureCount;
        }

        console.log(`📢 تم إرسال الإشعارات الجماعية: نجح ${successCount} | فشل ${failureCount}`);
        res.status(200).json({ 
            status: "تم الإرسال بنجاح!", 
            message: `تم إرسال الإشعار لـ ${successCount} جهاز بنجاح. وفشل الإرسال لـ ${failureCount} جهاز.`, 
            sent: successCount, 
            failed: failureCount 
        });

    } catch (err) {
        console.error("❌ خطأ أثناء تنفيذ الإرسال الجماعي:", err);
        res.status(500).json({ error: "فشل الإرسال نتيجة خطأ داخلي بالسيرفر: " + err.message });
    }
});

// باقي المسارات (doctors, register-doctor, book-appointment...) تعمل كما هي تماماً دون تغيير




// ===============================
// Dynamic XML Sitemap
// ===============================
// ===============================
// Dynamic XML Sitemap (SEO Friendly with Doctor Names & Specialties)
// ===============================
// ===============================
// Dynamic XML Sitemap (Doctor Profiles + Specialty & City Category Pages)
// ===============================

const slugifyArabic = (text) => {
  if (!text) return '';
  return text
    .trim()
    .replace(/[\/\#\?\&\\\:\*\"\'\<\>\|\(\)\,\.]/g, '')
    .replace(/\s+/g, '-');
};

const generateDoctorSlug = (doc) => {
  if (!doc || !doc.id) return '';
  const titlePart = doc.title ? `${doc.title} ` : '';
  const rawText = `دكتور ${doc.name || ''} ${titlePart}${doc.specialty || ''}`.trim();
  const cleanSlug = rawText
    .replace(/[\/\#\?\&\\\:\*\"\'\<\>\|\(\)\,\.]/g, '')
    .trim()
    .replace(/\s+/g, '-');
  return `${doc.id}-${encodeURIComponent(cleanSlug)}`;
};
app.get('/sitemap.xml', async (req, res) => {
  try {
    // 1. جلب بيانات الأطباء النشطين
    const { data: doctors, error } = await supabase
      .from('doctors')
      .select('id, name, title, specialty, city, area')
      .eq('is_active', true)
      .order('id', { ascending: true });

    if (error) {
      console.error('Sitemap doctors error:', error);
      return res.status(500).send('Error generating sitemap');
    }

    const baseUrl = 'https://www.doctoreg.online';

    // الصفحات الأساسية الثابتة
    const urls = [
      `
      <url>
        <loc>${baseUrl}/</loc>
        <changefreq>daily</changefreq>
        <priority>1.0</priority>
      </url>
      `,
      `
      <url>
        <loc>${baseUrl}/search</loc>
        <changefreq>daily</changefreq>
        <priority>0.9</priority>
      </url>
      `,
      `
      <url>
        <loc>${baseUrl}/join</loc>
        <changefreq>monthly</changefreq>
        <priority>0.5</priority>
      </url>
      `,
      `
      <url>
        <loc>${baseUrl}/dr/${encodeURIComponent("دكتور-ايمن-عجيب-استشاري-مخ-وأعصاب-وعمود-فقري")}</loc>
        <changefreq>weekly</changefreq>
        <priority>0.95</priority>
      </url>
      `
    ];

    // 🌟 إضافة صفحات المقالات والخدمات التخصصية لخريطة الموقع
    const servicesIds = [
      'spine-surgery', 'nerve-entrapment', 'disc-treatment', 
      'back-pain', 'migraine', 'peripheral-neuropathy', 
      'balance-disorders', 'stroke-memory', 'alzheimers', 
      'movement-disorders', 'optic-pressure', 'multiple-sclerosis', 
      'epilepsy', 'development-delay', 'adhd-autism', 
      'memory-brain', 'cerebral-palsy'
    ];

    servicesIds.forEach(srvId => {
      urls.push(`
      <url>
        <loc>${baseUrl}/service/${srvId}</loc>
        <changefreq>monthly</changefreq>
        <priority>0.85</priority>
      </url>
      `);
    });

    // 2. جمع صفحات التخصصات والمدن والمناطق الفعلية الفريدة
    const categoryPages = new Set();

    if (doctors && doctors.length > 0) {
      doctors.forEach((doc) => {
        if (doc.specialty) {
          const specSlug = encodeURIComponent(slugifyArabic(doc.specialty));
          // صفحة التخصص العام (مثل: /doctors/مخ-وأعصاب)
          categoryPages.add(`/doctors/${specSlug}`);

          if (doc.city) {
            const citySlug = encodeURIComponent(slugifyArabic(doc.city));
            // صفحة التخصص في المحافظة (مثل: /doctors/مخ-وأعصاب/الجيزة)
            categoryPages.add(`/doctors/${specSlug}/${citySlug}`);

            if (doc.area) {
              const areaSlug = encodeURIComponent(slugifyArabic(doc.area));
              // صفحة التخصص في المنطقة (مثل: /doctors/مخ-وأعصاب/الجيزة/6-أكتوبر)
              categoryPages.add(`/doctors/${specSlug}/${citySlug}/${areaSlug}`);
            }
          }
        }
      });

      // إضافة صفحات التصنيفات لخريطة الموقع بأولوية عالية (0.9)
      categoryPages.forEach((path) => {
        urls.push(`
        <url>
          <loc>${baseUrl}${path}</loc>
          <changefreq>weekly</changefreq>
          <priority>0.9</priority>
        </url>
        `);
      });

      // 3. إضافة روابط صفحات الأطباء الشخصية
      doctors.forEach((doctor) => {
        const docSlug = generateDoctorSlug(doctor);
        urls.push(`
        <url>
          <loc>${baseUrl}/dr/${docSlug}</loc>
          <changefreq>weekly</changefreq>
          <priority>0.8</priority>
        </url>
        `);
      });
    }

    const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>`;

    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.send(sitemap);

  } catch (error) {
    console.error('Sitemap generation error:', error);
    res.status(500).send('Error generating sitemap');
  }
});
// --- 2. قسم الأطباء (Doctors) ---

app.get('/doctors', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM doctors ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) {
        console.error("❌ خطأ في جلب الأطباء:", err);
        res.status(500).json({ error: "فشل جلب البيانات" });
    }
});

const sendTelegramAlert = async (doctorData) => {
    const token = '8639669118:AAGOpN9rtWDl_J3kmhoBK3PddqI14jPqEgw';
    const chatId = 6635887452; 

    // هنا بنضمن إننا نقرأ الأسماء اللي جاية من الفورم فعلياً (mobile و personal_mobile)
    const message = `
🔔 **تنبيه: طبيب جديد سجل الآن!** 🔔

👤 **الاسم:** د/ ${doctorData.name || 'غير معروف'}
🎓 **التخصص:** ${doctorData.specialty || 'غير محدد'}
📍 **المحافظة:** ${doctorData.city || 'غير محددة'}
📞 **الموبايل:** ${doctorData.personal_mobile || doctorData.mobile || 'غير متاح'}

يرجى مراجعة لوحة التحكم لتفعيل الحساب.
    `;

    try {
        await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
            chat_id: chatId,
            text: message,
            parse_mode: 'Markdown'
        });
        console.log("✅ تم إرسال تنبيه تليجرام");
    } catch (error) {
        console.error("❌ خطأ تليجرام:", error.response?.data || error.message);
    }
};

app.post('/register-doctor', upload.single('image'), async (req, res) => {
    try {
        const { 
            name, mobile, specialty, fee, availability, 
            address, personal_mobile, title, city, area, bio, password
        } = req.body;
        
        let image_url = '';

        // إذا تم رفع صورة، نقوم برفعها لسوبابيز فوراً
        if (req.file) {
            // اسم فريد للملف باستخدام الوقت عشان ميتكررش
           // 1. استخراج الامتداد من الملف الأصلي (مثلاً .jpg)
          const fileExtension = req.file.originalname.split('.').pop();
// 2. تكوين اسم جديد "رقمي" بالكامل مع الحفاظ على الامتداد
          const fileName = `${Date.now()}-${Math.round(Math.random() * 1E9)}.${fileExtension}`;

            // 1. عملية الرفع لـ Supabase Storage
            const { data, error } = await supabase.storage
                .from('avatars') // تأكد إن اسم الـ Bucket عندك "avatars" وهو Public
                .upload(fileName, req.file.buffer, {
                    contentType: req.file.mimetype,
                    upsert: false
                });

            if (error) {
                console.error("❌ خطأ رفع الصورة لسوبابيز:", error.message);
                throw new Error("فشل رفع الصورة للسحابة");
            }

            // 2. الحصول على الرابط العام المباشر للصورة
            const { data: publicUrlData } = supabase.storage
                .from('avatars')
                .getPublicUrl(fileName);

            image_url = publicUrlData.publicUrl;
        }
        
        // 3. تخزين الرابط الجديد في قاعدة البيانات (SQL)
       // 3. تخزين البيانات في قاعدة البيانات (SQL)
const query = `
    INSERT INTO doctors 
    (name, mobile, specialty, fee, availability, address, personal_mobile, title, city, area, bio, password, image_url, is_active) 
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) 
    RETURNING *`;

// هنا لازم نبعت 14 قيمة بالظبط عشان سوبابيز توافق
const values = [
    name,             // $1
    mobile,           // $2
    specialty,        // $3
    fee,              // $4
    availability,     // $5
    address,          // $6
    personal_mobile,  // $7
    title,            // $8
    city,             // $9
    area,               // $10
    bio,               // $11  
   password || '1234',    // $12
    image_url,        // $13
    false             // $14 (قيمة is_active الافتراضية)
]; 
        const result = await pool.query(query, values);
        res.json({ message: "تم إرسال الطلب بنجاح وفي انتظار تفعيل الإدارة", doctor: result.rows[0] });
        await sendTelegramAlert(req.body);
    } catch (err) {
        console.error("❌ خطأ تسجيل دكتور:", err.message);
        res.status(500).json({ error: "فشل في تسجيل البيانات: " + err.message });
    }
});

// --- تحديث بيانات الطبيب المطور (Update Doctor) ---
app.put('/api/update-doctor/:id', upload.single('image'), async (req, res) => {
    const { id } = req.params;
    try {
        // 1. استخراج كل الحقول الجديدة من req.body
        const { 
            name, specialty, fee, availability, address, title,
            mobile, personal_mobile, city, area, bio, password
        } = req.body;

        let image_url = req.body.image_url; 

        // 2. معالجة الصورة (كما هي في كودك الأصلي)
        if (req.file) {
            const fileExtension = req.file.originalname.split('.').pop();
            const fileName = `updated-${Date.now()}-${Math.round(Math.random() * 1E9)}.${fileExtension}`;

            const { data, error } = await supabase.storage
                .from('avatars')
                .upload(fileName, req.file.buffer, { contentType: req.file.mimetype });

            if (!error) {
                const { data: publicUrlData } = supabase.storage.from('avatars').getPublicUrl(fileName);
                image_url = publicUrlData.publicUrl;
            }
        }

        // 3. تحديث الاستعلام (Query) ليشمل كل الأعمدة الجديدة
// في ملف السيرفر (Update Route)

const query = `
    UPDATE doctors 
    SET name=$1, specialty=$2, fee=$3, mobile=$4, availability=$5, 
        address=$6, personal_mobile=$7, title=$8, city=$9, area=$10, 
        image_url=$11, bio=$12, password=$13
    WHERE id=$14 
    RETURNING *`;

const values = [
    name,             // $1
    specialty,        // $2
    fee,              // $3
    mobile,           // $4 (رقم الحجز - العمود الخامس في سوبا لو شلنا الـ id)
    availability,     // $5
    address,          // $6
    personal_mobile,  // $7 (الرقم الشخصي - العمود الثامن في سوبا لو شلنا الـ id)
    title,            // $8
    city,             // $9
    area,             // $10
    image_url,        // $11
    bio,              // $12
    password,         // $13
    id                // $14
];

        const result = await pool.query(query, values);

        res.json({ success: true, message: "✅ تم تحديث كافة بياناتك بنجاح", doctor: result.rows[0] });
    } catch (err) {
        console.error("❌ خطأ في التحديث:", err);
        res.status(500).json({ error: "فشل تحديث البيانات، تأكد من مطابقة أعمدة قاعدة البيانات" });
    }
});

app.delete('/delete-doctor/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM doctors WHERE id = $1', [req.params.id]);
        res.json({ message: "تم الحذف بنجاح" });
    } catch (err) {
        res.status(500).json({ error: "فشل الحذف" });
    }
});

app.put('/toggle-doctor/:id', async (req, res) => {
    try {
        const { status } = req.body;
        await pool.query('UPDATE doctors SET is_active = $1 WHERE id = $2', [status, req.params.id]);
        res.json({ message: "تم تحديث الحالة بنجاح" });
    } catch (err) {
        res.status(500).json({ error: "فشل تحديث الحالة" });
    }
});

// ميزة تحديث ترتيب الطبيب من صفحة الإدارة
app.put('/update-doctor-order/:id', async (req, res) => {
  const { id } = req.params;
  const { sort_order } = req.body;

  const { data, error } = await supabase
    .from('doctors')
    .update({ sort_order: parseInt(sort_order) })
    .eq('id', id);

  if (error) {
    return res.status(400).json({ error: error.message });
  }
  res.json({ message: "تم تحديث الترتيب بنجاح" });
});

// API لتغيير حالة "التميز" من لوحة الإدارة
app.put('/update-doctor-featured/:id', async (req, res) => {
  const { id } = req.params;
  const { featured } = req.body; 

  const { data, error } = await supabase
    .from('doctors')
    .update({ featured: featured }) 
    .eq('id', id);

  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: "تم تحديث التميز" });
});

app.put('/update-appointment-status/:id', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body; 
    try {
        await pool.query(
            'UPDATE appointments SET status = $1 WHERE id = $2',
            [status, id]
        );
        res.json({ message: "تم تحديث حالة الحجز بنجاح" });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: "فشل تحديث حالة الحجز" });
    }
});
app.get('/test-version', (req, res) => {
    res.send("النسخة الجديدة تعمل بتاريخ اليوم!");
});
// --- مسار جديد للحجز المباشر بواسطة ID الدكتور ---
// 1. هنا بنستقبل الرقم من المتصفح وبنسميه id (اسم مؤقت)
app.get('/doctor-direct/:id', async (req, res) => {
    // 1. تحويل الـ id من نص إلى رقم صحيح
    const doctorId = parseInt(req.params.id);

    console.log("🔍 جاري البحث عن الدكتور رقم:", doctorId);

    try {
        const { data, error } = await supabase
            .from('doctors')
            .select('*')
            .eq('id', doctorId) // نستخدم المتغير الرقمي هنا
            .single();

        if (error || !data) {
            console.error("❌ خطأ من سوبابيز:", error?.message);
            return res.status(404).json({ error: "الدكتور غير موجود" });
        }

        res.json(data);
    } catch (err) {
        console.error("❌ خطأ داخلي:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// =========================================================================
// 🌟 دوال توليد الروابط وحقن كروت فيسبوك وواتساب (Social Meta & SEO)
// =========================================================================

// دالة توليد مسار الـ SEO العربي الكامل للطبيب
function getDoctorSeoPath(doctor, fallbackId) {
  const docId = doctor.id || fallbackId;
  const name = doctor.name || '';
  const title = doctor.title ? `${doctor.title} ` : '';
  const specialty = doctor.specialty || '';
  const city = doctor.city ? `-${doctor.city}` : '';
  const area = doctor.area ? `-${doctor.area}` : '';
  const rawText = `${name}-${title}${specialty}${city}${area}`.trim();
  const cleanSlug = rawText
    .replace(/[\/\#\?\&\\\:\*\"\'\<\>\|\(\)\,\.]/g, '')
    .trim()
    .replace(/\s+/g, '-');
  return cleanSlug ? `/dr/${docId}-${encodeURIComponent(cleanSlug)}` : `/dr/${docId}`;
}

// دالة حقن وسوم الـ Open Graph لكروت Facebook و WhatsApp الرسمية بدون أرقام
function injectDoctorMetaTags(html, doctor, reqId) {
  const doctorName = doctor.name || 'طبيب معتمد';
  const specialty = doctor.specialty || 'استشاري متخصص';
  const titlePrefix = doctor.title ? `${doctor.title} ` : 'طبيب استشاري ';
  const city = doctor.city || '';
  const area = doctor.area || '';
  const locationText = [area, city].filter(Boolean).join(' – ') || 'مصر';
  const doctorFee = doctor.fee ? `سعر الكشف: ${doctor.fee} ج.م` : 'حجز موعد مسبق';
  const doctorPhoto = doctor.image_url || 'https://images.unsplash.com/photo-1622253692010-333f2da6031d?w=1200&h=630&auto=format&fit=crop&q=80';
  const canonicalUrl = `https://www.doctoreg.online${getDoctorSeoPath(doctor, reqId)}`;

  const ogTitle = `دكتور. ${doctorName} | ${titlePrefix}${specialty}`;
  // وصف احترافي بدون أي أرقام هواتف لضمان فتح صفحة الطبيب الشخصية
  const ogDescription = `📍 العيادة: ${locationText} | 📅 احجز موعدك الآن مباشرة عبر صفحة الطبيب الرسمية بدون وسيط أو رسوم إضافية.`;

  let updatedHtml = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${ogTitle} | منصة دكتور</title>`);

  const metaTags = `
    <meta name="description" content="${ogDescription}" />
    <meta property="og:title" content="${ogTitle}" />
    <meta property="og:description" content="${ogDescription}" />
    <meta property="og:image" content="${doctorPhoto}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:url" content="${canonicalUrl}" />
    <meta property="og:type" content="profile" />
    <meta property="og:site_name" content="منصة دكتور" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${ogTitle}" />
    <meta name="twitter:description" content="${ogDescription}" />
    <meta name="twitter:image" content="${doctorPhoto}" />
  `;

  updatedHtml = updatedHtml.replace(/<meta\s+property=["']og:[^>]+>/gi, '');
  updatedHtml = updatedHtml.replace(/<meta\s+name=["']twitter:[^>]+>/gi, '');
  updatedHtml = updatedHtml.replace(/<meta\s+name=["']description["'][^>]+>/gi, '');

  return updatedHtml.replace('</head>', `${metaTags}\n  </head>`);
}

// 🌟 1. مسار الرابط فائق الاختصار للتعليقات
// // =========================================================================
// 🌟 1. مسار الروابط المختصرة للتعليقات والسوشيال ميديا (شامل د. أيمن عجيب + جميع الأطباء)
// =========================================================================
app.get(['/d/:slugOrId', '/ayman', '/d/ayman'], async (req, res, next) => {
  const rawParam = req.params.slugOrId || 'ayman';
  const id = String(rawParam).split('-')[0] || rawParam;

  const userAgent = (req.headers['user-agent'] || '').toLowerCase();
  const isCrawler = /facebookexternalhit|facebot|twitterbot|whatsapp|telegrambot|linkedinbot|slackbot|discordbot/i.test(userAgent);

  // -------------------------------------------------------------------------
  // 🌟 أ) إذا كان المطلوب هو البروفايل الشخصي لدكتور أيمن عجيب (/d/ayman أو /ayman)
  // -------------------------------------------------------------------------
  if (id.toLowerCase() === 'ayman' || req.path.toLowerCase().includes('ayman')) {
    const doctorName = "أيمن عجيب";
    const titlePrefix = "استشاري ";
    const specialty = "المخ والأعصاب والعمود الفقري";
    // رابط صورتك المعتمدة للكارت (نفس الصورة التي ظهرت بنجاح في فرع أكتوبر)
   // 🌟 جلب صورتك الشخصية الحقيقية من الطبيب رقم 40 في قاعدة البيانات
    let doctorPhoto = '';
    try {
      const aymanDb = await pool.query('SELECT image_url FROM doctors WHERE id = 40 LIMIT 1');
      if (aymanDb.rows && aymanDb.rows[0]?.image_url) {
        doctorPhoto = aymanDb.rows[0].image_url;
      }
    } catch (e) {
      console.warn("Could not fetch ayman photo from DB:", e.message);
    }

    if (!doctorPhoto) {
      const { data } = await supabase.from('doctors').select('image_url').eq('id', 40).maybeSingle();
      if (data?.image_url) doctorPhoto = data.image_url;
    } const fullSeoUrl = `https://www.doctoreg.online/dr/${encodeURIComponent("دكتور-ايمن-عجيب-استشاري-مخ-وأعصاب-وعمود-فقري")}`;

    const ogTitle = `دكتور ${doctorName} | ${titlePrefix}${specialty}`;
    const ogDescription = `📍 عيادات د. أيمن عجيب لجراحة المخ والأعصاب والعمود الفقري (فرع 6 أكتوبر - فرع شبرا). احجز موعدك أو أرسل استشارتك الطبية مباشرة.`;

    // إذا كان الطالب زاحف سوشيال ميديا (فيسبوك / واتساب):
    if (isCrawler) {
      const crawlerHtml = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <title>${ogTitle}</title>
  <meta name="description" content="${ogDescription}" />
  <meta property="og:title" content="${ogTitle}" />
  <meta property="og:description" content="${ogDescription}" />
  <meta property="og:image" content="${doctorPhoto}" />
  <meta property="og:image:secure_url" content="${doctorPhoto}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:url" content="https://www.doctoreg.online/d/ayman" />
  <meta property="og:type" content="profile" />
  <meta property="og:site_name" content="منصة دكتور" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${ogTitle}" />
  <meta name="twitter:description" content="${ogDescription}" />
  <meta name="twitter:image" content="${doctorPhoto}" />
</head>
<body>
  <h1>${ogTitle}</h1>
  <p>${ogDescription}</p>
</body>
</html>`;

      res.set('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(crawlerHtml);
    }

    // إذا كان زائراً حقيقياً في المتصفح: تحويل 301 إلى الرابط العربي الكامل للـ SEO
    return res.redirect(301, fullSeoUrl);
  }

  // -------------------------------------------------------------------------
  // 🌟 ب) إذا كان المطلوب أي طبيب آخر عبر الـ ID الرقمي (/d/40, /d/1258...)
  // -------------------------------------------------------------------------
  try {
    let docData = null;
    try {
      const dbRes = await pool.query('SELECT * FROM doctors WHERE id = $1 LIMIT 1', [parseInt(id) || id]);
      if (dbRes.rows && dbRes.rows.length > 0) docData = dbRes.rows[0];
    } catch (e) {
      console.warn("DB query warning in /d/:", e.message);
    }

    if (!docData) {
      const { data } = await supabase.from('doctors').select('*').eq('id', parseInt(id) || id).maybeSingle();
      if (data) docData = data;
    }

    if (!docData) {
      docData = { id, name: 'طبيب معتمد' };
    }

    const doctorName = docData.name || 'طبيب معتمد';
    const specialty = docData.specialty || 'استشاري متخصص';
    const titlePrefix = docData.title ? `${docData.title} ` : 'طبيب استشاري ';
    const city = docData.city || '';
    const area = docData.area || '';
    const locationText = [area, city].filter(Boolean).join(' – ') || 'مصر';
    const doctorPhoto = docData.image_url || 'https://images.unsplash.com/photo-1622253692010-333f2da6031d?w=1200&h=630&auto=format&fit=crop&q=80';

    // إذا كان زاحف فيسبوك أو واتساب: إرسال الكارت بدون سعر الكشف
    if (isCrawler) {
      const ogTitle = `دكتور. ${doctorName} | ${titlePrefix}${specialty}`;
      const ogDescription = `📍 العيادة: ${locationText} | 📅 احجز موعدك الآن مباشرة عبر صفحة الطبيب الرسمية وتعرف على المواعيد المتاحة.`;

      const crawlerHtml = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <title>${ogTitle}</title>
  <meta name="description" content="${ogDescription}" />
  <meta property="og:title" content="${ogTitle}" />
  <meta property="og:description" content="${ogDescription}" />
  <meta property="og:image" content="${doctorPhoto}" />
  <meta property="og:image:secure_url" content="${doctorPhoto}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:url" content="https://www.doctoreg.online/d/${id}" />
  <meta property="og:type" content="profile" />
  <meta property="og:site_name" content="منصة دكتور" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${ogTitle}" />
  <meta name="twitter:description" content="${ogDescription}" />
  <meta name="twitter:image" content="${doctorPhoto}" />
</head>
<body>
  <h1>${ogTitle}</h1>
  <p>${ogDescription}</p>
</body>
</html>`;

      res.set('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(crawlerHtml);
    }

    // إذا كان زائراً حقيقياً في المتصفح: تحويل 301 إلى رابط الـ SEO العربي الكامل
    const seoPath = getDoctorSeoPath(docData, id);
    return res.redirect(301, seoPath);

  } catch (err) {
    console.error('Error in /d/ route:', err);
    res.redirect(301, 'https://www.doctoreg.online/');
  }
});

// =========================================================================
// 🌟 2. مسار روابط الأطباء الأساسية لدعم زواحف فيسبوك وواتساب
// =========================================================================
app.get(['/dr/:slugOrId', '/doctor/:slugOrId'], async (req, res, next) => {
  const rawParam = req.params.slugOrId || '';
  const id = String(rawParam).split('-')[0] || rawParam;

  try {
    const { data: doctor } = await supabase.from('doctors').select('*').eq('id', parseInt(id) || id).single();
    const docData = doctor || { id, name: 'طبيب معتمد' };

    let htmlPath = path.join(__dirname, 'dist', 'index.html');
    if (!fs.existsSync(htmlPath)) {
      htmlPath = path.join(__dirname, 'index.html');
    }

    if (fs.existsSync(htmlPath)) {
      const rawHtml = fs.readFileSync(htmlPath, 'utf-8');
      const customHtml = injectDoctorMetaTags(rawHtml, docData, id);
      return res.status(200).send(customHtml);
    }
  } catch (err) {
    console.error('Error in /dr/ meta:', err);
  }
  next();
});

// =========================================================================
// 🌟 3. مسار كروت المقالات والخدمات الطبية لفيسبوك وواتساب (/service/:serviceId)
// =========================================================================

// خريطة بيانات المقالات والخدمات للكروت والسوشيال ميديا
const servicesMetaMap = {
  'spine-surgery': {
    title: 'جراحات العمود الفقري الميكروسكوبية | علاج الانزلاق الغضروفي',
    desc: 'تعرف على أحدث طرق جراحات العمود الفقري الميكروسكوبية الدقيقة لعلاج الانزلاق الغضروفي وضغط الأعصاب وعرق النسا مع دكتور أيمن عجيب.',
    image: 'https://www.doctoreg.online/spine-surgery.png'
  },
  'nerve-entrapment': {
    title: 'علاج اختناق الأعصاب الطرفية وتنميل اليد والكتف',
    desc: 'أسباب وأعراض اختناق الأعصاب وتسليك العصب الأوسط والزندي بأحدث التقنيات الدقيقة مع دكتور أيمن عجيب.',
    image: 'https://www.doctoreg.online/nerve-entrapment.png'
  },
  'disc-treatment': {
    title: 'علاج الانزلاق الغضروفي القطني والعنقي بدون جراحة تقليدية',
    desc: 'تشخيص وعلاج الانزلاق الغضروفي العنقي والقطني وآلام الرقبة والظهر بأحدث البروتوكولات الطبية مع دكتور أيمن عجيب.',
    image: 'https://www.doctoreg.online/disc-treatment.png'
  },
  'back-pain': {
    title: 'علاج آلام أسفل الظهر وعرق النسا والتنميل',
    desc: 'أحدث وسائل علاج آلام الظهر الحادة والمزمنة وعرق النسا بدون جراحة وتحت إشراف استشاري جراحة المخ والأعصاب.',
    image: 'https://www.doctoreg.online/back-pain.png'
  },
  'migraine': {
    title: 'علاج الصداع النصفي والصداع المزمن وأنواعه',
    desc: 'دليلك الشامل لتشخيص وعلاج نوبات الصداع النصفي والصداع التوتري وأسبابه العصبية مع دكتور أيمن عجيب.',
    image: 'https://www.doctoreg.online/migraine.png'
  },
  'peripheral-neuropathy': {
    title: 'علاج التهاب الأعصاب الطرفية وحرقان وتنميل القدمين',
    desc: 'تشخيص وعلاج التهابات الأعصاب لمصابي السكري ونقص الفيتامينات وبرامج استعادة الإحساس الطبيعي بالأطراف.',
    image: 'https://www.doctoreg.online/peripheral-neuropathy.png'
  },
  'balance-disorders': {
    title: 'علاج الدوخة وعدم الاتزان والرعشة العصبية',
    desc: 'تشخيص أسباب الدوخة المتكررة وعدم التوازن واضطرابات المشي العصبية وطرق علاجها الفعالة.',
    image: 'https://images.unsplash.com/photo-1579684385127-1ef15d508118?w=1200&h=630&fit=crop&q=80'
  },
  'stroke-memory': {
    title: 'جلطات ونزيف المخ وطرق الوقاية والتأهيل العصبي',
    desc: 'التشخيص المبكر والعلاج الدوائي وبرامج التأهيل بعد جلطات الدماغ الحادة والمزمنة مع دكتور أيمن عجيب.',
    image: 'https://images.unsplash.com/photo-1559757175-5700dde675bc?w=1200&h=630&fit=crop&q=80'
  },
  'alzheimers': {
    title: 'علاج ضعف الذاكرة والنسيان والزهايمر المبكر',
    desc: 'أحدث الفحوصات والبرامج العلاجية لتنشيط الذاكرة وإبطاء تطور الزهايمر وأمراض الشيخوخة العصبية.',
    image: 'https://images.unsplash.com/photo-1584515979956-d9f6e5d09982?w=1200&h=630&fit=crop&q=80'
  },
  'movement-disorders': {
    title: 'علاج اضطرابات الحركة والشلل الرعاش والحركات اللاإرادية',
    desc: 'بروتوكولات دوائية وجراحية متطورة للسيطرة على مرض باركنسون (الشلل الرعاش) واضطرابات الجهاز العصبي الحركي.',
    image: 'https://images.unsplash.com/photo-1582719478250-c89cae4dc85b?w=1200&h=630&fit=crop&q=80'
  },
  'optic-pressure': {
    title: 'علاج ارتفاع ضغط المخ وارتشاح العصب البصري والإغماء',
    desc: 'تشخيص أسباب نوبات الإغماء المتكررة وعلاج ارتفاع ضغط السائل الدماغي لحماية النظر والعصب البصري.',
    image: 'https://images.unsplash.com/photo-1576091160399-112ba8d25d1d?w=1200&h=630&fit=crop&q=80'
  },
  'multiple-sclerosis': {
    title: 'علاج التصلب المتعدد (مرض MS) والاضطرابات المناعية',
    desc: 'متابعة وعلاج التصلب اللويحي المتعدد بأحدث العلاجات البيولوجية والمناعية لتقليل الانتكاسات.',
    image: 'https://images.unsplash.com/photo-1532938911079-1b06ac7ceec7?w=1200&h=630&fit=crop&q=80'
  },
  'epilepsy': {
    title: 'علاج التشنجات وزيادة كهرباء المخ والصرع',
    desc: 'تنظيم شحنات المخ الكهربائية وعلاج الصرع والتشنجات للأطفال والبالغين ومتابعة رسم المخ الدقيق.',
    image: 'https://images.unsplash.com/photo-1583912267670-6575ad4736e6?w=1200&h=630&fit=crop&q=80'
  },
  'adhd-autism': {
    title: 'فرط الحركة وتشتت الانتباه (ADHD) وطيف التوحد للأطفال',
    desc: 'تشخيص وعلاج اضطرابات الانتباه والنشاط الزائد وتعديل السلوك للأطفال مع استشاري المخ والأعصاب.',
    image: 'https://images.unsplash.com/photo-1502086223501-7ea6ecd79368?w=1200&h=630&fit=crop&q=80'
  },
  'cerebral-palsy': {
    title: 'علاج الشلل الدماغي وضمور العضلات عند الأطفال والبالغين',
    desc: 'خطط علاج متكاملة وتأهيل حركي وعصبي لحالات الشلل الدماغي وضمور العضلات لتعزيز القدرة على الحركة.',
    image: 'https://images.unsplash.com/photo-1579684385127-1ef15d508118?w=1200&h=630&fit=crop&q=80'
  },
  'idiopathic-intracranial-hypertension': {
    title: 'علاج ارتفاع ضغط المخ الحميد والورم الكاذب للمخ',
    desc: 'تشخيص ومتابعة ارتفاع ضغط المخ مجهول السبب والورم الكاذب، مع تقييم الصداع واضطرابات الرؤية وارتشاح العصب البصري وحماية النظر.',
    image: 'https://images.unsplash.com/photo-1583912267670-6575ad4736e6?w=1200&h=630&fit=crop&q=80'
  },
};

// =========================================================================
// 🌟 مسار مشاركة المقالات والخدمات فائق الاختصار والجمال: /s/:serviceId
// =========================================================================
// =========================================================================
// 🌟 مسار مشاركة المقالات والخدمات فائق الاختصار والجمال: /s/ و /service/
// =========================================================================
app.get(['/s/:serviceId', '/service/:serviceId'], async (req, res, next) => {
  const serviceId = req.params.serviceId || '';
  const userAgent = (req.headers['user-agent'] || '').toLowerCase();
  const isCrawler = /facebookexternalhit|facebot|twitterbot|whatsapp|telegrambot|linkedinbot|slackbot|discordbot/i.test(userAgent);

  const serviceData = servicesMetaMap[serviceId] || {
    title: 'خدمات واستشارات جراحة المخ والأعصاب | دكتور أيمن عجيب',
    desc: 'دليل طبي شامل لتشخيص وعلاج أمراض المخ والأعصاب والعمود الفقري مع دكتور أيمن عجيب.',
    image: 'https://www.doctoreg.online/spine-surgery.png'
  };

  const canonicalUrl = `https://www.doctoreg.online/service/${serviceId}`;

  // 1. 🌟 إذا كان روبوت فيسبوك أو واتساب: إرسال الكارت العربي والصورة فوراً بكود 200
  if (isCrawler) {
    const crawlerHtml = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <title>${serviceData.title}</title>
  <meta name="description" content="${serviceData.desc}" />
  <meta property="og:title" content="${serviceData.title}" />
  <meta property="og:description" content="${serviceData.desc}" />
  <meta property="og:image" content="${serviceData.image}" />
  <meta property="og:image:secure_url" content="${serviceData.image}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:url" content="${canonicalUrl}" />
  <meta property="og:type" content="article" />
  <meta property="og:site_name" content="عيادات دكتور أيمن عجيب" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${serviceData.title}" />
  <meta name="twitter:description" content="${serviceData.desc}" />
  <meta name="twitter:image" content="${serviceData.image}" />
</head>
<body>
  <h1>${serviceData.title}</h1>
  <p>${serviceData.desc}</p>
</body>
</html>`;

    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(crawlerHtml);
  }

  // 2. 🌟 إذا كان زائراً بشرياً عادياً في المتصفح:
  // نرسل صفحة تحميل خفيفة تحمل كارت المقال وتقوم فوراً بتحميل وتوجيه المتصفح لصفحة الخدمة داخل تطبيق React
  const renderClientHtml = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <title>${serviceData.title}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 80vh; background: #f8fafc; color: #1e293b; margin: 0; text-align: center; }
    .loader { width: 42px; height: 42px; border: 4px solid #e2e8f0; border-top-color: #1a73e8; border-radius: 50%; animation: spin 0.8s linear infinite; margin-bottom: 16px; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
  <script>
    // التوجيه الذكي المباشر بدون Loop
    sessionStorage.setItem('current_service', '${serviceId}');
    window.location.replace('/?redirect_service=${serviceId}');
  </script>
</head>
<body>
  <div class="loader"></div>
  <h3 style="margin:0 0 8px 0; font-size:18px;">جاري فتح المقال الطبي...</h3>
  <p style="margin:0; color:#64748b; font-size:14px;">${serviceData.title}</p>
</body>
</html>`;

  res.set('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(renderClientHtml);
});

app.post('/book-appointment', async (req, res) => {
    const { doctor_id, doctor_name, patient_name, mobile, appointment_date, price, fcm_token } = req.body;

    try {
        // 1. حفظ الحجز في قاعدة البيانات
        const result = await pool.query(
            `INSERT INTO appointments 
            (doctor_id, doctor_name, patient_name, mobile, booking_date, price, status, fcm_token) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
            RETURNING *`,
            [doctor_id, doctor_name, patient_name, mobile, appointment_date, price, 'pending', fcm_token]
        );
 
        // 2. جلب التوكن الخاص بالطبيب
        const doctorRes = await pool.query('SELECT fcm_token FROM doctors WHERE id = $1', [doctor_id]);
        const fcmToken = doctorRes.rows[0]?.fcm_token;

        // 3. إرسال الإشعار إذا كان التوكن موجوداً
      // 3. إرسال الإشعار
if (fcmToken) {
    const message = {
        notification: {
            title: 'حجز جديد',
            body: `لديك حجز جديد مع المريض: ${patient_name}`
        },
        token: fcmToken
    };
    
    try {
        console.log("🔄 محاولة إرسال الإشعار...");
       // استبدل السطر المسبب للخطأ بهذا السطر:
await getMessaging().send(message);
        console.log("✅ تم إرسال الإشعار للطبيب بنجاح");
    } catch (error) {
        console.error("❌ فشل إرسال الإشعار للأسباب التالية:", error);
        if (error.code === 'messaging/registration-token-not-registered' || error.code === 'messaging/invalid-registration-token') {
            console.log("⚠️ التوكين غير صالح، جاري حذفه من قاعدة البيانات...");
            try {
                // افترض أن 'pool' هو الاتصال بقاعدة البيانات الخاص بك
                await pool.query('UPDATE doctors SET fcm_token = NULL WHERE fcm_token = $1', [fcmToken]);
                console.log("✅ تم تنظيف التوكين التالف بنجاح");
            } catch (dbError) {
                console.error("❌ فشل حذف التوكين من الداتابيز:", dbError);
            }
        }
    }
}

// بعد إرسال إشعار الطبيب بنجاح، أضف هذا الجزء للأدمن:
const adminToken = process.env.ADMIN_FCM_TOKEN; // التوكن الخاص بك

if (adminToken) {
    const adminMessage = {
        notification: {
            title: 'تنبيه: حجز جديد في العيادة',
            body: `حجز جديد مع الطبيب: ${doctor_name} للمريض: ${patient_name}`
        },
        token: adminToken
    };

    try {
         getMessaging().send(adminMessage);
        console.log("✅ تم إرسال إشعار للأدمن بنجاح");
    } catch (error) {
        console.error("❌ فشل إرسال إشعار الأدمن:", error.message);
    }
}

        // 4. استدعاء الدالة القديمة (إذا كنت لا تزال تحتاجها)
        await sendBookingAlert({
            patient_name: patient_name,
            mobile: mobile,
            doctor_name: doctor_name,
            booking_date: appointment_date
        });

        res.json(result.rows[0]);
    } catch (err) {
        console.error("Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/doctor-appointments/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query(
            'SELECT * FROM appointments WHERE doctor_id = $1 ORDER BY id DESC',
            [id]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).send("Server Error");
    }
});

// =========================================================
// 🆕 أضف هذا الـ API الجديد لجلب سجل حجوزات المريض برقم هاتفه
// =========================================================
app.get('/api/patient-appointments/:mobile', async (req, res) => {
  const { mobile } = req.params;
  try {
    const result = await pool.query(
      'SELECT * FROM appointments WHERE mobile = $1 ORDER BY booking_date DESC, id DESC',
      [mobile]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching patient appointments:", err.message);
    res.status(500).json({ error: "فشل جلب سجل الحجوزات للمريض" });
  }
});

app.post('/api/rate-doctor', async (req, res) => {
  const { doctor_id, rating } = req.body;
  
  // 1. التحقق من صحة المدخلات
  if (!doctor_id || !rating || rating < 1 || rating > 5) {
    return res.status(400).json({ error: "بيانات التقييم غير صالحة" });
  }

  try {
    // 2. جلب القيم الحالية
    const docCheck = await pool.query('SELECT rating_sum, rating_count FROM doctors WHERE id = $1', [doctor_id]);
    
    if (docCheck.rows.length === 0) {
      return res.status(404).json({ error: "الطبيب غير موجود" });
    }

    // التأكد من تحويل القيم لأرقام لتجنب أي خطأ في الحساب
    const currentSum = parseFloat(docCheck.rows[0].rating_sum) || 0;
    const currentCount = parseInt(docCheck.rows[0].rating_count) || 0;

    // 3. حساب القيم الجديدة
    const newCount = currentCount + 1;
    const newSum = currentSum + parseFloat(rating);
    const newRating = Math.round((newSum / newCount) * 10) / 10; 

    // 4. تحديث قاعدة البيانات
    await pool.query(
      'UPDATE doctors SET rating_sum = $1, rating_count = $2, rating = $3 WHERE id = $4',
      [newSum, newCount, newRating, doctor_id]
    );

    // 5. إرسال الرد للفرونت إند
    res.json({ 
      message: "تم تسجيل التقييم بنجاح", 
      rating: newRating,
      rating_count: newCount 
    });

  } catch (err) {
    console.error("Error rating doctor:", err);
    res.status(500).json({ error: "فشل في تسجيل التقييم، حاول مرة أخرى" });
  }
});

 

const sendBookingAlert = async (bookingData) => {
    const token = '8639669118:AAGOpN9rtWDl_J3kmhoBK3PddqI14jPqEgw';
    const chatId = 6635887452; 

    const message = `
📅 **تنبيه: حجز مريض جديد!** 📅

👤 **اسم المريض:** ${bookingData.patient_name || 'غير معروف'}
📞 **موبايل المريض:** ${bookingData.mobile || 'غير متاح'}
👨‍⚕️ **عند الدكتور:** ${bookingData.doctor_name || 'غير محدد'}
⏰ **الموعد:** ${bookingData.booking_date || 'غير محدد'}

يرجى مراجعة المواعيد في لوحة التحكم.
    `;

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    try {
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'Markdown' })
        });
    } catch (err) {
        console.error("❌ فشل إرسال إشعار التليجرام للحجز:", err);
    }
};

app.post('/api/save-token', async (req, res) => {
    const { doctorId, fcmToken } = req.body;
    try {
        await pool.query(
            'UPDATE doctors SET fcm_token = $1 WHERE id = $2',
            [fcmToken, doctorId]
        );
        res.status(200).json({ message: "تم تحديث التوكن بنجاح" });
    } catch (err) {
        console.error("خطأ في حفظ التوكن:", err);
        res.status(500).json({ error: "فشل حفظ التوكن" });
    }
});

 
app.patch('/update-appointment/:id', async (req, res) => {
    try {
        const { status } = req.body;
        await pool.query('UPDATE appointments SET status = $1 WHERE id = $2', [status, req.params.id]);
        res.json({ message: "تم تحديث الحالة بنجاح" });
    } catch (err) {
        console.error("❌ خطأ تحديث الحالة:", err.message);
        res.status(500).json({ error: "فشل التحديث" });
    }
});

app.get('/appointments', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM appointments ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) {
        console.error("❌ خطأ جلب كل الحجوزات:", err.message);
        res.status(500).json({ error: "فشل جلب الحجوزات العامة" });
    }
});

// --- 4. تشغيل السيرفر ---
const PORT = process.env.PORT || 5000;

cron.schedule('0 * * * *', async () => {
    console.log('--- جاري تحديث الحجوزات التي تجاوزت 48 ساعة ---');
    try {
        const query = `
            UPDATE appointments 
            SET status = 'completed' 
            WHERE status = 'pending' 
            AND booking_date < NOW() - INTERVAL '48 hours'
        `;
        const result = await pool.query(query);
        if (result.rowCount > 0) {
            console.log(`✅ تم تحديث ${result.rowCount} حجز تلقائياً.`);
        }
    } catch (err) {
        console.error('❌ خطأ في نظام التحديث التلقائي:', err.message);
    }
});
// --- 5. نظام الاستشارات الطبية (تم تعريفهم مرة واحدة فقط) ---

// API لاستقبال الاستشارة الطبية من الموقع
app.post('/api/consultations', async (req, res) => {
    const { name, phone, question } = req.body;
    try {
        const { data, error } = await supabase
            .from('consultations')
            .insert([{ name, phone, question, status: 'pending' }]);

        if (error) throw error;

        const message = `🩺 **استشارة جديدة من:** ${name}%0A📞 **موبايل:** ${phone}%0A❓ **السؤال:** ${question}`;
        await axios.post(`https://api.telegram.org/bot8639669118:AAGOpN9rtWDl_J3kmhoBK3PddqI14jPqEgw/sendMessage`, {
            chat_id: 6635887452,
            text: message,
            parse_mode: 'Markdown'
        });

        res.json({ success: true, message: "تم إرسال استشارتك بنجاح!" });
    } catch (err) {
        console.error("❌ خطأ في استقبال الاستشارة:", err);
        res.status(500).json({ error: "فشل إرسال الاستشارة" });
    }
});

// API لعرض الأسئلة التي تم الرد عليها للجمهور
app.get('/api/consultations/answered', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('consultations')
            .select('*')
            .eq('status', 'answered')
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: "فشل جلب الاستشارات" });
    }
});
// 1. API خاص بصفحة الأدمن لجلب جَميع الاستشارات (المعلقة والمردود عليها)
app.get('/api/admin/consultations', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('consultations')
            .select('*')
            .order('created_at', { ascending: false }); // جلب الكل وترتيبها من الأحدث للأقدم

        if (error) throw error;
        res.json(data);
    } catch (err) {
        console.error("❌ خطأ في جلب استشارات الأدمن:", err);
        res.status(500).json({ error: "فشل جلب الاستشارات للأدمن" });
    }
});

// 2. API خاص بصفحة الأدمن لتحديث الإجابة والحالة للاستشارة
// 2. API خاص بصفحة الأدمن لتحديث الإجابة والحالة للاستشارة (نسخة مصلحة ومؤمنة)
app.put('/api/admin/consultations/:id', async (req, res) => {
    // 1. تحويل الـ id القادم من الرابط إلى رقم صحيح لمنع تعارض الأنواع مع سوبابيز
    const consultationId = parseInt(req.params.id);
    const { answer, status } = req.body;

    // طباعة البيانات في الـ Logs لمراقبة وصولها بنجاح
    console.log(`🔄 محاولة تحديث الاستشارة رقم: ${consultationId}`, { answer, status });

    // فحص سريع للتأكد من أن الـ ID تم تحويله لرقم بنجاح
    if (isNaN(consultationId)) {
        return res.status(400).json({ error: "معرف الاستشارة غير صحيح (يجب أن يكون رقماً)" });
    }

    try {
        // 2. تنفيذ التحديث في سوبابيز مع إضافة .select() لضمان إتمام العملية وتأكيدها
        const { data, error } = await supabase
            .from('consultations')
            .update({ answer: answer, status: status })
            .eq('id', consultationId) // استخدام المتغير الرقمي المصلح هنا
            .select();

        if (error) {
            console.error("❌ خطأ مباشر من Supabase:", error.message);
            throw error;
        }

        // 3. التحقق مما إذا كان السطر موجوداً وتم تحديثه بالفعل
        if (!data || data.length === 0) {
            console.warn(`⚠️ لم يتم العثور على أي استشارة مطابقة للـ ID: ${consultationId}`);
            return res.status(404).json({ error: "لم يتم العثور على الاستشارة لتحديثها، قد يكون الـ ID خاطئ" });
        }

        console.log("✅ تم التحديث بنجاح في Supabase للسطر:", data[0]);
        
        // إرجاع استجابة نجاح واضحة للمتصفح
        res.json({ success: true, message: "تم تحديث الاستشارة بنجاح!", updatedData: data[0] });
        
    } catch (err) {
        console.error("❌ خطأ شامل في السيرفر أثناء التحديث:", err);
        res.status(500).json({ error: "فشل تحديث الاستشارة", details: err.message });
    }
});

app.post('/talkjs-webhook', async (req, res) => {
    const event = req.body;
    const sender = event.data.sender;
    const participants = event.data.conversation.participants;
    const participantIds = Object.keys(participants);
    const receiverId = participantIds.find(id => id !== sender.id);

    console.log(`🔎 تفاصيل الحدث: المرسل=${sender.id}, المستقبل=${receiverId}`);

    try {
        // 1. محاولة البحث كطبيب (كما طلبت، لم نغير أي شيء هنا)
        const docRes = await pool.query('SELECT fcm_token FROM doctors WHERE id = $1', [receiverId]);
        
        if (docRes.rows.length > 0) {
            console.log("✅ المستقبل هو طبيب، جاري الإرسال...");
            await getMessaging().send({ 
                notification: { title: "رسالة جديدة", body: event.data.message.text }, 
                token: docRes.rows[0].fcm_token 
            });
        } 
        // 2. البحث كمريض (هنا التعديل للبحث في جدول المرضى الجديد)
        else {
            console.log(`🔍 المستقبل ليس طبيب (ID: ${receiverId})، جاري البحث في جدول المرضى...`);
            
            // البحث باستخدام الـ ID (إذا كنت ترسل الـ ID الرقمي لـ TalkJS) 
            // أو استخدم mobile = $1 إذا كنت ترسل رقم الموبايل
           // التعديل هنا: البحث باستخدام الـ mobile بدلاً من الـ id
const patientRes = await pool.query('SELECT fcm_token FROM patients WHERE mobile = $1 AND fcm_token IS NOT NULL LIMIT 1', [receiverId]);
            if (patientRes.rows.length > 0) {
                console.log("✅ المستقبل مريض (تم العثور عليه في جدول المرضى)، جاري الإرسال...");
                await getMessaging().send({ 
                    notification: { title: "رسالة جديدة", body: event.data.message.text }, 
                    token: patientRes.rows[0].fcm_token 
                });
            } else {
                console.log("❌ لم يتم العثور على المستقبل في جدول المرضى!");
            }
        }
    } catch (err) {
        console.error("❌ خطأ في الإرسال:", err);
    }

    res.status(200).send('OK');
});


// ⏰ ٢. نظام التذكير التلقائي اليومي بجدول المواعيد (الساعة 10:00 صباحاً بتوقيت مصر)
// ==========================================================

cron.schedule('10 10 * * *', async () => {
    console.log("--- ⏰ [cron] بدء فحص وإرسال تذكيرات المواعيد لليوم الحالي ---");

    const egyptDate = new Date().toLocaleString("en-CA", { timeZone: "Africa/Cairo" }).split(",")[0];
    
    try {
        // استعلام شامل يجلب كافة البيانات المطلوبة
        const query = `
            SELECT a.id, a.patient_name, a.fcm_token, a.booking_date, d.name as doctor_name
            FROM appointments a
            LEFT JOIN doctors d ON a.doctor_id = d.id
            WHERE a.status = 'pending' 
              AND a.fcm_token IS NOT NULL 
              AND a.fcm_token != ''
              AND TO_CHAR(a.booking_date, 'YYYY-MM-DD') = '${egyptDate}'
        `;

        const { rows } = await pool.query(query);
        console.log(`🔍 تم العثور على (${rows.length}) حجوزات تستحق التذكير.`);

        for (const row of rows) {
            try {
                // 1. تنسيق الوقت
                const timeString = row.booking_date ? new Date(row.booking_date).toLocaleTimeString('ar-EG', {
                    hour: '2-digit', minute: '2-digit', hour12: true
                }) : '';

                // 2. تجهيز الرسالة
                const message = {
                    token: row.fcm_token,
                    notification: {
                        title: '⏰ تذكير بموعد حجزك اليوم',
                        body: `عزيزي ${row.patient_name}، نذكرك بموعد حجزك اليوم بالعيادة مع دكتور ${row.doctor_name || 'الأخصائي'}. يسعدنا حضورك في الموعد المحدد!`
                    },
                    data: {
                        type: 'APPOINTMENT_REMINDER',
                        appointment_id: String(row.id),
                        click_action: 'FLUTTER_NOTIFICATION_CLICK'
                    },
                    android: {
                        priority: 'high',
                        notification: { channelId: 'high_importance_channel', sound: 'default' }
                    },
                    apns: {
                        payload: { aps: { sound: 'default', badge: 1 } }
                    }
                };

                // 3. الإرسال (باستخدام دالة getMessaging المعتمدة)
                await getMessaging().send(message);
                console.log(`✅ تم إرسال تذكير ناجح للمريض: ${row.patient_name}`);
                
            } catch (err) {
                console.error(`❌ فشل إرسال التذكير للمريض ${row.patient_name}:`, err.message);
            }
        }
    } catch (error) {
        console.error("❌ خطأ جماعي في وظيفة كرون جوب التذكير التلقائي:", error.message);
    }
}, {
    scheduled: true,
    timezone: "Africa/Cairo"
});
app.listen(PORT, () => {
    console.log(`
    🚀 ==========================================
    ✅ السيرفر شغال بنجاح على بورت ${PORT}
    📸 نظام رفع الصور مفعل
    🛡️ الاتصال بـ PostgreSQL السحابي جاهز
    =============================================
    `);
});