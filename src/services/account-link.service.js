'use strict';

const User = require('../models/user.model');
const Notification = require('../models/notification.model');

class AccountLinkError extends Error {
    constructor(message, statusCode = 400, code = 'ACCOUNT_LINK_FAILED') {
        super(message);
        this.name = 'AccountLinkError';
        this.statusCode = statusCode;
        this.appCode = code;
    }
}

function normalizeGoogleProfile(firebaseUser) {
    const uid = String(firebaseUser?.uid || '').trim();
    if (!uid) {
        throw new AccountLinkError(
            'Không tìm thấy Firebase UID để đồng bộ tài khoản Google.',
            400,
            'MISSING_FIREBASE_UID'
        );
    }

    return {
        uid,
        email: String(firebaseUser.email || '').trim().toLowerCase() || undefined,
        displayName: String(firebaseUser.displayName || firebaseUser.name || '').trim() || 'Cư dân 1MTS',
        avatar: String(firebaseUser.photoURL || firebaseUser.picture || firebaseUser.avatar || '').trim()
    };
}

function sameId(left, right) {
    return String(left || '') === String(right || '');
}

async function assertEmailAvailable(UserModel, email, currentUserId) {
    if (!email) return;

    const owner = await UserModel.findOne({ email });
    if (owner && !sameId(owner._id, currentUserId)) {
        throw new AccountLinkError(
            'Email Google này đã thuộc một tài khoản 1MTS khác. Dữ liệu tài khoản Khách vẫn được giữ nguyên.',
            409,
            'GOOGLE_EMAIL_ALREADY_USED'
        );
    }
}

async function promoteGuestUser({ user, firebaseUser, UserModel = User }) {
    if (!user) {
        throw new AccountLinkError(
            'Không tìm thấy tài khoản cần liên kết.',
            404,
            'ACCOUNT_NOT_FOUND'
        );
    }

    const profile = normalizeGoogleProfile(firebaseUser);
    if (!sameId(user.providerId, profile.uid)) {
        throw new AccountLinkError(
            'Tài khoản Firebase không khớp với tài khoản Khách hiện tại.',
            403,
            'FIREBASE_UID_MISMATCH'
        );
    }

    if (!['guest', 'google'].includes(user.loginType)) {
        throw new AccountLinkError(
            'Trạng thái tài khoản hiện tại không hỗ trợ liên kết Google.',
            409,
            'INVALID_ACCOUNT_STATE'
        );
    }

    await assertEmailAvailable(UserModel, profile.email, user._id);

    const wasGuest = user.loginType === 'guest';
    user.email = profile.email;
    user.loginType = 'google';
    
    // Chỉ ghi đè nếu tài khoản Khách vẫn đang dùng tên mặc định và chưa chọn Avatar
    if (wasGuest) {
        if (user.displayName === 'Cư dân 1MTS') user.displayName = profile.displayName;
        if (!user.avatar || user.avatar.startsWith('http')) user.avatar = profile.avatar;
    } else if (!user.displayName) {
        user.displayName = profile.displayName;
    }
    
    // Firebase linkWithCredential giữ nguyên UID. Gán lại rõ ràng để dữ liệu
    // Mongo luôn phản ánh đúng identity đã được Firebase xác minh.
    user.providerId = profile.uid;
    await user.save();

    return { user, promoted: wasGuest };
}

async function syncGoogleLogin({
    firebaseUser,
    UserModel = User,
    NotificationModel = Notification
}) {
    const profile = normalizeGoogleProfile(firebaseUser);
    let user = await UserModel.findOne({ providerId: profile.uid });

    if (user) {
        const result = await promoteGuestUser({ user, firebaseUser: profile, UserModel });
        return { user: result.user, isNewUser: false, promoted: result.promoted };
    }

    await assertEmailAvailable(UserModel, profile.email, null);
    user = await UserModel.create({
        email: profile.email,
        displayName: profile.displayName,
        avatar: profile.avatar,
        loginType: 'google',
        providerId: profile.uid
    });

    await NotificationModel.create({
        userId: user._id,
        title: 'Chào mừng thành viên mới! 🎉',
        message: `Chào mừng cư dân ${user.displayName} đã đến với hành trình sinh tồn - 1MTS`,
        type: 'SYSTEM'
    });

    return { user, isNewUser: true, promoted: false };
}

module.exports = {
    AccountLinkError,
    normalizeGoogleProfile,
    promoteGuestUser,
    syncGoogleLogin
};
