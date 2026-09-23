const mongoose = require('mongoose');

const rpgStatsSchema = new mongoose.Schema({
    level: { type: Number, default: 1 },
    xp: { type: Number, default: 0 },
    maxHp: { type: Number, default: 100 },
    hp: { type: Number, default: 0 },
    mana: { type: Number, default: 0 },
    def: { type: Number, default: 0 },
    wis: { type: Number, default: 50 },
    bonusWis: { type: Number, default: 0 }, // Điểm thưởng do mua sắm thông minh
    loginStreak: { type: Number, default: 0 },
    lastLoginDate: { type: Date },
    formulaVersion: { type: String, default: 'rpg_v4' },
    dataCoverage: { type: Number, default: 0, min: 0, max: 1 },
    statBreakdown: { type: mongoose.Schema.Types.Mixed, default: () => ({}) }
}, { _id: false });

const achievementSchema = new mongoose.Schema({
    questId: { type: mongoose.Schema.Types.ObjectId, ref: 'Quest' },
    unlockedAt: { type: Date, default: Date.now }
}, { _id: false });

const achievementProgressSchema = new mongoose.Schema({
    questId: { type: mongoose.Schema.Types.ObjectId, ref: 'Quest', required: true },
    progress: { type: Number, default: 0, min: 0 }
}, { _id: false });

const userSchema = new mongoose.Schema(
    {
        email: {
            type: String,
            unique: true, 
            sparse: true, // Cho phép trường này trống (null) đối với tài khoản Khách
            lowercase: true,
            trim: true
        },
        displayName: {
            type: String,
            required: [true, 'Tên hiển thị là bắt buộc'],
            trim: true,
            default: 'Cư dân 1MTS'
        },
        avatar: {
            type: String,
            default: '' 
        },
        loginType: {
            type: String,
            required: [true, 'Phải xác định phương thức đăng nhập'],
            enum: ['google', 'guest'] // Sau này cập nhật các phương thức đăng nhập khác nếu cần
        },
        providerId: {
            type: String,
            required: [true, 'Mã định danh providerId là bắt buộc'],
            unique: true, 
            trim: true
        },
        monthlyBudget: {
            type: Number,
            default: 0,
            min: 0
        },
        // Số dư khởi tạo được người dùng xác nhận, không suy ra từ ngân sách.
        finance: {
            initializedAt: { type: Date, default: null },
            openingCash: { type: Number, default: 0 },
            openingSavings: { type: Number, default: 0, min: 0 },
            revision: { type: Number, default: 0 },
            pendingCycleDay: { type: Number, default: null },
            pendingCycleAt: { type: Date, default: null },
            fixedPlans: [{
                _id: false,
                code: { type: String, enum: ['RENT', 'POWER', 'WATER', 'OTHER'] },
                amount: { type: Number, min: 0 }
            }],
            fixedCycles: [{
                _id: false,
                key: String,
                startDate: Date,
                endExclusive: Date,
                plans: [{ _id: false, code: String, amount: Number, openingPaid: { type: Number, default: 0 } }]
            }]
        },
        fixedBudget: {
            type: Number,
            default: 0,
            min: 0
        },
        savingsFund: {
            type: Number,
            default: 0,
            min: 0
        },
        essentialBudget: {
            type: Number,
            default: 0,
            min: 0
        },
        cycleStartDay: {
            type: Number,
            default: 1, // Mặc định mùng 1 hàng tháng
            min: 1,
            max: 28 // Giới hạn đến 28 để an toàn cho mọi tháng
        },
        isActive: {
            type: Boolean,
            default: true
        },
        savedRecipes: [{
            type: String
        }],
        shoppingList: [{
            type: String
        }],
        fcmTokens: [{
            type: String
        }],
        rpgStats: {
            type: rpgStatsSchema,
            default: () => ({})
        },
        achievements: [achievementSchema],
        achievementProgress: [achievementProgressSchema],
        activeTitle: {
            type: String,
            default: 'Tân Binh Sinh Tồn'
        },
        unlockedTitles: [{
            type: String
        }]
    },
    {
        timestamps: true 
    }
);

// Tạo Index tối ưu hóa tốc độ tìm kiếm tài khoản khi đăng nhập nhanh
userSchema.index({ loginType: 1, providerId: 1 });

const User = mongoose.model('User', userSchema);
module.exports = User;
