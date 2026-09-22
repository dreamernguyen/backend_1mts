const mongoose = require('mongoose');
const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const Recipe = require('../models/recipe.model');
const Item = require('../models/item.model');
const geminiService = require('../services/gemini.service');
const inventoryService = require('../services/inventory.service');
const { semanticRecipeSearch } = require('../services/recipe-retrieval.service');
const {
    VISIBLE_RECIPE_CLAUSE,
    buildRecipeFilter,
    publicRecipeProjection,
    toPublicIngredient,
    toPublicRecipe
} = require('../services/recipe-catalog.service');
const { normalizeGeneratedRecipe } = require('../services/recipe-draft-normalizer.service');
const { allocateAiRecipeId } = require('../services/recipe-id.service');
const recipeRagService = require('../services/recipe-rag.service');
const { AI_PORTION_RULES } = require('../config/recipe-portion.rules');
const aiMetricsService = require('../services/aiMetrics.service');
const {
    analyzeRecipe,
    buildTodaySuggestionReasoning,
    buildConsumptionPlan,
    calculateRemainingBatchAmounts,
    inferUpcomingMeal,
    selectTodayRecipe,
    scaleIngredientAmount,
    resolveRequestedServings,
    toBaseAmount
} = require('../services/recipe-matching.service');

function parseExcludedRecipeIds(value) {
    const values = Array.isArray(value) ? value : [value];
    return values
        .flatMap(entry => String(entry || '').split(','))
        .map(entry => entry.trim())
        .filter(Boolean)
        .slice(0, 100);
}

function decorateRecipe(recipe, analysis) {
    return {
        ...toPublicRecipe(recipe),
        matchPercentage: analysis.matchScore,
        matchScore: analysis.matchScore,
        canCook: analysis.canCook,
        ingredientCoveragePercent: analysis.ingredientCoveragePercent,
        recommendationScore: analysis.recommendationScore,
        feasibleServings: analysis.feasibleServings,
        missingCoreIngredients: analysis.missingCoreIngredients.map(toPublicIngredient),
        missingOptionalIngredients: analysis.missingOptionalIngredients.map(toPublicIngredient),
        reviewRequiredIngredients: analysis.reviewRequiredIngredients.map(toPublicIngredient),
        explanations: analysis.explanations,
        usesExpiringIngredients: analysis.usesExpiringIngredients,
        inventoryCoverage: analysis.inventoryCoverage,
        coreCoverage: analysis.coreCoverage,
        optionalCoverage: analysis.optionalCoverage,
        rescueScore: analysis.rescueScore,
        rescueBonus: analysis.rescueBonus
    };
}

async function loadInventory(userId) {
    return inventoryService.loadUsableInventorySnapshot(userId);
}

async function rankRecipesForInventory(userId, limit = 400, inventorySnapshot = null) {
    const [inventory, recipes] = await Promise.all([
        inventorySnapshot || loadInventory(userId),
        Recipe.find(VISIBLE_RECIPE_CLAUSE)
            .select(publicRecipeProjection())
            .sort({ recipeId: 1 })
            .limit(limit)
            .lean()
    ]);
    return recipes
        .map(recipe => {
            const analysis = analyzeRecipe(recipe, inventory);
            return { recipe: decorateRecipe(recipe, analysis), analysis };
        })
        .sort((a, b) =>
            Number(b.analysis.canCook) - Number(a.analysis.canCook)
            || b.analysis.matchScore - a.analysis.matchScore
            || b.analysis.rescueScore - a.analysis.rescueScore
        );
}

