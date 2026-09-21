const cron = require('node-cron');
const Item = require('../models/item.model');
const User = require('../models/user.model');
const Notification = require('../models/notification.model');
const { admin } = require('../config/firebase.config');
const moment = require('moment-timezone');

const startExpiryCronJob = () => {
    // Chạy vào 08:00 AM mỗi ngày theo giờ Việt Nam
    cron.schedule('0 8 * * *', async () => {
        console.log('[Cron] Bắt đầu quét đồ ăn sắp hết hạn...');
        try {
            // Lấy 00:00:00 của ngày hiện tại theo giờ VN
            const todayM = moment().tz('Asia/Ho_Chi_Minh').startOf('day');
            const today = todayM.toDate();

            // Tính 3 ngày sau
            const targetDateM = moment(todayM).add(3, 'days');
            const targetDate = targetDateM.toDate();

            // Chỉ cảnh báo lô thực phẩm còn tồn và sẽ hết hạn trong 3 ngày tới.
            const items = await Item.find({
                expiryDate: { $gte: today, $lte: targetDate },
                usageStatus: 'ACTIVE',
                quantity: { $gt: 0 },
                category: { $in: ['MEAT', 'SEAFOOD', 'VEGETABLE', 'FRUIT', 'EGG', 'DRY_FOOD', 'DRINK', 'SPICE'] }
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
                const message = `Bạn có ${expiringItems.length} lô thực phẩm sẽ hết hạn trong 3 ngày tới. Hãy ưu tiên sử dụng!`;

                // Kiểm tra xem hôm nay đã gửi thông báo EXPIRY_WARNING cho user này chưa
                const startOfDay = todayM.toDate();
                const endOfDay = moment(todayM).endOf('day').toDate();

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

                // Lọc các token hợp lệ
                const validTokens = (user.fcmTokens || []).filter(t => t && t.trim().length > 0);

                // Bắn FCM Push Notification nếu người dùng có Token hợp lệ
                if (admin.apps && admin.apps.length > 0 && validTokens.length > 0) {
                    const payload = {
                        notification: {
                            title: title,
                            body: message
                        },
                        tokens: validTokens
                    };

                    try {
                        const response = await admin.messaging().sendEachForMulticast(payload);
                        console.log(`[Firebase] Đã gửi ${response.successCount} push notification cho user ${userId}`);
                        
                        // Cập nhật cơ chế dọn dẹp các token lỗi (nếu cần thiết sau này)
                        if (response.failureCount > 0) {
                            response.responses.forEach((resp, idx) => {
                                if (!resp.success) {
                                    console.error(`[Firebase] Token fail at idx ${idx}:`, resp.error?.code);
                                }
                            });
                        }
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
