const { admin } = require('../config/firebase.config');
const User = require('../models/user.model');

// Chỉ dùng user MongoDB đã liên kết với Firebase làm danh tính nghiệp vụ.
const verifyToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
            success: false,
            message: 'Bạn chưa đăng nhập! Vui lòng cung cấp token hợp lệ.'
        });
    }

    const token = authHeader.split(' ')[1];

    try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        
        const user = await User.findOne({ providerId: decodedToken.uid });
        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Tài khoản chưa được đồng bộ với hệ thống. Vui lòng đăng nhập lại.'
            });
        }

        // Giữ contract req.user để controller không phụ thuộc Firebase SDK.
        req.user = {
            userId: user._id,
            loginType: user.loginType,
            firebaseUid: decodedToken.uid
        };
        next();
    } catch (error) {
        return res.status(401).json({
            success: false,
            message: 'Token hết hạn hoặc không hợp lệ. Vui lòng đăng nhập lại!'
        });
    }
};

// Chỉ chạy sau verifyToken vì req.user là nguồn quyền truy cập.
const checkOwnership = (req, res, next) => {
    const resourceUserId = req.params.userId || req.body.userId;

    if (!resourceUserId) return next();

    if (req.user.userId.toString() !== resourceUserId.toString()) {
        return res.status(403).json({
            success: false,
            message: 'Bạn không có quyền truy cập dữ liệu của tài khoản khác!'
        });
    }
    next();
};

module.exports = { verifyToken, checkOwnership };