// Tìm kiếm recipe trong catalog. Vector chỉ lấy candidate khi index đã được bật;
// matcher xác định luôn là lớp quyết định đủ/thiếu.
exports.searchRecipes = asyncHandler(async (req, res) => {
    const { query, dishType, maxCookingTime, limit = 20, page = 1 } = req.query;
    const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);
    const safePage = Math.max(Number(page) || 1, 1);
    const skip = (safePage - 1) * safeLimit;
    let filter;
    try {
        filter = buildRecipeFilter({ query, dishType, maxCookingTime });
    } catch (error) {
        return res.status(400).json({
            success: false,
            code: error.code || 'INVALID_RECIPE_FILTER',
            message: error.message
        });
    }
    const [inventory, lexicalRecipes, lexicalTotal] = await Promise.all([
        loadInventory(req.user.userId),
        Recipe.find(filter)
            .select(publicRecipeProjection())
            .sort({ recipeId: 1 })
            .skip(skip)
            .limit(safeLimit)
            .lean(),
        Recipe.countDocuments(filter)
    ]);
    let foundRecipes = lexicalRecipes;
    let total = lexicalTotal;
    let retrieval = 'LEXICAL';
    if (foundRecipes.length === 0 && query?.trim() && safePage === 1) {
        try {
            const semanticFilter = buildRecipeFilter({ dishType, maxCookingTime });
            const semanticRecipes = await semanticRecipeSearch(
                query.trim(),
                safeLimit,
                semanticFilter
            );
            if (semanticRecipes.length > 0) {
                foundRecipes = semanticRecipes;
                total = semanticRecipes.length;
                retrieval = 'VECTOR_FALLBACK';
            }
        } catch (error) {
            // Vector/Gemini là fallback. Lexical search vẫn phải hoạt động khi
            // hết quota, thiếu index hoặc chưa bật cấu hình.
            console.warn('[Recipe vector fallback]', {
                code: error.code || 'VECTOR_SEARCH_FAILED',
                message: error.message
            });
        }
    }
    const recipes = foundRecipes.map(recipe => decorateRecipe(recipe, analyzeRecipe(recipe, inventory)));

    console.log(`[API] ${req.method} ${req.originalUrl} - Search recipes success (Query: ${query}, Found: ${recipes.length})`);
    res.status(200).json({
        success: true,
        count: recipes.length,
        total,
        retrieval,
        data: recipes
    });
});

// Xem chi tiết và phân tích bằng rule, không gọi AI cho dữ liệu đủ/thiếu.
exports.getRecipeDetails = asyncHandler(async (req, res) => {
    const recipeId = req.params.id;
    const userId = req.user.userId;

    // Detail theo ID vẫn cho phép mở AI draft vừa tạo. Catalog/search mới áp
    // VISIBLE_RECIPE_CLAUSE để draft không lẫn vào 349 recipe chính.
    const recipe = await Recipe.findOne({ recipeId })
        .select(publicRecipeProjection())
        .lean();
    if (!recipe) {
        return res.status(404).json({ success: false, message: 'Không tìm thấy công thức' });
    }

    const fridgeItems = await loadInventory(userId);
    const matchingAnalysis = analyzeRecipe(recipe, fridgeItems);
    const decoratedRecipe = decorateRecipe(recipe, matchingAnalysis);
    let selectedServings;
    let consumptionPreview = [];

    try {
        selectedServings = resolveRequestedServings(recipe, req.query.servings);
    } catch (error) {
        return res.status(400).json({
            success: false,
            code: error.code || 'INVALID_SERVINGS',
            message: error.message
        });
    }

    if (matchingAnalysis.canCook) {
        if (selectedServings > matchingAnalysis.feasibleServings) {
            return res.status(400).json({
                success: false,
                message: `Kho hiện chỉ đủ tối đa ${matchingAnalysis.feasibleServings} khẩu phần.`
            });
        }

        try {
            const preview = buildConsumptionPlan(recipe, fridgeItems, selectedServings);
            const inventoryById = new Map(fridgeItems.map(item => [String(item._id), item]));
            consumptionPreview = preview.plan.map(entry => {
                const batch = inventoryById.get(entry.batchId) || {};
                return {
                    ...entry,
                    itemName: batch.itemName || '',
                    rawName: batch.rawName || batch.itemName || '',
                    expiryDate: batch.expiryDate || null,
                    storageLocation: batch.storageLocation || null
                };
            });
        } catch (error) {
            return res.status(400).json({
                success: false,
                message: error.message,
                code: error.code || 'CONSUMPTION_PREVIEW_FAILED'
            });
        }
    }
    const detailServings = selectedServings;
    decoratedRecipe.ingredientMatches = matchingAnalysis.ingredientMatches.map(match => {
        const scaledAmount = scaleIngredientAmount(
            match.ingredient,
            detailServings,
            Number(recipe.baseServings || recipe.servings || 1)
        );
        const normalized = toBaseAmount(scaledAmount, match.ingredient.unit);
        if (!normalized) {
            return {
                ...match,
                ingredient: toPublicIngredient(match.ingredient),
                missingAmount: 0,
                availabilityStatus: match.relation === 'REVIEW_REQUIRED'
                    ? 'REVIEW_REQUIRED'
                    : match.availableAmount > 0
                        ? 'AVAILABLE'
                        : 'MISSING'
            };
        }
        return {
            ...match,
            ingredient: toPublicIngredient(match.ingredient),
            requiredAmount: normalized.amount,
            requiredUnit: normalized.unit,
            missingAmount: Math.max(Number((normalized.amount - match.availableAmount).toFixed(3)), 0),
            availabilityStatus: match.relation === 'REVIEW_REQUIRED'
                ? 'REVIEW_REQUIRED'
                : match.availableAmount <= 0
                    ? 'MISSING'
                    : match.availableAmount < normalized.amount
                        ? 'PARTIAL'
                        : 'AVAILABLE',
            quantityRatio: normalized.amount > 0
                ? Math.min(match.availableAmount / normalized.amount, 1)
                : 1
        };
    });
    const missingAnalysis = {
        // Giữ shape cũ cho Flutter hiện tại.
        missingCore: decoratedRecipe.missingCoreIngredients,
        missingExtra: decoratedRecipe.missingOptionalIngredients
    };

    // Trả về data, kể cả khi AI fail thì vẫn có công thức
    console.log(`[API] ${req.method} ${req.originalUrl} - Get recipe detail success (User: ${userId}, Recipe: ${recipeId})`);
    res.status(200).json({
        success: true,
        data: {
            recipe: decoratedRecipe,
            missingAnalysis,
            matchingAnalysis,
            selectedServings,
            consumptionPreview,
            aiFailed: false
        }
    });
});

