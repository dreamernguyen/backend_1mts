const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const { verifyToken } = require('../middleware/auth.middleware');
const { requireBody } = require('../middleware/validate.middleware');

// Đăng nhập bằng Google: POST /api/auth/google
router.post('/google',
    requireBody('idToken'),
    authController.loginWithGoogle
);

// Đăng nhập chế độ Khách: POST /api/auth/guest
router.post('/guest',
    requireBody('idToken'),
    authController.loginAsGuest
);

// Liên kết tài khoản Khách lên Google: POST /api/auth/link-google  [Cần đăng nhập]
router.post('/link-google',
    verifyToken,
    // ID token đã được xác minh từ Authorization header bởi verifyToken.
    requireBody('guestUserId'),
    authController.linkGoogleAccount
);

// Xóa toàn bộ dữ liệu tài khoản: DELETE /api/auth/account  [Cần đăng nhập]
router.delete('/account',
    verifyToken,
    requireBody('userId'),
    authController.deleteAccountData
);

module.exports = router;
