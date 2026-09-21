const User = require('../models/user.model');
const RpgLog = require('../models/rpgLog.model');
const Recipe = require('../models/recipe.model');
const {
    VISIBLE_RECIPE_CLAUSE,
    publicRecipeProjection
} = require('../services/recipe-catalog.service');

// Get current user profile (includes savedRecipes and shoppingList)
exports.getProfile = async (req, res, next) => {
    try {
        const userId = req.user.userId;
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng' });
        }

        // Tương thích ngược theo lần đồng bộ đầu tiên: chỉ user chưa có rpg_v2
        // mới được tính lại, không chạy migration hàng loạt trên database.
        if (user.rpgStats?.formulaVersion !== 'rpg_v3') {
            const rpgService = require('../services/rpg.service');
            const state = await rpgService.calculateUserStats(userId);
            if (state) user.rpgStats = state;
        }

        console.log(`[API] ${req.method} ${req.originalUrl} - Get profile success (User: ${userId})`);
        res.status(200).json({
            status: 'success',
            data: { user }
        });
    } catch (error) {
        next(error);
    }
};

// Lấy danh sách công thức đã lưu
exports.getSavedRecipes = async (req, res, next) => {
    try {
        const userId = req.user.userId;
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng' });
        }

        const recipes = await Recipe.find({
            $and: [
                VISIBLE_RECIPE_CLAUSE,
                { recipeId: { $in: user.savedRecipes } }
            ]
        }).select(publicRecipeProjection()).sort({ recipeId: 1 }).lean();

        console.log(`[API] ${req.method} ${req.originalUrl} - Get saved recipes success (User: ${userId})`);
        res.status(200).json({
            status: 'success',
            data: { recipes }
        });
    } catch (error) {
        next(error);
    }
};


// Save/Unsave recipe
exports.toggleSavedRecipe = async (req, res, next) => {
    try {
        const userId = req.user.userId;
        const { recipeId } = req.body;

        if (!recipeId) {
            return res.status(400).json({ success: false, message: 'Vui lòng cung cấp recipeId' });
        }

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng' });
        }

        const isSaved = user.savedRecipes.includes(recipeId);
        
        if (isSaved) {
            user.savedRecipes = user.savedRecipes.filter(id => id !== recipeId);
        } else {
            user.savedRecipes.push(recipeId);
        }

        await user.save();

        console.log(`[API] ${req.method} ${req.originalUrl} - Toggle saved recipe success (User: ${userId}, Recipe: ${recipeId})`);
        res.status(200).json({
            status: 'success',
            data: {
                isSaved: !isSaved,
                savedRecipes: user.savedRecipes
            }
        });
    } catch (error) {
        next(error);
    }
};

// Update shopping list (Add/Remove)
exports.updateShoppingList = async (req, res, next) => {
    try {
        const userId = req.user.userId;
        const { itemText, action } = req.body; // action: 'add' ho?c 'remove'

        if (!itemText) {
            return res.status(400).json({ success: false, message: 'Vui lòng cung cấp itemText' });
        }

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng' });
        }

        if (action === 'remove') {
            user.shoppingList = user.shoppingList.filter(item => item !== itemText);
        } else {
            if (!user.shoppingList.includes(itemText)) {
                user.shoppingList.push(itemText);
            }
        }

        await user.save();

        console.log(`[API] ${req.method} ${req.originalUrl} - Update shopping list success (User: ${userId})`);
        res.status(200).json({
            status: 'success',
            data: {
                shoppingList: user.shoppingList
            }
        });
    } catch (error) {
        next(error);
    }
};

// Update FCM Token for push notifications
exports.updateFcmToken = async (req, res, next) => {
    try {
        const userId = req.user.userId;
        const { fcmToken } = req.body;

        if (!fcmToken) {
            return res.status(400).json({ success: false, message: 'Vui lòng cung cấp fcmToken' });
        }

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng' });
        }

        // Thêm token nếu chưa tồn tại
        if (!user.fcmTokens) {
            user.fcmTokens = [];
        }
        if (!user.fcmTokens.includes(fcmToken)) {
            user.fcmTokens.push(fcmToken);
            await user.save();
        }

        console.log(`[API] ${req.method} ${req.originalUrl} - Update FCM token success (User: ${userId})`);
        res.status(200).json({
            status: 'success',
            message: 'Đã cập nhật fcmToken'
        });
    } catch (error) {
        next(error);
    }
};

// Cập nhật profile (Tên, Avatar)
exports.updateProfile = async (req, res, next) => {
    try {
        const userId = req.user.userId;
        const { displayName, avatar } = req.body;

        const updateData = {};
        if (displayName) updateData.displayName = displayName;
        if (avatar !== undefined) updateData.avatar = avatar;

        const user = await User.findByIdAndUpdate(userId, updateData, { new: true });
        if (!user) {
            return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng' });
        }

        console.log(`[API] ${req.method} ${req.originalUrl} - Update profile success (User: ${userId})`);
        res.status(200).json({
            status: 'success',
            data: { user }
        });
    } catch (error) {
        next(error);
    }
};