// "Hôm nay ăn gì" dùng cùng recommendation engine; AI chỉ là fallback.
exports.suggestTodayRecipe = asyncHandler(async (req, res) => {
    const userId = req.user.userId;
    const sessionId = req.get('X-Request-Id') || `recipe-suggest-${Date.now()}`;
    const startedAt = Date.now();
    // Một snapshot duy nhất cho ranking, AI context và validation trong request này.
    const inventorySnapshot = await inventoryService.loadUsableInventorySnapshot(userId);
    const rankedRecipes = await rankRecipesForInventory(userId, 400, inventorySnapshot);
    const excludedRecipeIds = parseExcludedRecipeIds(req.query.excludeRecipeIds);
    const {
        entry: bestDatabaseMatch,
        rotationReset
    } = selectTodayRecipe(rankedRecipes, excludedRecipeIds);

    if (bestDatabaseMatch) {
        const now = new Date();
        const timeZone = process.env.APP_TIME_ZONE || 'Asia/Ho_Chi_Minh';
        const mealContext = inferUpcomingMeal(
            now,
            bestDatabaseMatch.recipe.cookingTimeMinutes,
            timeZone
        );
        // Ghi chỉ số gợi ý từ DB (không dùng AI) — fire-and-forget
        aiMetricsService.logRecipeAiResponse({
            userId, sessionId,
            latencyMs: Date.now() - startedAt,
            usedAiFallback: false,
            suggestionCount: 1
        });
        return res.status(200).json({
            success: true,
            data: {
                type: 'DATABASE_RECIPE',
                reasoning: buildTodaySuggestionReasoning(
                    bestDatabaseMatch.recipe,
                    bestDatabaseMatch.analysis,
                    { now, timeZone }
                ),
                recipeId: bestDatabaseMatch.recipe.recipeId,
                title: bestDatabaseMatch.recipe.title,
                matchScore: bestDatabaseMatch.analysis.matchScore,
                feasibleServings: bestDatabaseMatch.analysis.feasibleServings,
                suggestedMeal: mealContext.code,
                rotationReset
            }
        });
    }

    // Báo cáo chỉ chứa lô đã qua hard gate quantity và expiry.
    const inventoryReport = inventoryService.generateInventoryReportFromSnapshot(inventorySnapshot);

    // Không gọi AI khi kho trống; trả gợi ý đi chợ có thể dự đoán được.
    if (inventoryReport.isEmpty || inventoryReport.onlySpices) {
        const randomRecipes = await Recipe.aggregate([
            { $match: VISIBLE_RECIPE_CLAUSE },
            { $sample: { size: 5 } },
            { $project: publicRecipeProjection() }
        ]);
        return res.status(200).json({
            success: true,
            data: {
                type: 'NEED_SHOPPING',
                reasoning: 'Kho hiện không còn nguyên liệu an toàn có thể dùng để nấu, hoặc chỉ còn gia vị. Dưới đây là vài gợi ý đi chợ.',
                recipeId: null,
                suggestedRecipesToBuy: randomRecipes
            }
        });
    }

    // AI chỉ là fallback khi catalog không có món qua hard gate.
    const suggestion = await geminiService.consultHeadChefAI(inventoryReport);

    // Recipe AI phải qua matcher trước khi UI cho phép nấu.
    if (suggestion && suggestion.customRecipe) {
        const custom = suggestion.customRecipe;
        const normalizedCustom = normalizeGeneratedRecipe(custom, {
            description: 'Công thức được sinh ra từ Bếp trưởng AI để dọn tủ lạnh.',
            imageUrl: 'https://play-lh.googleusercontent.com/ALsQlQMDMZyDCo30-lKP4hPR6VuDz0j3LpwTXYWMpkp556MrGCVpN8sru2oM4RPIgCA',
            baseServings: 1
        });
        const existing = await Recipe.findOne({
            $and: [VISIBLE_RECIPE_CLAUSE, { title: normalizedCustom.title }]
        }).select(publicRecipeProjection()).lean();
        const newRecipeId = await allocateAiRecipeId();
        const candidateRecipe = existing || new Recipe({
                recipeId: newRecipeId,
                ...normalizedCustom,
                source: 'AI',
                dataVersion: 2
            });

        const aiAnalysis = analyzeRecipe(candidateRecipe, inventorySnapshot);
        if (aiAnalysis.canCook) {
            if (!existing) await candidateRecipe.save();
            suggestion.recipeId = existing?.recipeId || newRecipeId;
            suggestion.matchScore = aiAnalysis.matchScore;
            suggestion.feasibleServings = aiAnalysis.feasibleServings;
        } else {
            suggestion.recipeId = null;
            suggestion.type = 'NEED_SHOPPING';
            suggestion.missingCoreIngredients = aiAnalysis.missingCoreIngredients;
            suggestion.reasoning = 'Không có công thức an toàn có thể nấu từ kho hiện tại. Hãy bổ sung nguyên liệu chính hoặc loại bỏ thực phẩm đã hết hạn.';
        }
        
        delete suggestion.customRecipe;
    }

    // Ghi chỉ số gợi ý dùng AI fallback — fire-and-forget
    aiMetricsService.logRecipeAiResponse({
        userId, sessionId,
        latencyMs: Date.now() - startedAt,
        usedAiFallback: true,
        suggestionCount: suggestion?.recipeId ? 1 : 0
    });

    console.log(`[API] ${req.method} ${req.originalUrl} - Suggest recipe success (User: ${userId})`);
    res.status(200).json({
        success: true,
        data: suggestion
    });
});

