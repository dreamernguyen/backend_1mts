const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const Recipe = require('../models/recipe.model');
const Item = require('../models/item.model');
const geminiService = require('../services/gemini.service');
const inventoryService = require('../services/inventory.service');

// Tìm kiếm công thức (Search / Vector Search)
exports.searchRecipes = asyncHandler(async (req, res) => {
    const { query, mealType, maxPrice, limit = 20, page = 1 } = req.query;

    let recipes = [];
    let total = 0;
    const skip = (Number(page) - 1) * Number(limit);

    if (query && query.trim() !== '') {
        // tạo vector từ query
        const queryVector = await geminiService.embedText(query);
        
        // set filter cho vector search
        let prefilter = {};
        if (mealType) prefilter.mealType = { $eq: mealType };
        if (maxPrice) prefilter.estimatedCost = { $lte: Number(maxPrice) };

        const pipeline = [
            {
                $vectorSearch: {
                    index: 'vector_index',
                    path: 'embeddingVector',
                    queryVector: queryVector,
                    numCandidates: 100, // MongoDB yêu cầu số candidates >= limit
                    limit: 100
                }
            },
            ...(Object.keys(prefilter).length > 0 ? [{ $match: prefilter }] : []),
            { $skip: skip },
            { $limit: Number(limit) },
            { $project: { embeddingVector: 0 } }
        ];

        recipes = await Recipe.aggregate(pipeline);
        total = recipes.length; // Vector search không lấy đc total count dễ dàng
    } else {
        let filter = {};
        if (mealType) filter.mealType = mealType;
        if (maxPrice) filter.estimatedCost = { $lte: Number(maxPrice) };

        recipes = await Recipe.find(filter)
            .select('-embeddingVector')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(Number(limit));
            
        total = await Recipe.countDocuments(filter);
    }

    console.log(`[API] ${req.method} ${req.originalUrl} - Search recipes success (Query: ${query}, Found: ${recipes.length})`);
    res.status(200).json({
        success: true,
        count: recipes.length,
        total: query ? recipes.length : total,
        data: recipes
    });
});

// Xem chi tiết công thức & Phân tích nguyên liệu thiếu (AI)
exports.getRecipeDetails = asyncHandler(async (req, res) => {
    const recipeId = req.params.id;
    const userId = req.user.userId;

    const recipe = await Recipe.findOne({ recipeId: recipeId }).select('-embeddingVector');
    if (!recipe) {
        return res.status(404).json({ success: false, message: 'Không tìm thấy công thức' });
    }

    // Lấy tủ lạnh của User
    const fridgeItems = await Item.find({ userId: userId, usageStatus: 'ACTIVE' });

    // Gọi AI phân tích nguyên liệu thiếu
    let missingAnalysis = { missingCore: [], missingExtra: [] };
    let aiError = null;
    
    try {
        missingAnalysis = await geminiService.analyzeMissingIngredients(recipe, fridgeItems);
    } catch (error) {
        console.error("AI Analysis failed:", error.message);
        aiError = error.message;
    }

    // Trả về data, kể cả khi AI fail thì vẫn có công thức
    console.log(`[API] ${req.method} ${req.originalUrl} - Get recipe detail success (User: ${userId}, Recipe: ${recipeId})`);
    res.status(200).json({
        success: true,
        data: {
            recipe: recipe,
            missingAnalysis: missingAnalysis,
            aiFailed: !!aiError
        }
    });
});

