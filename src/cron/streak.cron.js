const cron = require('node-cron');
const User = require('../models/user.model');
const Notification = require('../models/notification.model');
const { admin } = require('../config/firebase.config');
const { getVietnamDayBounds } = require('../services/quest.service');

const STREAK_MESSAGES = [
    'Á á á! Chuỗi sinh tồn {streak} ngày của bạn sắp cháy rụi rồi! Đăng nhập ngay!',
    'Streak {streak} ngày đang khóc thét! Cứu nó trước nửa đêm nhé!',
    'Bạn nỡ lòng nào vứt bỏ {streak} ngày sinh tồn gian khổ sao? Vào app ngay!',
    'Chuông báo động! Chỉ còn vài tiếng nữa là streak {streak} ngày bay màu!',
    'Không thể tin được là bạn định bỏ rơi chuỗi {streak} ngày! Quay lại đi!',
    'Nửa đêm là cỗ xe bí ngô biến mất, và streak {streak} ngày của bạn cũng vậy!'
];

const startStreakCron = () => {
    // Chạy vào 20:30 mỗi tối
    cron.schedule('30 20 * * *', async () => {
        try {
            console.log('[Cron] Bắt đầu kiểm tra và gửi thông báo nhắc nhở Streak...');
            
            const now = new Date();
            const { todayStart, yesterdayStart } = getVietnamDayBounds(now);

            // Tìm user có streak > 0, đã đăng nhập hôm qua, nhưng hôm nay chưa điểm danh
            // và có fcmToken
            const users = await User.find({
                'rpgStats.loginStreak': { $gt: 0 },
                'rpgStats.lastLoginDate': {
                    $gte: yesterdayStart,
                    $lt: todayStart
                },
                'fcmTokens': { $exists: true, $not: { $size: 0 } }
            }).select('_id fcmTokens rpgStats.loginStreak');

            if (users.length === 0) {
                console.log('[Cron] Không có user nào cần nhắc nhở streak hôm nay.');
                return;
            }

            console.log(`[Cron] Tìm thấy ${users.length} user có nguy cơ mất streak.`);

            const notificationsToSave = [];
            
            // Nếu Firebase Admin chưa được khởi tạo đúng cách thì không gửi push được
            // Nhưng vẫn có thể lưu vào bảng Notification
            const canSendPush = admin && admin.apps.length > 0;

            for (const user of users) {
                const streak = user.rpgStats.loginStreak;
                const randomMsg = STREAK_MESSAGES[Math.floor(Math.random() * STREAK_MESSAGES.length)];
                const messageBody = randomMsg.replace('{streak}', streak);

                // 1. Tạo Notification trong DB
                notificationsToSave.push({
                    userId: user._id,
                    title: '🔥 Cảnh báo mất Streak!',
                    message: messageBody,
                    type: 'GAMIFICATION'
                });

                // 2. Gửi Push Notification qua Firebase
                if (canSendPush) {
                    const payload = {
                        notification: {
                            title: '🔥 Cảnh báo mất Streak!',
                            body: messageBody,
                        },
                        data: {
                            type: 'STREAK_WARNING',
                            click_action: 'FLUTTER_NOTIFICATION_CLICK',
                        }
                    };

                    try {
                        // Gửi đến tất cả các thiết bị của user này
                        await admin.messaging().sendEachForMulticast({
                            tokens: user.fcmTokens,
                            ...payload
                        });
                    } catch (fcmErr) {
                        console.error(`[Cron] Lỗi gửi FCM cho user ${user._id}:`, fcmErr.message);
                    }
                }
            }

            if (notificationsToSave.length > 0) {
                await Notification.insertMany(notificationsToSave);
            }

            console.log(`[Cron] Đã hoàn thành gửi ${users.length} nhắc nhở streak.`);
        } catch (error) {
            console.error('[Cron] Lỗi khi chạy cron nhắc nhở streak:', error);
        }
    }, {
        scheduled: true,
        timezone: 'Asia/Ho_Chi_Minh'
    });
};

module.exports = startStreakCron;