// Lấy món đề xuất bằng matcher xác định và tách riêng danh sách giải cứu.
exports.getRecommendations = asyncHandler(async (req, res) => {
    const userId = req.user.userId;
    const rankedRecipes = await rankRecipesForInventory(userId);
    const suggestedRecipes = rankedRecipes
        .filter(entry => entry.analysis.matchScore > 0)
        .slice(0, 20)
        .map(entry => entry.recipe);
    const rescueRecipes = rankedRecipes
        .filter(entry => entry.analysis.canCook && entry.analysis.usesExpiringIngredients)
        .slice(0, 10)
        .map(entry => entry.recipe);
    const suggestedRecipeIds = suggestedRecipes.map(recipe => recipe.recipeId);
    const randomRecipes = await Recipe.aggregate([
        { $match: { $and: [VISIBLE_RECIPE_CLAUSE, { recipeId: { $nin: suggestedRecipeIds } }] } },
        { $sample: { size: 10 } },
        { $project: publicRecipeProjection() }
    ]);

    console.log(`[API] ${req.method} ${req.originalUrl} - Get recommendations success (User: ${userId}, Suggested: ${suggestedRecipes.length})`);
    res.status(200).json({
        success: true,
        data: {
            random: randomRecipes,
            suggested: suggestedRecipes,
            rescue: rescueRecipes
        }
    });
});

