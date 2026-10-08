const rpgService = require('../services/rpg.service');
const mongoose = require('mongoose');
const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const Recipe = require('../models/recipe.model');
const cookingPolicy = require('../services/cooking-policy.service');
const draftStore = require('../services/recipe-preview-store');
let catalogCache = { expires: 0, recipes: null };
let catalogLoading;
const catalogSaveJobs = new Map();
const rankingCache = require('../services/recipe-ranking-cache').createRankingCache();
async function loadMatchingCatalog() {
 if (catalogCache.expires > Date.now()) return catalogCache.recipes;
 if (!catalogLoading) catalogLoading = Recipe.find(VISIBLE_RECIPE_CLAUSE).select(publicRecipeProjection()).sort({ recipeId: 1 }).lean().then(recipes => { catalogCache = { expires: Date.now() + 60000, recipes }; return recipes; }).finally(() => { catalogLoading = null; });
 return await catalogLoading;
}
const Item = require('../models/item.model');
const geminiService = require('../services/gemini.service');
const inventoryService = require('../services/inventory.service');
const { semanticRecipeSearch } = require('../services/recipe-retrieval.service');
const {
    VISIBLE_RECIPE_CLAUSE,
    escapeRegExp,
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
        source: String(recipe.recipeId).startsWith("ai_recipe_") ? "AI" : "SYSTEM",
        matchPercentage: analysis.matchScore,
        matchScore: analysis.matchScore,
        canCook: analysis.canCook,
        shoppingShortages: cookingPolicy.shoppingShortages(recipe, analysis),
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

async function loadRankedSnapshot(userId, refresh = false) {
    const started = Date.now();
    const [inventory, recipes] = await Promise.all([loadInventory(userId), loadMatchingCatalog()]);
    const fetched = Date.now();
    const now = new Date();
    const result = rankingCache.get(userId, inventory, recipes, () => recipes
        .map(recipe => {
            const analysis = analyzeRecipe(recipe, inventory, { now, usableSnapshot: true });
            return { recipe: decorateRecipe(recipe, analysis), analysis };
        })
        .sort((a, b) => Number(b.analysis.canCook) - Number(a.analysis.canCook)
            || b.analysis.matchScore - a.analysis.matchScore
            || b.analysis.rescueScore - a.analysis.rescueScore), refresh);
    console.info('[Recipe performance]', { catalogCount: recipes.length, inventoryCount: inventory.length,
        loadMs: fetched - started, matchingMs: Date.now() - fetched, cacheHit: result.cacheHit });
    return { inventory, catalog: recipes, ...result };
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
    const persistedRecipe = await Recipe.findOne({ recipeId })
        .select(publicRecipeProjection())
        .lean();
    const originalRecipe = persistedRecipe || draftStore.findRecipe(userId, recipeId);
    let recipe = originalRecipe;
    try { if (originalRecipe) recipe = cookingPolicy.applySubstitutions(originalRecipe, req.method === 'GET' ? JSON.parse(req.query.substitutions || '[]') : (req.body.substitutions || [])); }
    catch (error) { return res.status(400).json({ success: false, message: error.message }); }
    if (!recipe) {
        return res.status(404).json({ success: false, message: 'Không tìm thấy công thức' });
    }

    const fridgeItems = await loadInventory(userId);
    const matchingAnalysis = analyzeRecipe(recipe, fridgeItems);
    const decoratedRecipe = decorateRecipe(recipe, matchingAnalysis);
    const substitutionOptions = (originalRecipe.ingredients || []).flatMap((ingredient, index) => (ingredient.allowedSubstitutions || []).map(option => {
      const name = typeof option === 'string' ? option : option.canonicalName;
      const trial = cookingPolicy.applySubstitutions(originalRecipe, [{ index, name }]);
      const match = analyzeRecipe(trial, fridgeItems).ingredientMatches[index];
      return { index, name, forIngredient: ingredient.name || ingredient.itemName, enough: match.quantityRatio >= 1 };
    })).filter(option => option.enough);
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
            substitutionOptions,
            missingAnalysis,
            matchingAnalysis,
            selectedServings,
            consumptionPreview,
            aiFailed: false
        }
    });
});

