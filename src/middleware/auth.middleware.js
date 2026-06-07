const { admin } = require('../config/firebase.config');
const User = require('../models/user.model');

// Kiểm tra Firebase ID Token trong Header trước khi vào controller.
const verifyToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;

    // Kiểm tra header có tồn tại và đúng định dạng "Bearer ..."
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
            success: false,
            message: 'Bạn chưa đăng nhập! Vui lòng cung cấp token hợp lệ.'
        });
    }

    const token = authHeader.split(' ')[1];

    try {
        // Dùng Firebase Admin để giải mã token
        const decodedToken = await admin.auth().verifyIdToken(token);
        
        // Tìm user trong DB dựa vào uid của Firebase
        const user = await User.findOne({ providerId: decodedToken.uid });
        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Tài khoản chưa được đồng bộ với hệ thống. Vui lòng đăng nhập lại.'
            });
        }

        // Gắn thông tin vào request y hệt như JWT cũ để không làm hỏng các file khác
        req.user = {
            userId: user._id,
            loginType: user.loginType,
            firebaseUid: decodedToken.uid // Gắn thêm nếu cần dùng sau này
        };
        next();
    } catch (error) {
        // firebase-admin tự throw lỗi nếu token hết hạn hoặc giả mạo
        return res.status(401).json({
            success: false,
            message: 'Token hết hạn hoặc không hợp lệ. Vui lòng đăng nhập lại!'
        });
    }
};

// Đảm bảo user chỉ truy cập dữ liệu của chính mình. Phải đặt SAU verifyToken.
const checkOwnership = (req, res, next) => {
    // Ưu tiên lấy userId từ params, fallback sang body
    const resourceUserId = req.params.userId || req.body.userId;

    // Nếu route không có userId thì bỏ qua bước kiểm tra này
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