// Nhờ AI tìm và tạo công thức mới (Khi DB k có)
exports.aiSearchRecipe = asyncHandler(async (req, res) => {
    const { query } = req.body;
    if (!query) return res.status(400).json({ success: false, message: 'Thiếu query tìm kiếm' });

    const prompt = `
Bạn là một Đầu bếp chuẩn sao Michelin. Người dùng đang muốn tìm công thức cho món: "${query}".
Hãy viết một công thức ngắn gọn, định lượng rõ và chuẩn xác cho món này. Trả về dưới định dạng JSON sau:
{
    "title": "Tên món",
    "description": "Mô tả ngắn",
    "dishType": "MAIN",
    "cookingTimeMinutes": 30,
    "baseServings": 2,
    "ingredients": [
        { "name": "Cá hoặc thịt chính", "amount": 300, "unit": "G", "required": true }
    ],
    "steps": ["Bước 1"],
    "tags": []
}
Chỉ dùng unit G, KG, ML, L hoặc PIECE. Có tối đa 10 bước và mỗi bước tối đa hai câu.
${AI_PORTION_RULES}
Trả về CHỈ JSON, không giải thích thêm.
`;
    let result;
    try {
        // Dùng generateGeneralAdvice để tận dụng cơ chế Fallback và Timeout trung tâm
        const responseText = await geminiService.generateGeneralAdvice(
            'Bạn là đầu bếp AI. Chỉ trả về JSON hợp lệ theo schema yêu cầu, không giải thích thêm.',
            prompt
        );
        result = JSON.parse(responseText.replace(/```json/gi, '').replace(/```/g, '').trim());
    } catch (error) {
        console.error("Error in aiSearchRecipe:", error);
        throw new Error(error.message || "Lỗi khi gọi AI tạo công thức");
    }

    const newRecipeId = await allocateAiRecipeId();
    const normalizedResult = normalizeGeneratedRecipe(result, {
        title: query,
        description: 'Sưu tầm bởi AI',
        imageUrl: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c',
        baseServings: 1
    });
    const newRecipe = new Recipe({
        recipeId: newRecipeId,
        ...normalizedResult,
        source: 'AI',
        dataVersion: 2
    });

    await newRecipe.save();

    console.log(`[API] ${req.method} ${req.originalUrl} - AI search recipe success (Query: ${query})`);
    res.status(200).json({
        success: true,
        data: toPublicRecipe(newRecipe)
    });
});

