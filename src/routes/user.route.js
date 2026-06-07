const express = require('express');
const router = express.Router();
const userController = require('../controllers/user.controller');
const { verifyToken } = require('../middleware/auth.middleware');

// Lấy thông tin user hiện tại
router.get('/me', verifyToken, userController.getProfile);

// Lấy danh sách công thức đã lưu chi tiết
router.get('/saved-recipes', verifyToken, userController.getSavedRecipes);

// Toggle lưu công thức
router.post('/save-recipe', verifyToken, userController.toggleSavedRecipe);

// Cập nhật danh sách đi chợ
router.post('/shopping-list', verifyToken, userController.updateShoppingList);

// Cập nhật FCM token
router.post('/fcm-token', verifyToken, userController.updateFcmToken);

// Cập nhật Profile (Tên, Avatar)
router.put('/profile', verifyToken, userController.updateProfile);

module.exports = router;
