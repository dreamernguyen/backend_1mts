const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const serviceAccountPath = path.resolve(__dirname, 'firebase-service-account.json');

const initializeFirebase = () => {
    try {
        if (fs.existsSync(serviceAccountPath)) {
            const serviceAccount = require(serviceAccountPath);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            console.log('[Firebase] Đã khởi tạo Firebase Admin SDK thành công.');
        } else {
            console.warn('[Firebase] Cảnh báo: Không tìm thấy file firebase-service-account.json. Tính năng Push Notification (FCM) sẽ bị vô hiệu hóa.');
        }
    } catch (error) {
        console.error('[Firebase] Lỗi khi khởi tạo Firebase Admin:', error.message);
    }
};

module.exports = { admin, initializeFirebase };
