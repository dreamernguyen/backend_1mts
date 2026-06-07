const Notification = require('../models/notification.model');

// Get notifications
exports.getNotifications = async (req, res, next) => {
    try {
        const userId = req.user.userId;
        const notifications = await Notification.find({ userId })
            .sort({ createdAt: -1 })
            .limit(50); // Lấy 50 thông báo gần nhất

        console.log(`[API] ${req.method} ${req.originalUrl} - Get notifications success (User: ${userId})`);
        res.status(200).json({
            status: 'success',
            data: { notifications }
        });
    } catch (error) {
        next(error);
    }
};

// Mark notification as read
exports.markAsRead = async (req, res, next) => {
    try {
        const notificationId = req.params.id;
        const userId = req.user.userId;

        const notification = await Notification.findOneAndUpdate(
            { _id: notificationId, userId },
            { isRead: true },
            { new: true }
        );

        if (!notification) {
            return res.status(404).json({ success: false, message: 'Không tìm thấy thông báo' });
        }

        console.log(`[API] ${req.method} ${req.originalUrl} - Mark as read success (User: ${userId}, Notif: ${notificationId})`);
        res.status(200).json({
            status: 'success',
            data: { notification }
        });
    } catch (error) {
        next(error);
    }
};

// Mark all as read
exports.markAllAsRead = async (req, res, next) => {
    try {
        const userId = req.user.userId;

        await Notification.updateMany(
            { userId, isRead: false },
            { isRead: true }
        );

        console.log(`[API] ${req.method} ${req.originalUrl} - Mark all as read success (User: ${userId})`);
        res.status(200).json({
            status: 'success',
            message: 'Đã đánh dấu tất cả là đã đọc'
        });
    } catch (error) {
        next(error);
    }
};