// Đề xuất "Hôm nay ăn gì" bằng AI Bếp trưởng
exports.suggestTodayRecipe = asyncHandler(async (req, res) => {
    const userId = req.user.userId;

    // 1. tạo báo cáo tủ lạnh
    const inventoryReport = await inventoryService.generateInventoryReport(userId);

    // 2. Tủ trống -> trả về công thức random để đi chợ
    if (inventoryReport.isEmpty || inventoryReport.onlySpices) {
        // random vài món
        const randomRecipes = await Recipe.aggregate([
            { $sample: { size: 5 } },
            { $project: { embeddingVector: 0 } }
        ]);
        return res.status(200).json({
            success: true,
            data: {
                type: 'NEED_SHOPPING',
                reasoning: 'Tủ lạnh của bạn trống trơn hoặc chỉ còn mắm muối gia vị. Hãy xách giỏ đi siêu thị nhé! Dưới đây là vài gợi ý đi chợ.',
                recipeId: null,
                suggestedRecipesToBuy: randomRecipes
            }
        });
    }

    // 3. Truyền báo cáo cho AI xử lý
    const suggestion = await geminiService.consultHeadChefAI(inventoryReport);

    // 4. Lưu món ăn AI chế vào DB
    if (suggestion && suggestion.customRecipe) {
        const custom = suggestion.customRecipe;
        const existing = await Recipe.findOne({ title: custom.title });
        
        if (existing) {
            suggestion.recipeId = existing.recipeId;
        } else {
            const newRecipeId = 'ai_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
            
            const newRecipe = new Recipe({
                recipeId: newRecipeId,
                title: custom.title,
                description: 'Công thức được sinh ra từ Bếp trưởng AI để dọn tủ lạnh.',
                mealType: custom.mealType || 'LUNCH',
                difficulty: custom.difficulty || 'MEDIUM',
                prepTime: custom.prepTime || 10,
                cookTime: custom.cookTime || 15,
                servings: custom.servings || 1,
                nutrition: custom.nutrition || { calories: 0, protein: 0, carbs: 0, fat: 0 },
                ingredients: custom.ingredients || [],
                steps: custom.steps || [],
                sourceUrl: '',
                imageUrl: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c',
                tags: ['AI_CHEF', 'HYBRID'],
                mealComponentType: 'MAIN_COURSE'
            });

            await newRecipe.save();
            suggestion.recipeId = newRecipeId;
        }
        
        delete suggestion.customRecipe;
    }

    console.log(`[API] ${req.method} ${req.originalUrl} - Suggest recipe success (User: ${userId})`);
    res.status(200).json({
        success: true,
        data: suggestion
    });
});

