const { createClient } = require('@supabase/supabase-js');

// بيانات الربط (هتلاقيها في إعدادات سوبابيز عندك - API Settings)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg'); // استدعاء واحد فقط هنا
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const app = express();
  
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

app.post('/register-doctor', upload.single('image'), async (req, res) => {
    try {
        const { 
            name, mobile, specialty, fee, availability, 
            address, personal_mobile, title, city, area 
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
    (name, mobile, specialty, fee, availability, address, personal_mobile, title, city, area, image_url, is_active) 
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) 
    RETURNING *`;

// هنا لازم نبعت 12 قيمة بالظبط عشان سوبابيز توافق
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
    area,             // $10
    image_url,        // $11
    false             // $12 (قيمة is_active الافتراضية)
]; 
        const result = await pool.query(query, values);
        res.json({ message: "تم إرسال الطلب بنجاح وفي انتظار تفعيل الإدارة", doctor: result.rows[0] });

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
            mobile, personal_mobile, city, area 
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
        const query = `
            UPDATE doctors 
            SET name=$1, specialty=$2, fee=$3, availability=$4, address=$5, title=$6, image_url=$7,
                mobile=$8, personal_mobile=$9, city=$10, area=$11
            WHERE id=$12 
            RETURNING *`;

        // 4. ترتيب القيم المتجه لقاعدة البيانات
        const values = [
            name, specialty, fee, availability, address, title, image_url,
            mobile, personal_mobile, city, area, 
            id
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
// --- 3. قسم الحجوزات ---

app.post('/book-appointment', async (req, res) => {
    const { doctor_id, doctor_name, patient_name, mobile, appointment_date, price, status } = req.body;

    try {
        const result = await pool.query(
            `INSERT INTO appointments 
            (doctor_id, doctor_name, patient_name, mobile, booking_date, price, status) 
            VALUES ($1, $2, $3, $4, $5, $6, $7) 
            RETURNING *`,
            // 💡 لاحظ هنا بعتنا 'mobile' مرتين: مرة للعمود القديم ومرة للجديد (phone_number)
            [doctor_id, doctor_name, patient_name, mobile, appointment_date, price, 'pending']
        );
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

app.listen(PORT, () => {
    console.log(`
    🚀 ==========================================
    ✅ السيرفر شغال بنجاح على بورت ${PORT}
    📸 نظام رفع الصور مفعل
    🛡️ الاتصال بـ PostgreSQL السحابي جاهز
    =============================================
    `);
});