const express = require('express');
const router = express.Router();
const questController = require('../controllers/quest.controller');
const { verifyToken } = require('../middleware/auth.middleware');
const { idempotencyMiddleware } = require('../middleware/idempotency.middleware');

// Áp dụng middleware kiểm tra token cho tất cả API nhiệm vụ
router.use(verifyToken);

// Lấy nhiệm vụ hàng ngày (Tự sinh nếu chưa có)
router.get('/daily', questController.getDailyQuests);

// Nhận thưởng nhiệm vụ hàng ngày
router.post('/daily/claim/:questId', idempotencyMiddleware, questController.claimQuestReward);

// Lấy danh sách thành tựu (Sảnh Vinh Danh)
router.get('/achievements', questController.getAchievements);

module.exports = router;
