const cron = require('node-cron');
const Item = require('../models/item.model');
const User = require('../models/user.model');
const Notification = require('../models/notification.model');
const { admin } = require('../config/firebase.config');

const startExpiryCronJob = () => {
    // Chạy vào 08:00 AM mỗi ngày theo giờ Việt Nam
    cron.schedule('0 8 * * *', async () => {
        console.log('[Cron] Bắt đầu quét đồ ăn sắp hết hạn...');
        try {
            const today = new Date();
            today.setHours(0, 0, 0, 0);

            const targetDate = new Date(today);
            targetDate.setDate(today.getDate() + 3);

            // Tìm tất cả item có expiryDate <= today + 3 ngày
            const items = await Item.find({
                expiryDate: { $lte: targetDate }
            });

            if (items.length === 0) {
                console.log('[Cron] Không có đồ ăn nào sắp hết hạn.');
                return;
            }

            // Gom nhóm theo userId
            const userItems = {};
            items.forEach(item => {
                const uid = item.userId.toString();
                if (!userItems[uid]) userItems[uid] = [];
                userItems[uid].push(item);
            });

            let sentCount = 0;

            for (const userId in userItems) {
                const user = await User.findById(userId);
                if (!user) continue;

                const expiringItems = userItems[userId];
                
                // Tạo nội dung thông báo tổng hợp
                const title = 'Cảnh báo hạn sử dụng!';
                const message = `Tủ lạnh đang khóc thét: Bạn có ${expiringItems.length} món đồ ăn sắp hoặc đã hết hạn. Hãy kiểm tra ngay!`;

                // Kiểm tra xem hôm nay đã gửi thông báo EXPIRY_WARNING cho user này chưa
                const startOfDay = new Date(today);
                const endOfDay = new Date(today);
                endOfDay.setHours(23, 59, 59, 999);

                const existingNotif = await Notification.findOne({
                    userId: userId,
                    type: 'EXPIRY_WARNING',
                    createdAt: { $gte: startOfDay, $lte: endOfDay }
                });

                if (existingNotif) {
                    continue; // Đã gửi hôm nay rồi, không spam nữa
                }

                // Lưu Notification vào Database
                await Notification.create({
                    userId: userId,
                    title: title,
                    message: message,
                    type: 'EXPIRY_WARNING'
                });

                // Bắn FCM Push Notification nếu người dùng có Token
                if (admin.apps && admin.apps.length > 0 && user.fcmTokens && user.fcmTokens.length > 0) {
                    const payload = {
                        notification: {
                            title: title,
                            body: message
                        },
                        tokens: user.fcmTokens
                    };

                    try {
                        const response = await admin.messaging().sendEachForMulticast(payload);
                        console.log(`[Firebase] Đã gửi ${response.successCount} push notification cho user ${userId}`);
                    } catch (fcmError) {
                        console.error('[Firebase] Lỗi khi gửi FCM:', fcmError.message);
                    }
                }
                sentCount++;
            }
            console.log(`[Cron] Quét hoàn tất. Đã tạo thông báo cho ${sentCount} người dùng.`);
        } catch (error) {
            console.error('[Cron] Lỗi khi quét hạn sử dụng:', error);
        }
    }, {
        scheduled: true,
        timezone: "Asia/Ho_Chi_Minh"
    });
};

module.exports = { startExpiryCronJob };
