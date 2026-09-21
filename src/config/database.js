const mongoose = require('mongoose');

const connectDB = async () => {
    try {
        const dbURI = process.env.MONGODB_URI;
        
        if (!dbURI) {
            console.error('[Database Error] Chưa cấu hình MONGODB_URI trong file .env!');
            process.exit(1);
        }

        // Giới hạn pool và thời gian chờ để backend không treo khi Atlas lỗi.
        const conn = await mongoose.connect(dbURI, {
            maxPoolSize: 10,
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
            autoIndex: true,
            family: 4,
        });

        console.log(`[Database] Kết nối MongoDB thành công đến Host: ${conn.connection.host}`);
        console.log(`[Database] Tên Database hiện tại: ${conn.connection.name}`);
        
    } catch (error) {
        console.error(`[Database Error] Kết nối thất bại: ${error.message}`);
        throw error;
    }
};

// Giữ log để chẩn đoán lỗi kết nối khi server vẫn còn chạy.
mongoose.connection.on('disconnected', () => {
    console.warn('[Database Warning] Mất kết nối với MongoDB! Hệ thống sẽ tự động thử kết nối lại...');
});

mongoose.connection.on('error', (err) => {
    console.error(`[Database Error] Lỗi phát sinh trong quá trình vận hành: ${err.message}`);
});

module.exports = connectDB;
