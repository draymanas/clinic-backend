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
});app.post('/book-appointment', async (req, res) => {
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
// إرسال إشعار للمريض باستخدام التوكن الذي وصل للتو
// عدل كود السيرفر ليصبح بهذا الشكل
// في السيرفر: عند إرسال الإشعار للمريض
const { data: appointments, error } = await supabase
    .from('appointments')
    .select('*')
    .eq('mobile', mobile.trim()) // قمنا بإزالة أي مسافات زائدة
    .order('created_at', { ascending: false }) // رتب من الأحدث للأقدم
    .limit(1); // خذ أحدث توكن فقط

if (appointments && appointments.length > 0) {
    const latestToken = appointments[0].fcm_token;
    console.log("✅ تم العثور على أحدث توكن لهذا الموبايل:", latestToken);

    const patientMessage = {
        notification: {
            title: 'تأكيد الحجز',
            body: `تم حجز موعدك بنجاح مع د. ${doctor_name}`
        },
        android: {
            priority: 'high',
            notification: {
                channelId: 'default', // لضمان ظهور التنبيه
                sound: 'default'
            }
        },
        token: latestToken 
    };

    // 2. محاولة الإرسال
    getMessaging().send(patientMessage)
        .then((response) => {
            console.log("✅ تم إرسال إشعار المريض بنجاح، معرف الرسالة:", response);
        })
        .catch((err) => {
            console.error("❌ فشل إرسال إشعار المريض للتوكن:", latestToken);
            console.error("السبب:", err.message);
        });
} else {
    console.log("❌ لا يوجد توكن لهذا الرقم في الجدول!", mobile);
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

app.listen(PORT, () => {
    console.log(`
    🚀 ==========================================
    ✅ السيرفر شغال بنجاح على بورت ${PORT}
    📸 نظام رفع الصور مفعل
    🛡️ الاتصال بـ PostgreSQL السحابي جاهز
    =============================================
    `);
});