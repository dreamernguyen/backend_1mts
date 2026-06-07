require('dotenv').config();

const express = require('express');
const cors = require('cors');
const connectDB = require('./src/config/database');
const { errorHandler } = require('./src/middleware/errorHandler.middleware');

// Nạp các tệp định tuyến (Routes)
const authRoutes = require('./src/routes/auth.route');
const itemRoutes = require('./src/routes/item.route');
const transactionRoutes = require('./src/routes/transaction.route');
const recipeRoutes = require('./src/routes/recipe.route');
const userRoutes = require('./src/routes/user.route');
const notificationRoutes = require('./src/routes/notification.route');

// Require Firebase & Cron
const { initializeFirebase } = require('./src/config/firebase.config');
const { startExpiryCronJob } = require('./src/cron/expiry.cron');

const app = express();

// Khởi tạo Firebase Admin SDK
initializeFirebase();

// Khởi động Job quét đồ ăn hết hạn hàng ngày
startExpiryCronJob();

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);

app.use(cors({
    origin: allowedOrigins.length > 0
        ? (origin, callback) => {
            // Cho phép mobile app (không có origin header) và các domain trong whitelist
            if (!origin || allowedOrigins.includes(origin)) {
                callback(null, true);
            } else {
                callback(new Error(`CORS: Domain "${origin}" không được phép truy cập!`));
            }
        }
        : true, 
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Tăng giới hạn payload để tiếp nhận ảnh hóa đơn Base64 dung lượng lớn
app.use(express.json({ limit: '10mb' }));

// Kết nối MongoDB Atlas
connectDB();

// ROUTES
app.use('/api/auth', authRoutes);
app.use('/api/items', itemRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/recipes', recipeRoutes);
app.use('/api/user', userRoutes);
app.use('/api/notifications', notificationRoutes);

// Health check - Kiểm tra trạng thái server đang sống
app.get('/health', (req, res) => {
    return res.status(200).json({
        success: true,
        message: 'Hệ thống Backend 1MTS vận hành thông suốt!',
        timestamp: new Date()
    });
});

// Middleware xử lý lỗi tập trung
app.use(errorHandler);

// Mở cổng lắng nghe
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`===================================================`);
    console.log(`[Server] Máy chủ 1MTS đang chạy tại: http://localhost:${PORT}`);
    console.log(`===================================================`);
});