const User = require('../models/user.model');
const PantryItem = require('../models/pantry.model');
const Receipt = require('../models/receipt.model');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');

// Khởi tạo Google OAuth2 Client để tự giải mã chữ ký Token ở Server Node.js
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

/**
 * NGHIỆP VỤ 1: ĐĂNG NHẬP BẰNG GOOGLE (Web / Android)
 */
exports.loginWithGoogle = async (req, res) => {
    try {
        const { idToken } = req.body;

        if (!idToken) {
            return res.status(400).json({
                success: false,
                message: "Tham số idToken từ Google không được để trống!"
            });
        }

        // 1. Xác thực ID Token trực tiếp với Google API
        const ticket = await googleClient.verifyIdToken({
            idToken: idToken,
            audience: process.env.GOOGLE_CLIENT_ID 
        });
        
        const payload = ticket.getPayload();
        const { sub: googleId, email, name, picture } = payload;

        // 2. Tra cứu tài khoản Google trong Database
        let user = await User.findOne({ loginType: 'google', providerId: googleId });

        let isNewUser = false;
        if (!user) {
            user = await User.create({
                email: email,
                displayName: name,
                avatar: picture,
                loginType: 'google',
                providerId: googleId
            });
            isNewUser = true;
        }

        // 3. Khởi tạo Token JWT nội bộ của 1MTS
        const sessionToken = jwt.sign(
            { userId: user._id, loginType: user.loginType },
            process.env.JWT_SECRET,
            { expiresIn: '30d' }
        );

        return res.status(200).json({
            success: true,
            message: isNewUser ? "Khởi tạo tài khoản cư dân 1MTS qua Google thành công!" : "Chào mừng trở lại cư dân 1MTS!",
            token: sessionToken,
            user
        });

    } catch (error) {
        console.error(`[Auth Error - Google]: ${error.message}`);
        return res.status(401).json({
            success: false,
            message: "Mã xác thực Google không hợp lệ hoặc đã hết hạn!",
            error: error.message
        });
    }
};

/**
 * NGHIỆP VỤ 2: ĐĂNG NHẬP CHẾ ĐỘ KHÁCH (GUEST)
 */
exports.loginAsGuest = async (req, res) => {
    try {
        const { deviceId, deviceName } = req.body;

        if (!deviceId) {
            return res.status(400).json({
                success: false,
                message: "Mã định danh thiết bị deviceId là bắt buộc ở chế độ Guest!"
            });
        }

        let user = await User.findOne({ loginType: 'guest', providerId: deviceId });

        let isNewGuest = false;
        if (!user) {
            user = await User.create({
                displayName: deviceName ? `Khách (${deviceName})` : "Khách 1MTS",
                loginType: 'guest',
                providerId: deviceId
            });
            isNewGuest = true;
        }

        const sessionToken = jwt.sign(
            { userId: user._id, loginType: 'guest' },
            process.env.JWT_SECRET,
            { expiresIn: '365d' }
        );

        return res.status(200).json({
            success: true,
            message: isNewGuest ? "Khởi tạo tài khoản Khách thành công!" : "Đồng bộ và khôi phục dữ liệu tài khoản Khách thành công!",
            token: sessionToken,
            user
        });

    } catch (error) {
        console.error(`[Auth Error - Guest]: ${error.message}`);
        return res.status(500).json({
            success: false,
            message: "Lỗi hệ thống xử lý đăng nhập Khách!",
            error: error.message
        });
    }
};

/**
 * NGHIỆP VỤ NÂNG CAO 3: LIÊN KẾT TÀI KHOẢN KHÁCH SANG GOOGLE (ACCOUNT LINKING - RESOLVING CONFLICTS)
 * Giúp người dùng chuyển đổi tài khoản Khách lên Google mà không mất tủ lạnh cũ.
 * Xử lý thông minh trường hợp tài khoản Google đích đã tồn tại trên hệ thống.
 */
