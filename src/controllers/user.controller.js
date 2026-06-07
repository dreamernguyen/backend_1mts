const User = require('../models/user.model');
const Recipe = require('../models/recipe.model');

// Get current user profile (includes savedRecipes and shoppingList)
exports.getProfile = async (req, res, next) => {
    try {
        const userId = req.user.userId;
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng' });
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

        const recipes = await Recipe.find({ recipeId: { $in: user.savedRecipes } }).select('-embeddingVector');

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
        const { itemText, action } = req.body; // action: 'add' hoặc 'remove'

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
