require('dotenv').config();

const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const connectDB = require('./src/config/database');
const { errorHandler } = require('./src/middleware/errorHandler.middleware');
const { requestLogger } = require('./src/middleware/requestLogger.middleware');

// Tách route theo nghiệp vụ để server chỉ lo khởi tạo.
const authRoutes = require('./src/routes/auth.route');
const itemRoutes = require('./src/routes/item.route');
const transactionRoutes = require('./src/routes/transaction.route');
const recipeRoutes = require('./src/routes/recipe.route');
const userRoutes = require('./src/routes/user.route');
const notificationRoutes = require('./src/routes/notification.route');
const questRoutes = require('./src/routes/quest.route');
const meterRoutes = require('./src/routes/meter.route');

// Firebase xác thực; cron nhắc lô sắp hết hạn.
const { admin, initializeFirebase } = require('./src/config/firebase.config');
const { startExpiryCronJob } = require('./src/cron/expiry.cron');
const startStreakCron = require('./src/cron/streak.cron');

const app = express();

// Đặt trước CORS/body parser để request bị chặn sớm vẫn có START/END log.
app.use(requestLogger);

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
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Scan-Request-Id',
        'Idempotency-Key',
        'X-Request-Id'
    ],
    exposedHeaders: ['X-Request-Id']
}));

// Tăng giới hạn payload để tiếp nhận ảnh hóa đơn Base64 dung lượng lớn
app.use(express.json({ limit: '10mb' }));

app.use('/api/auth', authRoutes);
app.use('/api/items', itemRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/recipes', recipeRoutes);
app.use('/api/user', userRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/quests', questRoutes);
app.use('/api', meterRoutes);

// Chỉ báo sẵn sàng khi cả MongoDB và Firebase đã khởi tạo.
app.get('/health', (req, res) => {
    const databaseReady = mongoose.connection.readyState === 1;
    const firebaseReady = admin.apps.length > 0;
    const ready = databaseReady && firebaseReady;
    return res.status(ready ? 200 : 503).json({
        success: ready,
        message: ready
            ? 'Hệ thống Backend 1MTS vận hành thông suốt!'
            : 'Backend chưa sẵn sàng nhận request.',
        services: {
            database: databaseReady ? 'ready' : 'unavailable',
            firebase: firebaseReady ? 'ready' : 'unavailable'
        },
        timestamp: new Date()
    });
});

// Phải đặt sau route để nhận lỗi từ toàn bộ request.
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

const startServer = async () => {
    initializeFirebase();
    await connectDB();
    startExpiryCronJob();
    startStreakCron();

    return app.listen(PORT, () => {
        console.log(`[Server] Máy chủ 1MTS đang chạy tại: http://localhost:${PORT}`);
    });
};

if (require.main === module) {
    startServer().catch(error => {
        console.error(`[Server] Không thể khởi động: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { app, startServer };