// Hôm nay ăn gì chỉ xếp hạng catalog; không gọi Gemini.
exports.suggestTodayRecipe = asyncHandler(async (req, res) => {
    const userId = req.user.userId;
    const sessionId = req.recipeMetrics.sessionId;
    // Một snapshot duy nhất cho ranking, AI context và validation trong request này.
    const { inventory: inventorySnapshot, ranked: rankedRecipes } = await loadRankedSnapshot(userId);
    const report = inventoryService.generateInventoryReportFromSnapshot(inventorySnapshot);
    if (report.isEmpty || report.onlySpices) return res.json({ success: true, data: { type: 'NEED_SHOPPING', choices: [], needsShopping: true, reasoning: 'Kho chưa có đủ thực phẩm chính. Hãy bổ sung thực phẩm trước khi chọn món.', recommendationSessionId: sessionId, recommendationSource: 'RULE_DB' } });
    const excludedRecipeIds = parseExcludedRecipeIds(req.query.excludeRecipeIds);
    let pool = rankedRecipes.filter(entry => !excludedRecipeIds.includes(entry.recipe.recipeId));
    const rotationReset = pool.length === 0;
    if (rotationReset) pool = rankedRecipes;
    const shuffle = entries => entries.map(entry => ({ entry, random: Math.random() })).sort((a,b) => b.entry.analysis.rescueScore - a.entry.analysis.rescueScore || a.random - b.random).map(e => e.entry);
    const cookable = shuffle(pool.filter(e => e.analysis.canCook));
    const shopping = pool.filter(e => !e.analysis.canCook && e.analysis.matchScore > 0).sort((a,b) => a.analysis.missingCoreIngredients.length - b.analysis.missingCoreIngredients.length || b.analysis.matchScore - a.analysis.matchScore);
    const remaining = [...cookable, ...shopping].slice(0, 5);
    const choices = remaining.map((entry, index) => {
        const servings = entry.analysis.canCook ? Math.min(2, entry.analysis.feasibleServings) : 2;
        const analysis = entry.analysis;
        const missing = cookingPolicy.shoppingShortages(entry.recipe, analysis, servings);
        return { type: 'DATABASE_RECIPE', recipeId: entry.recipe.recipeId, title: entry.recipe.title, canCook: entry.analysis.canCook, proposedServings: servings, missingIngredients: missing,
            reasoning: entry.analysis.canCook ? buildTodaySuggestionReasoning(entry.recipe, entry.analysis) : 'Món đề xuất cần bổ sung nguyên liệu trước khi nấu.',
            matchScore: entry.analysis.matchScore, feasibleServings: entry.analysis.feasibleServings, recommendationSessionId: sessionId, recommendationSource: 'RULE_DB', recommendationRank: index + 1 };
    });
    if (choices[0]) choices[0].needsShopping = cookable.length === 0;
    req.recipeMetrics.candidates = remaining.map(e => e.recipe);
    return res.json({ success: true, data: { ...(choices[0] || { type: 'NEED_SHOPPING', reasoning: 'Kho chưa đủ để nấu. Hãy bổ sung thực phẩm hoặc tìm món để lên danh sách đi chợ.' }), choices, rotationReset, needsShopping: cookable.length === 0, recommendationSessionId: sessionId, recommendationSource: 'RULE_DB' } });
});

