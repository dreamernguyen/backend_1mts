const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notification.controller');
const { verifyToken } = require('../middleware/auth.middleware');

// Các API này yêu cầu đăng nhập
router.use(verifyToken);

router.get('/', notificationController.getNotifications);
router.put('/mark-all-read', notificationController.markAllAsRead);
router.put('/:id/read', notificationController.markAsRead);

module.exports = router;
