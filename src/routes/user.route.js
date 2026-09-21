const express = require('express');
const router = express.Router();
const userController = require('../controllers/user.controller');
const { verifyToken } = require('../middleware/auth.middleware');

// Lấy thông tin user hiện tại
router.get('/me', verifyToken, userController.getProfile);

// Lấy danh sách công thức đã lưu chi tiết
router.get('/saved-recipes', verifyToken, userController.getSavedRecipes);

// Lấy lịch sử Gamification (Nhật ký sinh tồn)
router.get('/rpg-logs', verifyToken, userController.getRpgLogs);

// Toggle lưu công thức
router.post('/save-recipe', verifyToken, userController.toggleSavedRecipe);

// Cập nhật danh sách đi chợ
router.post('/shopping-list', verifyToken, userController.updateShoppingList);

// Cập nhật FCM token
router.post('/fcm-token', verifyToken, userController.updateFcmToken);

// Cập nhật Profile (Tên, Avatar)
router.put('/profile', verifyToken, userController.updateProfile);

// Cập nhật Cài đặt Tài chính & Gamification
router.put('/settings', verifyToken, userController.updateSettings);

// Xóa tài khoản (P0-03)
router.delete('/me', verifyToken, userController.deleteMyAccount);

module.exports = router;