// Cập nhật Cài đặt Tài chính & Gamification
exports.updateSettings = async (req, res, next) => {
    try {
        const userId = req.user.userId;
        const { monthlyBudget, fixedBudget, essentialBudget, savingsFund, cycleStartDay } = req.body;

        const updateData = {};
        const parseNonNegative = (value, label) => {
            const parsed = Number(value);
            if (!Number.isFinite(parsed) || parsed < 0) {
                const error = new Error(`${label} phải là số không âm.`);
                error.statusCode = 400;
                throw error;
            }
            return parsed;
        };
        if (monthlyBudget !== undefined) updateData.monthlyBudget = parseNonNegative(monthlyBudget, 'Ngân sách tháng');
        if (fixedBudget !== undefined) updateData.fixedBudget = parseNonNegative(fixedBudget, 'Tiền nhà cố định');
        if (essentialBudget !== undefined) updateData.essentialBudget = parseNonNegative(essentialBudget, 'Ngân sách thiết yếu');
        if (savingsFund !== undefined) updateData.savingsFund = parseNonNegative(savingsFund, 'Quỹ tiết kiệm');
        if (cycleStartDay !== undefined) {
            const day = Number(cycleStartDay);
            if (!Number.isInteger(day) || day < 1 || day > 28) {
                const error = new Error('Ngày bắt đầu chu kỳ phải là số nguyên từ 1 đến 28.');
                error.statusCode = 400;
                throw error;
            }
            updateData.cycleStartDay = day;
        }

        const currentUser = await User.findById(userId).select('monthlyBudget essentialBudget');
        if (!currentUser) return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng' });
        const effectiveMonthly = updateData.monthlyBudget ?? currentUser.monthlyBudget;
        const effectiveEssential = updateData.essentialBudget ?? currentUser.essentialBudget;
        if (effectiveMonthly > 0 && effectiveEssential > effectiveMonthly) {
            return res.status(400).json({
                success: false,
                message: 'Ngân sách thiết yếu không được lớn hơn tổng ngân sách tháng.'
            });
        }

        let user = await User.findByIdAndUpdate(userId, updateData, { new: true, runValidators: true });
        if (!user) {
            return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng' });
        }

        // Tính toán lại các chỉ số RPG ngay lập tức
        const rpgService = require('../services/rpg.service');
        const newStats = await rpgService.calculateUserStats(userId);
        if (newStats) {
            user.rpgStats = newStats;
            if (Number(newStats.def || 0) >= 100) {
                const questService = require('../services/quest.service');
                await questService.triggerAchievement(userId, 'MAX_DEF_ACHIEVED', 1);
                user = await User.findById(userId);
            }
        }

        console.log(`[API] ${req.method} ${req.originalUrl} - Update settings success (User: ${userId})`);
        res.status(200).json({
            status: 'success',
            data: { user }
        });
    } catch (error) {
        next(error);
    }
};

// Lấy lịch sử Gamification
exports.getRpgLogs = async (req, res, next) => {
    try {
        const userId = req.user.userId;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const skip = (page - 1) * limit;
        const type = req.query.type;

        const filter = { userId };
        if (type && ['QUEST', 'TRANSACTION', 'EXPIRY', 'OTHER'].includes(type.toUpperCase())) {
            filter.type = type.toUpperCase();
        }

        const logs = await RpgLog.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit);

        const total = await RpgLog.countDocuments(filter);
        const hasMore = skip + logs.length < total;

        res.status(200).json({
            success: true,
            data: logs,
            hasMore,
            total
        });
    } catch (error) {
        next(error);
    }
};

const mongoose = require('mongoose');
const Transaction = require('../models/transaction.model');
const Item = require('../models/item.model');
const Notification = require('../models/notification.model');
const UserDailyQuest = require('../models/userDailyQuest.model');
const Meter = require('../models/meter.model');
const MeterReading = require('../models/meterReading.model');
const { admin } = require('../config/firebase.config');

// Xóa dữ liệu domain sau khi Firebase đã không còn nhận diện account.
exports.deleteMyAccount = async (req, res, next) => {
    try {
        const userId = req.user.userId;
        const user = await User.findById(userId);
        
        if (!user) {
            return res.status(404).json({ success: false, message: 'Không tìm thấy tài khoản cần xóa.' });
        }

        // Ngừng xác thực trước để account không ghi thêm dữ liệu khi đang xóa.
        try {
            await admin.auth().deleteUser(user.providerId);
        } catch (error) {
            if (error.code !== 'auth/user-not-found') {
                error.statusCode = 502;
                throw error;
            }
        }

        // Xóa atomically các collection sở hữu trực tiếp bởi user.
        const session = await mongoose.startSession();
        try {
            await session.withTransaction(async () => {
                await Item.deleteMany({ userId }).session(session);
                await Transaction.deleteMany({ userId }).session(session);
                await Notification.deleteMany({ userId }).session(session);
                await UserDailyQuest.deleteMany({ userId }).session(session);
                await MeterReading.deleteMany({ userId }).session(session);
                await Meter.deleteMany({ userId }).session(session);
                await RpgLog.deleteMany({ userId }).session(session);
                await User.deleteOne({ _id: userId }).session(session);
            });
        } finally {
            await session.endSession();
        }

        console.log(`[API] ${req.method} ${req.originalUrl} - Deleted Account (User: ${userId})`);
        return res.status(200).json({
            success: true,
            message: 'Đã xóa vĩnh viễn toàn bộ dữ liệu tài khoản!'
        });
    } catch (error) {
        next(error);
    }
};