// Lấy món ăn ngẫu nhiên và món đề xuất từ tủ lạnh
exports.getRecommendations = asyncHandler(async (req, res) => {
    const userId = req.user.userId;

    // 1. Món ăn đề xuất (Dựa vào tủ lạnh)
    const fridgeItems = await Item.find({ userId: userId, usageStatus: 'ACTIVE' })
        .sort({ expiryDate: 1 });
    
    let suggestedRecipes = [];
    if (fridgeItems.length > 0) {
        // Lọc các nguyên liệu cốt lõi (không phải gia vị)
        const coreFridgeItems = fridgeItems.filter(i => i.category !== 'SPICE').map(i => i.itemName.toLowerCase());
        
        const expiringNames = fridgeItems.slice(0, 10).map(i => i.itemName).join(' ');
        const recipes = await Recipe.find({ $text: { $search: expiringNames } })
            .select('-embeddingVector')
            .limit(30)
            .lean();

        // Tính % tương thích cho mỗi recipe
        suggestedRecipes = recipes.map(recipe => {
            if (!recipe.ingredients || recipe.ingredients.length === 0) {
                recipe.matchPercentage = 0;
                return recipe;
            }
            
            const coreRecipeIngredients = recipe.ingredients.filter(ing => ing.isCore);
            if (coreRecipeIngredients.length === 0) {
                recipe.matchPercentage = 100;
                return recipe;
            }

            const ignoreWords = ['thịt', 'trái', 'quả', 'củ', 'con', 'gói', 'túi', 'hộp', 'chai', 'lọ', 'thùng', 'kg', 'gam', 'ml', 'lít', 'khay', 'miếng', 'cái', 'lạng', 'mớ', 'nhánh', 'cây', 'bó', 'chút', 'ít'];

            let matchCount = 0;
            coreRecipeIngredients.forEach(ing => {
                const ingName = ing.itemName.toLowerCase();
                const ingWords = ingName.split(/[\s,]+/).filter(w => w.length > 1 && !ignoreWords.includes(w));

                // Kiểm tra xem tủ lạnh có chứa từ khóa của nguyên liệu không
                const isMatched = coreFridgeItems.some(fridgeItem => {
                    if (fridgeItem.includes(ingName) || ingName.includes(fridgeItem)) return true;
                    // Chéo từ khóa (VD: Má đùi gà <-> gà mái ta)
                    const fridgeWords = fridgeItem.split(/[\s,]+/).filter(w => w.length > 1 && !ignoreWords.includes(w));
                    return ingWords.some(w => fridgeWords.includes(w));
                });
                
                if (isMatched) matchCount++;
            });

            recipe.matchPercentage = Math.round((matchCount / coreRecipeIngredients.length) * 100);
            return recipe;
        }).filter(r => r.matchPercentage > 0);

        // Sắp xếp lại theo độ tương thích
        suggestedRecipes.sort((a, b) => b.matchPercentage - a.matchPercentage);
    }

    // Không fallback suggestedRecipes bằng random. Nếu không có đồ khớp, trả về mảng rỗng.

    // Lấy ID các món đã đề xuất để loại trừ khỏi phần Món ăn bạn có thể thích (Random)
    const suggestedIds = suggestedRecipes.map(r => r._id);

    // 2. Món ăn bạn có thể thích (Random)
    const randomRecipes = await Recipe.aggregate([
        { $match: { _id: { $nin: suggestedIds } } },
        { $sample: { size: 10 } },
        { $project: { embeddingVector: 0 } }
    ]);

    console.log(`[API] ${req.method} ${req.originalUrl} - Get recommendations success (User: ${userId}, Suggested: ${suggestedRecipes.length})`);
    res.status(200).json({
        success: true,
        data: {
            random: randomRecipes,
            suggested: suggestedRecipes
        }
    });
});

// Nhờ AI tìm và tạo công thức mới (Khi DB k có)
exports.aiSearchRecipe = asyncHandler(async (req, res) => {
    const { query } = req.body;
    if (!query) return res.status(400).json({ success: false, message: 'Thiếu query tìm kiếm' });

    const prompt = `
Bạn là một Đầu bếp chuẩn sao Michelin. Người dùng đang muốn tìm công thức cho món: "${query}".
Hãy viết một công thức chi tiết chuẩn xác cho món này. Trả về dưới định dạng JSON sau:
{
    "title": "Tên món",
    "description": "Mô tả hấp dẫn",
    "mealType": "LUNCH", // BREAKFAST, LUNCH, DINNER, SNACK
    "difficulty": "MEDIUM", // EASY, MEDIUM, HARD
    "prepTime": 15,
    "cookTime": 30,
    "servings": 2, // Mặc định nấu cho 1-2 bữa
    "nutrition": { "calories": 500, "protein": 30, "carbs": 40, "fat": 20 },
    "ingredients": [
        { "itemName": "Tên nguyên liệu", "amount": 100, "unit": "G", "displayQuantity": "100g", "isCore": true }
    ],
    "steps": [
        { "order": 1, "instruction": "Bước 1" }
    ]
}
Trả về CHỈ JSON, không giải thích thêm.
`;
    let result;
    try {
        const genAI = new require('@google/generative-ai').GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
        const fallbackModels = ['gemini-3.5-flash', 'gemini-2.5-flash'];
        let res;
        for (const modelName of fallbackModels) {
            try {
                const model = genAI.getGenerativeModel({ model: modelName });
                res = await model.generateContent(prompt);
                break;
            } catch (err) {
                console.error(`[AI Fallback Search] Lỗi model ${modelName}:`, err.message);
                if (err.message.includes('429') || err.message.includes('quota') || err.message.toLowerCase().includes('too many requests')) {
                    throw new Error("Gói dùng Free nên AI hạn chế request vui lòng thử lại sau");
                }
            }
        }
        if (!res) throw new Error('Hệ thống AI không phản hồi. Vui lòng thử lại sau.');
        
        const responseText = res.response.text().replace(/```json/gi, '').replace(/```/g, '').trim();
        result = JSON.parse(responseText);
    } catch (error) {
        console.error("Error in aiSearchRecipe:", error);
        throw new Error(error.message || "Lỗi khi gọi AI tạo công thức");
    }

    const newRecipeId = 'ai_search_' + Date.now().toString(36);
    const newRecipe = new Recipe({
        recipeId: newRecipeId,
        title: result.title || query,
        description: result.description || 'Sưu tầm bởi AI',
        mealType: result.mealType || 'LUNCH',
        difficulty: result.difficulty || 'MEDIUM',
        prepTime: result.prepTime || 15,
        cookTime: result.cookTime || 20,
        servings: result.servings || 1,
        nutrition: result.nutrition,
        ingredients: result.ingredients || [],
        steps: result.steps || [],
        imageUrl: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c',
        tags: ['AI_COLLECTED']
    });

    await newRecipe.save();

    console.log(`[API] ${req.method} ${req.originalUrl} - AI search recipe success (Query: ${query})`);
    res.status(200).json({
        success: true,
        data: newRecipe
    });
});

