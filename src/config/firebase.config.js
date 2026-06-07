const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const serviceAccountPath = path.resolve(__dirname, 'firebase-service-account.json');

const initializeFirebase = () => {
    try {
        if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
            // Dùng Environment Variables trên Render
            admin.initializeApp({
                credential: admin.credential.cert({
                    projectId: process.env.FIREBASE_PROJECT_ID,
                    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
                })
            });
            console.log('[Firebase] Đã khởi tạo Firebase Admin bằng Environment Variables (Render).');
        } else if (fs.existsSync(serviceAccountPath)) {
            // Dùng file JSON khi chạy Local trên máy tính
            const serviceAccount = require(serviceAccountPath);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            console.log('[Firebase] Đã khởi tạo Firebase Admin bằng file JSON cục bộ.');
        } else {
            console.error('[Firebase] LỖI NGHIÊM TRỌNG: Không có cấu hình Firebase (Thiếu Env Vars và File JSON). Các API xác thực sẽ bị sập!');
        }
    } catch (error) {
        console.error('[Firebase] Lỗi khi khởi tạo Firebase Admin:', error.message);
    }
};

module.exports = { admin, initializeFirebase };