// RAG theo yêu cầu chủ động của người dùng. Retrieval chỉ tạo context; AI trả
// JSON có provenance, sau đó matcher kiểm tra lại đủ lượng/đơn vị/expiry.
// AI draft được lưu DRAFT để có thể xem/nấu, nhưng không lẫn vào catalog chính.
exports.ragSuggestRecipe = asyncHandler(async (req, res) => {
    let query;
    try {
        query = recipeRagService.normalizeQuery(req.body?.query);
    } catch (error) {
        return res.status(error.statusCode || 400).json({
            success: false,
            code: error.code || 'INVALID_RAG_QUERY',
            message: error.message
        });
    }

    const inventorySnapshot = await loadInventory(req.user.userId);
    if (inventorySnapshot.length === 0) {
        return res.status(200).json({
            success: true,
            data: {
                type: 'NEED_SHOPPING',
                reasoning: 'Kho chưa có nguyên liệu còn hạn để tạo gợi ý nấu ăn an toàn.',
                sourceRecipeIds: [],
                rag: recipeRagService.toRagMetadata({}, { retrieval: 'NOT_RUN_EMPTY_INVENTORY' })
            }
        });
    }

    let retrieval;
    try {
        retrieval = await recipeRagService.retrieveRecipeGrounding(query);
    } catch (error) {
        return res.status(error.statusCode || 502).json({
            success: false,
            code: error.code || 'RAG_RETRIEVAL_FAILED',
            message: error.message || 'Không thể truy xuất công thức tham chiếu.'
        });
    }

    if (retrieval.candidates.length === 0) {
        return res.status(200).json({
            success: true,
            data: {
                type: 'RAG_RETRIEVAL_EMPTY',
                reasoning: 'Chưa tìm thấy công thức tham chiếu phù hợp trong catalog để điều chỉnh an toàn.',
                sourceRecipeIds: [],
                rag: recipeRagService.toRagMetadata({}, retrieval)
            }
        });
    }

    let completion;
    try {
        completion = await geminiService.generateStructuredReceipt({
            systemInstruction: 'Bạn trả lời JSON cho RAG công thức. Chỉ bám dữ liệu context và tuân thủ schema được yêu cầu.',
            promptParts: [{
                text: recipeRagService.buildRecipeRagPrompt({
                    query,
                    inventory: inventorySnapshot,
                    candidates: retrieval.candidates
                })
            }],
            requestId: `recipe-rag-${Date.now()}`,
            inputMode: 'recipe_rag'
        });
    } catch (error) {
        return res.status(error.statusCode || 502).json({
            success: false,
            code: error.code || 'RAG_MODEL_FAILED',
            message: 'AI chưa thể tạo gợi ý lúc này. Bạn vẫn có thể tìm công thức trong catalog.'
        });
    }

    let envelope;
    try {
        envelope = recipeRagService.validateRagEnvelope(
            recipeRagService.parseRagJson(completion.text),
            retrieval.candidates
        );
    } catch (error) {
        return res.status(error.statusCode || 422).json({
            success: false,
            code: error.code || 'INVALID_RAG_RESPONSE',
            message: 'AI trả về gợi ý không đủ căn cứ; hệ thống đã không sử dụng kết quả này.'
        });
    }

    const ragMetadata = recipeRagService.toRagMetadata(completion.metadata, retrieval);
    if (envelope.mode === 'NEED_SHOPPING') {
        return res.status(200).json({
            success: true,
            data: {
                type: 'NEED_SHOPPING',
                reasoning: envelope.reasoning || 'Các công thức tham chiếu hiện chưa phù hợp với kho.',
                sourceRecipeIds: envelope.baseRecipeIds,
                rag: ragMetadata
            }
        });
    }

    let normalizedRecipe;
    try {
        normalizedRecipe = normalizeGeneratedRecipe(envelope.recipe, {
            title: query,
            description: 'Công thức được RAG điều chỉnh từ catalog và kho hiện tại.',
            baseServings: 1
        });
    } catch (error) {
        return res.status(error.statusCode || 422).json({
            success: false,
            code: error.code || 'INVALID_RAG_RECIPE',
            message: 'Công thức AI không đạt điều kiện định lượng tối thiểu nên không được sử dụng.'
        });
    }

    const candidateRecipe = new Recipe({
        // ID tạm chỉ dùng cho phân tích trong memory. Không tạo sequence/draft
        // khi matcher kết luận công thức chưa thể nấu từ kho thực tế.
        recipeId: 'rag_preview',
        ...normalizedRecipe,
        source: 'AI',
        status: 'DRAFT',
        dataVersion: 2
    });
    const analysis = analyzeRecipe(candidateRecipe, inventorySnapshot);

    // Matcher là quyết định cuối. Không lưu hoặc trả một món "có thể nấu" nếu
    // còn thiếu core ingredient, không tương thích đơn vị, hoặc cần review.
    if (!analysis.canCook) {
        return res.status(200).json({
            success: true,
            data: {
                type: 'NEED_SHOPPING',
                reasoning: 'Gợi ý AI không qua kiểm tra tồn kho thực tế; hãy bổ sung các nguyên liệu bắt buộc bên dưới.',
                sourceRecipeIds: envelope.baseRecipeIds,
                missingCoreIngredients: analysis.missingCoreIngredients.map(toPublicIngredient),
                reviewRequiredIngredients: analysis.reviewRequiredIngredients.map(toPublicIngredient),
                rag: ragMetadata
            }
        });
    }

    candidateRecipe.recipeId = await allocateAiRecipeId();
    await candidateRecipe.save();
    
    const sessionId = req.get('X-Request-Id') || `recipe-rag-${Date.now()}`;
    // Ghi AI Metrics cho RAG
    aiMetricsService.logRecipeAiResponse({
        userId: req.user.userId,
        sessionId,
        latencyMs: ragMetadata.durationMs,
        usedAiFallback: true,
        suggestionCount: 1,
        aiModel: ragMetadata.model
    });

    console.info('[Recipe RAG]', {
        userId: req.user.userId,
        recipeId: candidateRecipe.recipeId,
        sourceRecipeIds: envelope.baseRecipeIds,
        retrieval: ragMetadata.retrieval,
        model: ragMetadata.model,
        durationMs: ragMetadata.durationMs
    });
    return res.status(200).json({
        success: true,
        data: {
            type: 'RAG_ADAPTED_RECIPE',
            reasoning: envelope.reasoning,
            sourceRecipeIds: envelope.baseRecipeIds,
            recipe: decorateRecipe(candidateRecipe, analysis),
            rag: ragMetadata
        }
    });
});

