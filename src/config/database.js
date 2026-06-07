const mongoose = require('mongoose');

const connectDB = async () => {
    try {
        // Lấy chuỗi URI từ file .env
        const dbURI = process.env.MONGODB_URI;
        
        if (!dbURI) {
            console.error('[Database Error] Chưa cấu hình MONGODB_URI trong file .env!');
            process.exit(1);
        }

        // Thực hiện kết nối đến Cloud với các cấu hình tối ưu hiệu năng
        const conn = await mongoose.connect(dbURI, {
            // Render + Atlas optimization
            maxPoolSize: 10, // Giới hạn connection pool, tránh quá tải server/Atlas Free Tier
            serverSelectionTimeoutMS: 5000, // Fail fast nếu DB chết thay vì treo request 30s
            socketTimeoutMS: 45000, // Đóng connection nếu bị treo quá lâu
            autoIndex: true, // Tự động build index (ở prod lớn có thể set false)
        });

        console.log(`[Database] Kết nối MongoDB thành công đến Host: ${conn.connection.host}`);
        console.log(`[Database] Tên Database hiện tại: ${conn.connection.name}`);
        
    } catch (error) {
        console.error(`[Database Error] Kết nối thất bại: ${error.message}`);
        // Thoát ứng dụng ngay lập tức với mã lỗi 1 nếu không có database nền tảng
        process.exit(1);
    }
};

// LẮNG NGHE SỰ KIỆN: Tự động phát thông báo nếu kết nối bị ngắt quãng trong lúc app đang chạy
mongoose.connection.on('disconnected', () => {
    console.warn('[Database Warning] Mất kết nối với MongoDB! Hệ thống sẽ tự động thử kết nối lại...');
});

mongoose.connection.on('error', (err) => {
    console.error(`[Database Error] Lỗi phát sinh trong quá trình vận hành: ${err.message}`);
});

module.exports = connectDB;