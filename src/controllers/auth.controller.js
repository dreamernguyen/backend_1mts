const User = require('../models/user.model');
const Item = require('../models/item.model');
const Transaction = require('../models/transaction.model');
const Notification = require('../models/notification.model');
const { admin } = require('../config/firebase.config'); // Firebase Admin SDK
const { asyncHandler } = require('../middleware/errorHandler.middleware');

// Sync Google auth với MongoDB
exports.loginWithGoogle = asyncHandler(async (req, res) => {
    const { idToken } = req.body; 

    // Xác thực token bằng Firebase
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    
    // Đảm bảo token gửi lên đúng là của Google
    if (decodedToken.firebase.sign_in_provider !== 'google.com') {
        return res.status(400).json({ success: false, message: 'Định dạng đăng nhập không hợp lệ!' });
    }

    const { uid: firebaseUid, email, name, picture } = decodedToken;

    // get or create user
    let user = await User.findOne({ loginType: 'google', providerId: firebaseUid });
    const isNewUser = !user;

    if (isNewUser) {
        user = await User.create({
            email, displayName: name, avatar: picture,
            loginType: 'google', providerId: firebaseUid
        });

        // Gửi thông báo chào mừng
        await Notification.create({
            userId: user._id,
            title: 'Chào mừng thành viên mới! 🎉',
            message: `Chào mừng cư dân ${user.displayName} đã đến với hành trình sinh tồn - 1MTS`,
            type: 'SYSTEM'
        });
    }

    console.log(`[API] ${req.method} ${req.originalUrl} - Success (User: ${user._id})`);
    return res.status(200).json({
        success: true,
        message: isNewUser ? 'Khởi tạo tài khoản Google thành công!' : 'Chào mừng trở lại!',
        user // Trả về user info, auth token do Firebase quản lý
    });
});

// Login dưới dạng Khách (Guest)
exports.loginAsGuest = asyncHandler(async (req, res) => {
    // verify idToken từ Firebase Anonymous Auth
    const { idToken, deviceName } = req.body; 

    // Xác thực token bằng Firebase
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    
    if (decodedToken.firebase.sign_in_provider !== 'anonymous') {
        return res.status(400).json({ success: false, message: 'Chỉ chấp nhận đăng nhập khách!' });
    }

    const firebaseUid = decodedToken.uid;

    let user = await User.findOne({ loginType: 'guest', providerId: firebaseUid });
    const isNewGuest = !user;

    if (isNewGuest) {
        user = await User.create({
            displayName: 'Cư dân 1MTS',
            loginType: 'guest',
            providerId: firebaseUid
        });

        // Gửi thông báo chào mừng
        await Notification.create({
            userId: user._id,
            title: 'Chào mừng thành viên mới! 🎉',
            message: `Chào mừng cư dân ${user.displayName} đã đến với hành trình sinh tồn - 1MTS`,
            type: 'SYSTEM'
        });
    }

    console.log(`[API] ${req.method} ${req.originalUrl} - Success (Guest: ${user._id})`);
    return res.status(200).json({
        success: true,
        message: isNewGuest ? 'Khởi tạo tài khoản Khách thành công!' : 'Đồng bộ và khôi phục dữ liệu Khách thành công!',
        user
    });
});

// Cập nhật thông tin DB sau khi Firebase linkCredential Google
exports.linkGoogleAccount = asyncHandler(async (req, res) => {
    // middleware đã verify idToken mới và gán req.user.firebaseUid
    
    const { guestUserId } = req.body;

    // Kiểm tra tính sở hữu
    if (req.user.userId.toString() !== guestUserId.toString()) {
        return res.status(403).json({
            success: false,
            message: 'Bạn không có quyền cập nhật tài khoản này!'
        });
    }

    // Lấy lại thông tin từ token vừa được middleware xác thực
    const firebaseUser = await admin.auth().getUser(req.user.firebaseUid);
    
    // Kiểm tra xem provider có thực sự đã link với Google chưa
    const hasGoogleLink = firebaseUser.providerData.some(p => p.providerId === 'google.com');
    if (!hasGoogleLink) {
         return res.status(400).json({ success: false, message: 'Chưa liên kết Google thành công trên Firebase!' });
    }

    // Tìm tài khoản Khách trong MongoDB
    const guestUser = await User.findById(guestUserId);
    if (!guestUser || guestUser.loginType !== 'guest') {
        return res.status(404).json({ success: false, message: 'Không tìm thấy tài khoản Khách hợp lệ!' });
    }

    // update thông tin sang google, giữ nguyên _id
    guestUser.email = firebaseUser.email;
    guestUser.displayName = firebaseUser.displayName;
    guestUser.avatar = firebaseUser.photoURL;
    guestUser.loginType = 'google';
    await guestUser.save();

    console.log(`[API] ${req.method} ${req.originalUrl} - Linked Google (User: ${guestUserId})`);
    return res.status(200).json({
        success: true,
        message: 'Cập nhật tài khoản sang Google thành công! Toàn bộ dữ liệu được giữ nguyên.',
        user: guestUser
    });
});

// Xóa tài khoản vĩnh viễn
exports.deleteAccountData = asyncHandler(async (req, res) => {
    const { userId } = req.body;

    if (req.user.userId.toString() !== userId.toString()) {
        return res.status(403).json({
            success: false,
            message: 'Bạn không có quyền xóa dữ liệu của tài khoản khác!'
        });
    }

    // 1. Xóa toàn bộ vật phẩm và lịch sử giao dịch trong MongoDB
    await Item.deleteMany({ userId });         
    await Transaction.deleteMany({ userId }); 

    const user = await User.findById(userId);
    
    if (user) {
        // 2. Xóa user trên Firebase Authentication
        try {
            await admin.auth().deleteUser(user.providerId);
        } catch (error) {
            console.error('Lỗi khi xóa trên Firebase:', error);
            // Vẫn tiếp tục xóa dưới DB dù Firebase có lỗi
        }

        // 3. Xóa luôn thực thể User nếu là Khách
        if (user.loginType === 'guest') {
            await User.findByIdAndDelete(userId);
        }
    }

    console.log(`[API] ${req.method} ${req.originalUrl} - Deleted Account (User: ${userId})`);
    return res.status(200).json({
        success: true,
        message: 'Đã xóa vĩnh viễn toàn bộ dữ liệu tài khoản!'
    });
});