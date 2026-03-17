const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const app = express();

// --- 1. الإعدادات العامة ---
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}
app.use('/uploads', express.static(uploadDir));

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage: storage });

// --- 2. إعداد الاتصال بسوبابيز (الرابط المصلح) ---
const pool = new Pool({
  connectionString: "postgresql://postgres.jvaiadgohuvgzgmwqnom:Aioota2026as@aws-1-eu-central-1.pooler.supabase.com:5432/postgres",
  ssl: { rejectUnauthorized: false }
});

// --- 3. قسم الأطباء (Doctors) ---

app.get('/doctors', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM doctors ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) {
        console.error("❌ خطأ جلب الأطباء:", err.message);
        res.status(500).json({ error: "فشل جلب البيانات" });
    }
});

app.post('/register-doctor', upload.single('image'), async (req, res) => {
    try {
        const { name, mobile, specialty, fee, availability, address, personal_mobile, title, city, area } = req.body;
        app.post('/register-doctor', upload.single('image'), async (req, res) => {
    // السطرين دول هم اللي هيقولوا لنا الحقيقة
    console.log("📦 Body received:", req.body); 
    console.log("🖼️ File received:", req.file);

    try {
        // باقي الكود...
        // حل مشكلة التحذير الأصفر (Mixed Content) بإجبار HTTPS
        const host = req.get('host');
        const image_url = req.file ? `https://${host}/uploads/${req.file.filename}` : '';
        
        const query = `
            INSERT INTO doctors 
            (name, mobile, specialty, fee, availability, address, personal_mobile, title, city, area, image_url, is_active) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, FALSE) 
            RETURNING *`;
        
        const values = [name, mobile, specialty, parseInt(fee) || 0, availability, address, personal_mobile, title, city, area, image_url];
        
        const result = await pool.query(query, values);
        res.status(200).json({ message: "تم إرسال الطلب بنجاح وفي انتظار تفعيل الإدارة", doctor: result.rows[0] });
    } catch (err) {
        console.error("❌ خطأ تسجيل دكتور:", err.message);
        res.status(500).json({ error: "فشل في تسجيل البيانات: " + err.message });
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

// --- 4. قسم الحجوزات (Appointments) ---

app.post('/book-appointment', async (req, res) => {
    const { doctor_id, doctor_name, patient_name, patient_mobile, appointment_date, price } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO appointments (doctor_id, doctor_name, patient_name, mobile, booking_date, price, status) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
            [doctor_id, doctor_name, patient_name, patient_mobile, appointment_date, price, 'pending']
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error("❌ Database Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/appointments', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM appointments ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: "فشل جلب الحجوزات" });
    }
});

app.patch('/update-appointment/:id', async (req, res) => {
    try {
        const { status } = req.body;
        await pool.query('UPDATE appointments SET status = $1 WHERE id = $2', [status, req.params.id]);
        res.json({ message: "تم تحديث حالة الحجز" });
    } catch (err) {
        res.status(500).json({ error: "فشل التحديث" });
    }
});

// --- 5. التحديث التلقائي (Cron Job) ---
cron.schedule('0 * * * *', async () => {
    try {
        const query = `UPDATE appointments SET status = 'completed' WHERE status = 'pending' AND booking_date < NOW() - INTERVAL '48 hours'`;
        await pool.query(query);
        console.log('✅ تم تحديث الحجوزات القديمة تلقائياً');
    } catch (err) {
        console.error('❌ خطأ في التحديث التلقائي:', err.message);
    }
});

// --- 6. تشغيل السيرفر ---
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 السيرفر يعمل بنسخة مصلحة بالكامل على بورت ${PORT}`);
});

// Update: final connection fix 2026