// Hoàn tất nấu ăn, trừ kho đồ sống, thêm đồ chín
exports.cookRecipe = asyncHandler(async (req, res) => {
    const userId = req.user.userId;
    const { recipeId, cookedServings } = req.body;

    const recipe = await Recipe.findOne({ recipeId });
    if (!recipe) return res.status(404).json({ success: false, message: 'Không tìm thấy công thức' });

    const scale = cookedServings / (recipe.servings || 1);

    // 1. Trừ kho đồ sống
    for (const ing of recipe.ingredients) {
        if (!ing.isCore) continue; // skip gia vị lặt vặt
        const requiredAmount = ing.amount * scale;

        // Tìm item trong tủ lạnh khớp tên
        const items = await Item.find({ 
            userId: userId, 
            usageStatus: 'ACTIVE',
            itemName: new RegExp(ing.itemName, 'i') 
        }).sort({ expiryDate: 1 });

        let remainingToDeduct = requiredAmount;
        for (const item of items) {
            if (remainingToDeduct <= 0) break;
            
            if (item.quantity >= remainingToDeduct) {
                item.quantity -= remainingToDeduct;
                if (item.quantity === 0) item.usageStatus = 'CONSUMED';
                await item.save();
                remainingToDeduct = 0;
            } else {
                remainingToDeduct -= item.quantity;
                item.quantity = 0;
                item.usageStatus = 'CONSUMED';
                await item.save();
            }
        }
    }

    // 2. Nếu cookedServings >= 1, tạo Item Đồ Chín
    if (cookedServings >= 1) { // Lấy luôn nếu nấu 1 bữa để nhắc ăn
        const expiry = new Date();
        expiry.setDate(expiry.getDate() + 3); // Mặc định đồ chín để tủ lạnh được 3 ngày

        const cookedItem = new Item({
            userId: userId,
            itemName: `[Chín] ${recipe.title}`,
            category: 'OTHER',
            subCategory: 'OTHER',
            quantity: cookedServings,
            originalQuantity: cookedServings,
            unit: 'bữa',
            standardQuantity: cookedServings,
            standardUnit: 'PIECE',
            purchasePrice: 0,
            expiryDate: expiry,
            isCookedMeal: true,
            usageStatus: 'ACTIVE'
        });
        await cookedItem.save();
    }

    console.log(`[API] ${req.method} ${req.originalUrl} - Cook recipe success (User: ${userId}, Recipe: ${recipeId})`);
    res.status(200).json({
        success: true,
        message: 'Đã nấu xong và cập nhật tủ lạnh!'
    });
});
