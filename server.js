require('dotenv').config();

const express = require('express');
const cors = require('cors');
const connectDB = require('./src/config/database');

// Nạp các tệp định tuyến (Routes) của dự án
const authRoutes = require('./src/routes/auth.route');
const pantryRoutes = require('./src/routes/pantry.route'); 
const receiptRoutes = require('./src/routes/receipt.route');

// 2. Khởi tạo ứng dụng Web Server
const app = express();

// 3. Tích hợp các Middleware nền tảng
app.use(cors()); // Hỗ trợ Flutter chạy trên Web/Trình duyệt không bị lỗi chặn CORS
app.use(express.json({ limit: '10mb' })); // Tăng giới hạn tải trọng để tiếp nhận ảnh chụp hóa đơn Base64 dung lượng lớn

// 4. Kích hoạt cổng kết nối tới đám mây MongoDB Atlas
connectDB();

// 5. Khai báo các tuyến đường cổng API cho dự án
app.use('/api/auth', authRoutes);
app.use('/api/pantry', pantryRoutes);   
app.use('/api/receipt', receiptRoutes);

// 6. Cổng kiểm tra trạng thái sức khỏe máy chủ (Health Check)
app.get('/health', (req, res) => {
    return res.status(200).json({
        success: true,
        message: "Hệ thống Backend 1MTS vận hành thông suốt ổn định!",
        timestamp: new Date()
    });
});

// 7. Lắng nghe và mở cổng kết nối tại Port chỉ định
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`===================================================`);
    console.log(`[Server] Máy chủ 1MTS đang chạy tại: http://localhost:${PORT}`);
    console.log(`===================================================`);
});