// Hoàn tất nấu: preflight toàn bộ -> FEFO -> transaction, không trừ dở dang.
exports.cookRecipe = asyncHandler(async (req, res) => {
    const userId = req.user.userId;
    const { recipeId, cookedServings, idempotencyKey: bodyIdempotencyKey } = req.body;
    const idempotencyKey = String(req.get('Idempotency-Key') || bodyIdempotencyKey || '').trim();

    if (!idempotencyKey || idempotencyKey.length > 120) {
        return res.status(400).json({
            success: false,
            message: 'Idempotency-Key là bắt buộc và không được dài quá 120 ký tự.'
        });
    }

    const recipe = await Recipe.findOne({ recipeId })
        .select(publicRecipeProjection())
        .lean();
    if (!recipe) return res.status(404).json({ success: false, message: 'Không tìm thấy công thức' });

    const previousResult = await Item.findOne({
        userId,
        isCookedMeal: true,
        cookIdempotencyKey: idempotencyKey
    }).select('_id sourceRecipeId standardQuantity');
    if (previousResult) {
        return res.status(200).json({
            success: true,
            replayed: true,
            message: 'Yêu cầu nấu này đã được xử lý trước đó.',
            data: { cookedItemId: previousResult._id }
        });
    }

    const session = await mongoose.startSession();
    let resultData;
    try {
        await session.withTransaction(async () => {
            const alreadyCreated = await Item.findOne({
                userId,
                isCookedMeal: true,
                cookIdempotencyKey: idempotencyKey
            }).session(session);
            if (alreadyCreated) {
                resultData = { cookedItemId: alreadyCreated._id, consumptionPlan: [], replayed: true };
                return;
            }

            const inventory = await Item.find({
                userId,
                usageStatus: 'ACTIVE',
                quantity: { $gt: 0 },
                standardQuantity: { $gt: 0 }
            }).sort({ expiryDate: 1, createdAt: 1 }).session(session).lean();

            let consumption;
            try {
                consumption = buildConsumptionPlan(recipe, inventory, cookedServings);
            } catch (error) {
                error.statusCode = error.code === 'INVALID_SERVINGS' ? 400 : 409;
                throw error;
            }
            const consumedBatchIds = new Set(consumption.plan.map(entry => String(entry.batchId)));
            const warningBatchCount = inventory.filter(item => {
                if (!consumedBatchIds.has(String(item._id)) || !item.expiryDate) return false;
                const remainingMs = new Date(item.expiryDate).getTime() - Date.now();
                const remainingDays = Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
                return remainingDays >= 0 && remainingDays <= 2;
            }).length;

            for (const entry of consumption.plan) {
                const batch = await Item.findOne({
                    _id: entry.batchId,
                    userId,
                    usageStatus: 'ACTIVE',
                    standardQuantity: { $gte: entry.standardAmount }
                }).session(session);
                if (!batch) {
                    const conflict = new Error('Inventory vừa thay đổi, vui lòng tải lại gợi ý trước khi nấu.');
                    conflict.statusCode = 409;
                    conflict.code = 'STALE_INVENTORY';
                    throw conflict;
                }
                const remaining = calculateRemainingBatchAmounts(batch, entry.standardAmount);
                if (!remaining) {
                    const invalidBatch = new Error('Định lượng lô hàng không hợp lệ, vui lòng kiểm tra lại kho.');
                    invalidBatch.statusCode = 409;
                    invalidBatch.code = 'INVALID_BATCH_MEASURE';
                    throw invalidBatch;
                }
                batch.quantity = remaining.quantity;
                batch.standardQuantity = remaining.standardQuantity;
                if (batch.standardQuantity <= 1e-8) {
                    batch.standardQuantity = 0;
                    batch.quantity = 0;
                    batch.usageStatus = 'CONSUMED';
                }
                await batch.save({ session });
            }

            const expiry = new Date();
            expiry.setDate(expiry.getDate() + 3);
            expiry.setHours(23, 59, 59, 999);
            const [cookedItem] = await Item.create([{
                userId,
                rawName: recipe.title,
                itemName: `[Chín] ${recipe.title}`,
                category: 'OTHER',
                subCategory: 'OTHER',
                quantity: Number(cookedServings),
                originalQuantity: Number(cookedServings),
                unit: 'khẩu phần',
                standardQuantity: Number(cookedServings),
                standardUnit: 'PIECE',
                purchasePrice: 0,
                expiryDate: expiry,
                storageLocation: 'FRIDGE',
                expirySource: 'ESTIMATED_RULE',
                expiryRuleCode: 'COOKED_LEFTOVER_3_DAYS',
                isCookedMeal: true,
                sourceRecipeId: recipe.recipeId,
                cookIdempotencyKey: idempotencyKey,
                isFromSuggestion: Boolean(req.body.isFromSuggestion),
                rescuedCount: warningBatchCount,
                usageStatus: 'ACTIVE'
            }], { session });
            resultData = {
                cookedItemId: cookedItem._id,
                consumptionPlan: consumption.plan,
                rescuedWarningCount: warningBatchCount,
                replayed: false
            };
        });
    } catch (error) {
        if (error.code === 11000) {
            const existing = await Item.findOne({
                userId,
                isCookedMeal: true,
                cookIdempotencyKey: idempotencyKey
            }).select('_id');
            if (existing) {
                resultData = { cookedItemId: existing._id, consumptionPlan: [], replayed: true };
            } else {
                throw error;
            }
        } else {
            throw error;
        }
    } finally {
        await session.endSession();
    }

    if (!resultData.replayed) {
        const questService = require('../services/quest.service');
        await questService.triggerDailyQuest(userId, 'COOK_FROM_INVENTORY', 1);
        if (resultData.rescuedWarningCount > 0) {
            await questService.triggerAchievement(
                userId,
                'CONSUME_WARNING_ITEM',
                resultData.rescuedWarningCount
            );
        }
    }

    let gamificationState = null;
    try {
        const rpgService = require('../services/rpg.service');
        gamificationState = await rpgService.calculateUserStats(userId);
    } catch (error) {
        console.error('[RPG] Không thể tính lại chỉ số sau khi nấu:', error.message);
    }

    console.log(`[API] ${req.method} ${req.originalUrl} - Cook recipe success (User: ${userId}, Recipe: ${recipeId})`);

    // Ghi USER_CONFIRMED recipe — fire-and-forget
    if (!resultData.replayed) {
        aiMetricsService.logRecipeUserConfirmed({
            userId,
            sessionId: idempotencyKey,
            cookSuccess: true,
            usedAiFallback: Boolean(req.body.usedAiFallback),
            suggestionRank: typeof req.body.suggestionRank === 'number' ? req.body.suggestionRank : null
        });
    }

    res.status(200).json({
        success: true,
        replayed: resultData.replayed,
        message: 'Đã nấu xong và cập nhật tủ lạnh!',
        data: resultData,
        gamificationState
    });
});