exports.linkGoogleAccount = async (req, res) => {
    try {
        const { idToken, guestUserId, confirmOverwrite } = req.body;

        if (!idToken || !guestUserId) {
            return res.status(400).json({
                success: false,
                message: "Cần cung cấp đầy đủ idToken của Google và guestUserId hiện tại!"
            });
        }

        // 1. Xác thực Google Token truyền lên từ Client
        const ticket = await googleClient.verifyIdToken({
            idToken: idToken,
            audience: process.env.GOOGLE_CLIENT_ID 
        });
        
        const payload = ticket.getPayload();
        const { sub: googleId, email, name, picture } = payload;

        // 2. Tìm kiếm xem tài khoản Google này đã từng tồn tại chưa
        const existingGoogleUser = await User.findOne({ loginType: 'google', providerId: googleId });
        
        if (existingGoogleUser) {
            // TRƯỜNG HỢP PHÁT SINH XUNG ĐỘT (Conflict): Tài khoản Google đã có dữ liệu từ trước
            if (confirmOverwrite === true) {
                // LỰA CHỌN 1: Người dùng chấp nhận Ghi đè (Xóa dữ liệu cũ của Google, giữ dữ liệu Khách hiện tại)
                console.log(`[Account Linking] Tiến hành dọn dẹp dữ liệu cũ của tài khoản Google: ${existingGoogleUser._id}`);
                
                // Xóa tủ lạnh và hóa đơn gắn liền với tài khoản Google cũ để giải phóng tài nguyên
                await PantryItem.deleteMany({ userId: existingGoogleUser._id });
                await Receipt.deleteMany({ userId: existingGoogleUser._id });
                
                // Xóa thực thể User Google cũ
                await User.findByIdAndDelete(existingGoogleUser._id);
            } else {
                // Nếu chưa xác nhận ghi đè, trả về mã lỗi 409 Conflict kèm chỉ dẫn cho Flutter hiển thị Popup lựa chọn
                return res.status(409).json({
                    success: false,
                    code: "GOOGLE_ACCOUNT_ALREADY_EXISTS",
                    message: "Tài khoản Google này đã được sử dụng và có dữ liệu kho lương riêng trên hệ thống!",
                    suggestion: "Vui lòng lựa chọn: Ghi đè dữ liệu cũ, hoặc Thoát tài khoản khách để đăng nhập trực tiếp bằng Google."
                });
            }
        }

        // 3. Tìm tài khoản Khách hiện tại đang dùng trên điện thoại
        const guestUser = await User.findById(guestUserId);
        if (!guestUser || guestUser.loginType !== 'guest') {
            return res.status(404).json({
                success: false,
                message: "Không tìm thấy thông tin tài khoản Khách hợp lệ cần liên kết!"
            });
        }

        // 4. TIẾN HÀNH CHUYỂN ĐỔI (UPGRADE):
        // Giữ nguyên ID gốc của tài khoản khách để toàn bộ PantryItems và Receipts không bị mồ côi
        guestUser.email = email;
        guestUser.displayName = name;
        guestUser.avatar = picture;
        guestUser.loginType = 'google';
        guestUser.providerId = googleId; // Thay thế mã thiết bị bằng ID Google

        await guestUser.save();

        // 5. Cấp lại Token JWT mới với quyền hạn tài khoản Google
        const sessionToken = jwt.sign(
            { userId: guestUser._id, loginType: 'google' },
            process.env.JWT_SECRET,
            { expiresIn: '30d' }
        );

        return res.status(200).json({
            success: true,
            message: "Nâng cấp và đồng bộ tài khoản Google thành công! Toàn bộ kho thực phẩm của bạn đã được liên kết an toàn.",
            token: sessionToken,
            user: guestUser
        });

    } catch (error) {
        console.error(`[Link Auth Error]: ${error.message}`);
        return res.status(500).json({
            success: false,
            message: "Lỗi hệ thống trong quá trình xử lý liên kết tài khoản!",
            error: error.message
        });
    }
};

/**
 * NGHIỆP VỤ NÂNG CAO 4: XÓA SẠCH DỮ LIỆU TÀI KHOẢN (DATA CLEAR / RESET)
 */
exports.deleteAccountData = async (req, res) => {
    try {
        const { userId } = req.body;

        if (!userId) {
            return res.status(400).json({ success: false, message: "Tham số userId là bắt buộc để dọn dẹp dữ liệu!" });
        }

        // 1. Xóa toàn bộ thực phẩm lưu trữ trong tủ lạnh của User này
        await PantryItem.deleteMany({ userId: userId });

        // 2. Xóa toàn bộ lịch sử hóa đơn mua hàng của User này
        await Receipt.deleteMany({ userId: userId });

        // 3. Xóa luôn thực thể người dùng khỏi database (Nếu là Guest)
        const user = await User.findById(userId);
        if (user && user.loginType === 'guest') {
            await User.findByIdAndDelete(userId);
        }

        return res.status(200).json({
            success: true,
            message: "Đã xóa vĩnh viễn toàn bộ kho thực phẩm, lịch sử hóa đơn và thông tin tài khoản của bạn!"
        });

    } catch (error) {
        console.error(`[Delete Account Error]: ${error.message}`);
        return res.status(500).json({
            success: false,
            message: "Lỗi hệ thống khi dọn dẹp dữ liệu tài khoản!",
            error: error.message
        });
    }
};