// Lấy món đề xuất bằng matcher xác định và tách riêng danh sách giải cứu.
exports.getRecommendations = asyncHandler(async (req, res) => {
    const userId = req.user.userId;
    const { ranked: rankedRecipes, catalog } = await loadRankedSnapshot(userId, req.query.refresh === 'true');
    const suggestedRecipes = rankedRecipes
        .filter(entry => entry.analysis.matchScore > 0)
        .slice(0, 20)
        .map(entry => entry.recipe);
    const rescueRecipes = rankedRecipes
        .filter(entry => entry.analysis.canCook && entry.analysis.usesExpiringIngredients)
        .slice(0, 10)
        .map(entry => entry.recipe);
    const suggestedRecipeIds = suggestedRecipes.map(recipe => recipe.recipeId);
    // The catalog is already loaded; sample without another database round trip.
    const randomPool = catalog.filter(recipe => !suggestedRecipeIds.includes(recipe.recipeId));
    for (let i = randomPool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [randomPool[i], randomPool[j]] = [randomPool[j], randomPool[i]];
    }
    const randomRecipes = randomPool.slice(0, 10).map(toPublicRecipe);

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
exports.aiSearchRecipe = (req, res, next) => { req.body.createNew = true; return exports.ragSuggestRecipe(req, res, next); };

// RAG theo yêu cầu chủ động của người dùng. Retrieval chỉ tạo context; AI trả
// JSON có provenance, sau đó matcher kiểm tra lại đủ lượng/đơn vị/expiry.
// Bản nháp nằm trong bộ nhớ cho tới khi người dùng chọn lưu.
exports.ragSuggestRecipe = asyncHandler(async (req, res) => {
    const recommendationSessionId = req.recipeMetrics.sessionId;
    const baseRecipeId = req.body?.baseRecipeId == null ? null : String(req.body.baseRecipeId).trim();
    const fromInventory = req.body?.fromInventory === true;
    const surprise = req.body?.surprise === true;
    const createNew = req.body?.createNew === true || !baseRecipeId;
    const excludedRecipeIds = parseExcludedRecipeIds(req.body?.excludeRecipeIds);
    if (baseRecipeId && !/^[A-Za-z0-9_-]{1,160}$/.test(baseRecipeId)) {
        return res.status(400).json({ success: false, code: 'INVALID_BASE_RECIPE', message: 'Mã công thức gốc không hợp lệ.' });
    }
    let query;
    try {
        query = recipeRagService.normalizeQuery(surprise ? 'Tạo một biến thể món bất ngờ từ kho, ưu tiên thực phẩm sắp hết hạn, khác các món đã đề xuất. Không cần người dùng nhập yêu cầu.' : req.body?.query);
    } catch (error) {
        return res.status(error.statusCode || 400).json({
            success: false,
            code: error.code || 'INVALID_RAG_QUERY',
            message: error.message
        });
    }

    const rejection = cookingPolicy.validateIntent(query);
    if (rejection) return res.status(200).json({ success: true, data: { type: 'REFUSED', reasoning: rejection } });
    if (createNew) {
      const escaped = escapeRegExp(query);
      const canonicalQuery = require('../services/recipe-matching.service').canonicalizeName(query);
      const existing = (await loadMatchingCatalog()).find(recipe => require('../services/recipe-matching.service').canonicalizeName(recipe.title) === canonicalQuery) || await Recipe.findOne({ $and: [VISIBLE_RECIPE_CLAUSE, { title: new RegExp(`^${escaped}$`, 'i') }] }).select(publicRecipeProjection()).lean();
      if (existing) return res.json({ success: true, data: { type: 'RAG_ADAPTED_RECIPE', recipe: decorateRecipe(existing, analyzeRecipe(existing, await loadInventory(req.user.userId))), reasoning: 'Bộ công thức đã có món này, bạn có thể dùng ngay.', existingRecipe: true } });
    }
    const inventorySnapshot = await loadInventory(req.user.userId);
    const ragInventoryReport = inventoryService.generateInventoryReportFromSnapshot(inventorySnapshot);
    if (surprise && (ragInventoryReport.isEmpty || ragInventoryReport.onlySpices)) {
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
        if (createNew && !baseRecipeId) { retrieval = { candidates: [], retrieval: 'GENERATION_FROM_QUERY' }; } else if (baseRecipeId) {
            const baseRecipe = await Recipe.findOne({ recipeId: baseRecipeId }).select(publicRecipeProjection()).lean();
            if (!baseRecipe) return res.status(404).json({ success: false, code: 'RECIPE_NOT_FOUND', message: 'Không tìm thấy công thức gốc.' });
            retrieval = { candidates: [baseRecipe], retrieval: 'SELECTED_RECIPE' };
        } else if (fromInventory) {
            const ranked = await rankRecipesForInventory(req.user.userId, 400, inventorySnapshot);
            retrieval = { candidates: ranked.filter(entry => entry.analysis.matchScore > 0).slice(0, 3).map(entry => entry.recipe), retrieval: 'INVENTORY_MATCHING' };
        } else {
            retrieval = await recipeRagService.retrieveRecipeGrounding(query);
        }
    } catch (error) {
        return res.status(error.statusCode || 502).json({
            success: false,
            code: error.code || 'RAG_RETRIEVAL_FAILED',
            message: error.message || 'Không thể truy xuất công thức tham chiếu.'
        });
    }

    if (!createNew && retrieval.candidates.length === 0) {
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
        req.recipeMetrics.source = 'RAG_GEMINI';
        completion = await geminiService.generateStructuredReceipt({
            systemInstruction: createNew ? 'Bạn là đầu bếp thực tế. Tạo đúng món được yêu cầu, từ chối yêu cầu nguy hiểm hoặc không liên quan nấu ăn. Trả JSON theo schema; không giả vờ đã tìm kiếm web.' : 'Bạn tinh luyện công thức gốc bằng RAG. Giữ nguyên liệu chính và nhóm chế biến; trả JSON theo schema.',
            promptParts: [{
                text: recipeRagService.buildRecipeRagPrompt({
                    query,
                    createNew,
                    randomVariant: surprise,
                    excludedRecipeIds,
                    baseRecipeId,
                    inventory: inventorySnapshot,
                    candidates: retrieval.candidates
                })
            }],
            requestId: recommendationSessionId,
            inputMode: 'recipe_rag',
            totalDeadlineMs: 30000
        });
    } catch (error) {
        req.recipeMetrics.provider = error.metadata;
        return res.status(error.statusCode || 502).json({
            success: false,
            code: error.code || 'RAG_MODEL_FAILED',
            message: error.code === 'AI_TIMEOUT' ? 'Cappy chưa phản hồi kịp. Yêu cầu của bạn vẫn được giữ; hãy thử lại.' : 'AI chưa thể tạo gợi ý lúc này. Bạn vẫn có thể tìm công thức trong catalog.'
        });
    }

    req.recipeMetrics.provider = completion.metadata;
    let envelope;
    try {
        envelope = recipeRagService.validateRagEnvelope(
            recipeRagService.parseRagJson(completion.text),
            retrieval.candidates,
            baseRecipeId,
            createNew
        );
    } catch (error) {
        console.warn('[Recipe AI validation]', { requestId: recommendationSessionId, mode: createNew ? 'CREATE' : 'RAG', code: error.code, reason: error.message });
        return res.status(error.statusCode || 422).json({
            success: false,
            code: error.code || 'INVALID_RAG_RESPONSE',
            message: 'Cappy chưa trả về công thức hoàn chỉnh. Bạn có thể thử lại.'
        });
    }

    const ragMetadata = recipeRagService.toRagMetadata(completion.metadata, retrieval);
    if (['NEED_SHOPPING', 'REFUSED', 'CLARIFY'].includes(envelope.mode)) {
        return res.status(200).json({
            success: true,
            data: {
                type: envelope.mode === 'NEED_SHOPPING' ? 'NEED_SHOPPING' : envelope.mode,
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
        console.warn('[Recipe AI recipe validation]', { requestId: recommendationSessionId, code: error.code, reason: error.message });
        return res.status(error.statusCode || 422).json({
            success: false,
            code: error.code || 'INVALID_RAG_RECIPE',
            message: `Cappy chưa dùng được công thức này: ${error.message || 'Dữ liệu nguyên liệu chưa hợp lệ.'}`
        });
    }

    const unsafeOutput = [normalizedRecipe.title, ...normalizedRecipe.ingredients.map(item => item.name)].map(value => cookingPolicy.validateIntent(value)).find(Boolean);
    if (unsafeOutput) return res.json({ success: true, data: { type: 'REFUSED', reasoning: unsafeOutput } });

    const invalidDish = createNew ? cookingPolicy.validateRequestedDish(query, normalizedRecipe) : null;
    if (invalidDish) return res.status(422).json({ success: false, code: 'AI_DISH_MISMATCH', message: invalidDish });
    const base = retrieval.candidates[0];
    if (!createNew && base) {
      const invalid = cookingPolicy.validateRefinement(base, normalizedRecipe, query);
      if (invalid) return res.json({ success: true, data: { type: 'CLARIFY', reasoning: invalid } });
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
    if (candidateRecipe.validateSync()) return res.status(422).json({ success: false, code: 'INVALID_RAG_RECIPE', message: 'Công thức AI chưa đạt cấu trúc dữ liệu để lưu.' });
    const analysis = analyzeRecipe(candidateRecipe, inventorySnapshot);
    req.recipeMetrics.candidates = [decorateRecipe(candidateRecipe, analysis)];

    // Matcher là quyết định cuối. Không lưu hoặc trả một món "có thể nấu" nếu
    // còn thiếu core ingredient, không tương thích đơn vị, hoặc cần review.
    if (surprise && !analysis.canCook) {
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
    const savable = createNew || cookingPolicy.isCatalogVariant(base, normalizedRecipe);
    const draftToken = draftStore.put(req.user.userId, { ...normalizedRecipe, recipeId: candidateRecipe.recipeId, baseRecipeId: baseRecipeId || null }, recommendationSessionId);
    draftStore.get(req.user.userId, draftToken).savable = savable;
    
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
            draftToken,
            savable,
            changes: envelope.changes,
            baseRecipeId,
            sourceRecipes: retrieval.candidates.filter(recipe => envelope.baseRecipeIds.includes(recipe.recipeId)).map(recipe => ({ recipeId: recipe.recipeId, title: recipe.title })),
            reasoning: envelope.reasoning,
            sourceRecipeIds: envelope.baseRecipeIds,
            recipe: decorateRecipe(candidateRecipe, analysis),
            recommendationSessionId,
            recommendationSource: 'RAG_GEMINI',
            recommendationRank: 1,
            rag: ragMetadata
        }
    });
});

// Chỉ lưu khi người dùng chọn; token gắn người dùng và chống lưu lặp trong phiên.
exports.saveRagDraft = asyncHandler(async (req, res) => {
 const entry = draftStore.get(req.user.userId, req.body?.draftToken);
 if (!entry) return res.status(410).json({ success: false, code: 'DRAFT_EXPIRED', message: 'Bản nháp đã hết hạn. Hãy mở món mới.' });
 if (entry.savable === false) return res.status(422).json({ success: false, code: 'SESSION_ONLY', message: 'Điều chỉnh khẩu vị/khẩu phần chỉ dùng trong phiên, không tạo công thức trùng.' });
 if (!entry.saving) {
  const titleKey = require('../services/recipe-matching.service').canonicalizeName(entry.recipe.title);
  if (!catalogSaveJobs.has(titleKey)) {
   const job = (async () => {
    const regex = new RegExp(`^${escapeRegExp(entry.recipe.title)}$`, 'i');
    const existing = (await loadMatchingCatalog()).find(recipe => require('../services/recipe-matching.service').canonicalizeName(recipe.title) === titleKey) || await Recipe.findOne({ $and: [VISIBLE_RECIPE_CLAUSE, { title: regex }] }).select(publicRecipeProjection()).lean();
    if (existing) return existing;
    const recipe = new Recipe({ ...entry.recipe, recipeId: entry.recipe.recipeId, source: 'AI', status: 'ACTIVE', dataVersion: 2 });
    await recipe.save(); catalogCache.expires = 0;
    Promise.resolve().then(() => require('../services/recipe-embedding.service').embedRecipeDocument(recipe)).then(vector => Recipe.updateOne({ recipeId: recipe.recipeId }, { $set: { embeddingVector: vector, embeddingModel: require('../services/recipe-embedding.service').EMBEDDING_MODEL, embeddingVersion: 'recipe-v3' } })).catch(error => console.warn('[Recipe embedding]', error.message));
    return toPublicRecipe(recipe);
   })();
   catalogSaveJobs.set(titleKey, job);
   job.finally(() => catalogSaveJobs.delete(titleKey)).catch(() => {});
  }
  entry.saving = catalogSaveJobs.get(titleKey).catch(error => { entry.saving = null; throw error; });
 }
 const storedRecipe = await entry.saving;
 const recipe = decorateRecipe(storedRecipe, analyzeRecipe(storedRecipe, await loadInventory(req.user.userId)));
 await require('../models/user.model').updateOne({ _id: req.user.userId }, { $addToSet: { savedRecipes: recipe.recipeId } });
 if (!entry.saveObserved) {
  entry.saveObserved = true;
  aiMetricsService.logRecipeSaved({ userId: req.user.userId, sessionId: entry.sessionId, recipeId: recipe.recipeId });
 }
 return res.json({ success: true, data: { ...recipe, recommendationSessionId: entry.sessionId, recommendationSource: 'RAG_GEMINI', recommendationRank: 1 } });
});

// Hoàn tất nấu: preflight toàn bộ -> FEFO -> transaction, không trừ dở dang.
exports.cookRecipe = asyncHandler(async (req, res) => {
    const userId = req.user.userId;
    const { recipeId, cookedServings, idempotencyKey: bodyIdempotencyKey } = req.body;
    const idempotencyKey = String(req.get('Idempotency-Key') || bodyIdempotencyKey || '').trim();
    const recommendationSessionId = /^[A-Za-z0-9_-]{8,150}$/.test(String(req.body.recommendationSessionId || ''))
        ? String(req.body.recommendationSessionId) : null;

    if (!idempotencyKey || idempotencyKey.length > 120) {
        return res.status(400).json({
            success: false,
            message: 'Idempotency-Key là bắt buộc và không được dài quá 120 ký tự.'
        });
    }

    const persistedRecipe = await Recipe.findOne({ recipeId })
        .select(publicRecipeProjection())
        .lean();
    const originalRecipe = persistedRecipe || draftStore.findRecipe(userId, recipeId);
    let recipe = originalRecipe;
    try { if (originalRecipe) recipe = cookingPolicy.applySubstitutions(originalRecipe, req.method === 'GET' ? JSON.parse(req.query.substitutions || '[]') : (req.body.substitutions || [])); }
    catch (error) { return res.status(400).json({ success: false, message: error.message }); }
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

            let cookedFoodValue = 0;
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
                // Giữ giá vốn thực phẩm khi chuyển từ nguyên liệu sang món chín.
                const valuedBefore = rpgService.inventoryValue(batch);
                cookedFoodValue += batch.quantity > 0 ? valuedBefore * (batch.quantity - remaining.quantity) / batch.quantity : 0;
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
                purchasePrice: cookedFoodValue / Number(cookedServings),
                baseUnitPrice: cookedFoodValue / Number(cookedServings),
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
        gamificationState = await rpgService.calculateUserStats(userId);
    } catch (error) {
        console.error('[RPG] Không thể tính lại chỉ số sau khi nấu:', error.message);
    }

    console.log(`[API] ${req.method} ${req.originalUrl} - Cook recipe success (User: ${userId}, Recipe: ${recipeId})`);

    // Ghi USER_CONFIRMED recipe — fire-and-forget
    if (!resultData.replayed) {
        aiMetricsService.logRecipeUserConfirmed({
            userId,
            sessionId: recommendationSessionId || idempotencyKey,
            cookSuccess: true,
            usedAiFallback: ['GEMINI_FALLBACK', 'RAG_GEMINI'].includes(String(req.body.recommendationSource)),
            suggestionRank: Number.isInteger(req.body.recommendationRank) && req.body.recommendationRank > 0 ? req.body.recommendationRank : null,
            recipeId
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

const { observeRecipe } = require('../services/recipe-metrics-observer');
for (const [name, mode] of [['suggestTodayRecipe', 'TODAY'], ['getRecommendations', 'OVERVIEW'], ['ragSuggestRecipe', 'RAG']]) {
    exports[name] = observeRecipe(exports[name], mode, aiMetricsService);
}
