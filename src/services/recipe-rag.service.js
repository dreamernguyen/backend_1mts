'use strict';

const Recipe = require('../models/recipe.model');
const {
    VISIBLE_RECIPE_CLAUSE,
    buildRecipeFilter,
    publicRecipeProjection,
    toPublicIngredient
} = require('./recipe-catalog.service');
const {
    semanticRecipeSearch,
    vectorSearchEnabled
} = require('./recipe-retrieval.service');
const { analyzeRecipe } = require('./recipe-matching.service');
const {
    RECIPE_RAG_PROMPT_VERSION,
    RECIPE_RAG_FEW_SHOT_EXAMPLES
} = require('../config/recipe-rag-fewshot.examples');

const MAX_QUERY_LENGTH = 300;
const MAX_CONTEXT_INVENTORY_ITEMS = 30;
const MAX_CONTEXT_RECIPES = 6;

function ragError(message, code = 'INVALID_RAG_RESPONSE', statusCode = 422) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    return error;
}

function normalizeQuery(value) {
    const query = String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim();
    if (!query) throw ragError('Thiếu yêu cầu gợi ý món ăn.', 'INVALID_RAG_QUERY', 400);
    if (query.length > MAX_QUERY_LENGTH) {
        throw ragError(`Yêu cầu không được dài quá ${MAX_QUERY_LENGTH} ký tự.`, 'INVALID_RAG_QUERY', 400);
    }
    return query;
}

function compactText(value, maxLength = 200) {
    return String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function uniqueByRecipeId(recipes, limit = MAX_CONTEXT_RECIPES) {
    const seen = new Set();
    return (recipes || []).filter(recipe => {
        const recipeId = String(recipe?.recipeId || '').trim();
        if (!recipeId || seen.has(recipeId)) return false;
        seen.add(recipeId);
        return true;
    }).slice(0, limit);
}

// Retrieval không quyết định nguyên liệu đủ/thiếu. Nó chỉ đưa candidate đã
// công khai vào ngữ cảnh; matcher sẽ là hard gate sau khi AI trả JSON.
async function retrieveRecipeGrounding(query, limit = MAX_CONTEXT_RECIPES) {
    const safeLimit = Math.min(Math.max(Number(limit) || MAX_CONTEXT_RECIPES, 1), MAX_CONTEXT_RECIPES);
    const lexicalFilter = buildRecipeFilter({ query });
    const [lexicalRecipes, semanticResult] = await Promise.all([
        Recipe.find(lexicalFilter)
            .select(publicRecipeProjection())
            .sort({ recipeId: 1 })
            .limit(safeLimit)
            .lean(),
        (async () => {
            if (!vectorSearchEnabled()) return { recipes: [], attempted: false, errorCode: null };
            try {
                const recipes = await semanticRecipeSearch(query, safeLimit, VISIBLE_RECIPE_CLAUSE);
                return { recipes, attempted: true, errorCode: null };
            } catch (error) {
                // Không làm hỏng RAG khi index/vector tạm thời không khả dụng.
                console.warn('[Recipe RAG vector retrieval]', {
                    code: error.code || 'VECTOR_SEARCH_FAILED',
                    message: error.message
                });
                return { recipes: [], attempted: true, errorCode: error.code || 'VECTOR_SEARCH_FAILED' };
            }
        })
    ]);
    const candidates = uniqueByRecipeId([
        ...lexicalRecipes,
        ...semanticResult.recipes
    ], safeLimit);
    const retrieval = semanticResult.recipes.length > 0 && lexicalRecipes.length > 0
        ? 'HYBRID_LEXICAL_VECTOR'
        : semanticResult.recipes.length > 0
            ? 'VECTOR'
            : lexicalRecipes.length > 0
                ? 'LEXICAL'
                : 'NONE';

    return {
        candidates,
        retrieval,
        vectorAttempted: semanticResult.attempted,
        vectorErrorCode: semanticResult.errorCode
    };
}

function toInventoryContext(inventory, now = new Date()) {
    return (inventory || []).slice(0, MAX_CONTEXT_INVENTORY_ITEMS).map(item => {
        const expiryDate = item.expiryDate ? new Date(item.expiryDate) : null;
        const hasExpiry = expiryDate && Number.isFinite(expiryDate.getTime());
        return {
            // Chỉ đưa tên chuẩn vào prompt. rawName OCR không cần cho recipe
            // RAG và có thể làm ngữ cảnh dài/nhiễu hơn.
            itemName: compactText(item.itemName, 120),
            category: compactText(item.category, 50),
            subCategory: compactText(item.subCategory, 50),
            standardQuantity: Number(item.standardQuantity) || 0,
            standardUnit: String(item.standardUnit || '').toUpperCase(),
            expiryDate: hasExpiry ? expiryDate.toISOString().slice(0, 10) : null,
            daysRemaining: hasExpiry
                ? Math.ceil((expiryDate.getTime() - now.getTime()) / 86400000)
                : null
        };
    });
}

function toCandidateContext(candidates, inventory) {
    return (candidates || []).map(recipe => {
        const analysis = analyzeRecipe(recipe, inventory);
        return {
            recipeId: compactText(recipe.recipeId, 80),
            title: compactText(recipe.title, 160),
            description: compactText(recipe.description, 500),
            dishType: compactText(recipe.dishType || 'MAIN', 20),
            cookingTimeMinutes: Number(recipe.cookingTimeMinutes) || 0,
            baseServings: Number(recipe.baseServings || recipe.servings) || 1,
            ingredients: (recipe.ingredients || []).slice(0, 20).map(toPublicIngredient),
            matcherSummary: {
                canCook: analysis.canCook,
                feasibleServings: analysis.feasibleServings,
                missingCoreIngredients: analysis.missingCoreIngredients.map(toPublicIngredient),
                usesExpiringIngredients: analysis.usesExpiringIngredients
            }
        };
    });
}

function buildRecipeRagPrompt({ query, inventory, candidates, now = new Date() }) {
    const context = {
        userIntent: query,
        generatedAt: now.toISOString(),
        inventory: toInventoryContext(inventory, now),
        retrievedRecipes: toCandidateContext(candidates, inventory)
    };
    const examples = RECIPE_RAG_FEW_SHOT_EXAMPLES.map(example => ({
        userIntent: example.userIntent,
        expectedOutput: example.expected
    }));
    return [
        'Bạn là trợ lý điều chỉnh công thức cho ứng dụng One Month To Survival.',
        'Bạn chỉ được dùng dữ liệu trong INVENTORY và RETRIEVED_RECIPES dưới đây.',
        'RETRIEVED_RECIPES là ngữ cảnh truy xuất, không được bịa recipeId khác.',
        'INVENTORY chỉ gồm lô còn hạn và số lượng dương tại thời điểm xử lý, nhưng bạn không được tự kết luận đủ lượng: backend sẽ kiểm tra lại.',
        'Nếu không thể đưa ra món có nguyên liệu bắt buộc hợp lý từ context, trả mode NEED_SHOPPING và recipe là null.',
        'Nếu điều chỉnh một công thức, trả mode ADAPT_EXISTING, baseRecipeIds phải gồm ít nhất một recipeId trong RETRIEVED_RECIPES.',
        'Không được thêm nguyên liệu bắt buộc không xuất hiện trong INVENTORY. Gia vị phụ chỉ được dùng nếu có trong INVENTORY.',
        'Không dùng thực phẩm hết hạn; ưu tiên item có daysRemaining nhỏ hơn khi có nhiều lựa chọn.',
        'Output là JSON duy nhất, không markdown, theo schema: { mode, baseRecipeIds, reasoning, recipe }.',
        'recipe phải có title, description, dishType (MAIN/SIDE/SOUP/DRINK/DESSERT/SNACK), cookingTimeMinutes, baseServings, ingredients, steps.',
        'Mỗi ingredient gồm name, amount > 0, unit (G/KG/ML/L/PIECE), required; phải có ít nhất một required=true.',
        `FEW_SHOT_EXAMPLES=${JSON.stringify(examples)}`,
        `CONTEXT=${JSON.stringify(context)}`
    ].join('\n');
}

function parseRagJson(text) {
    const normalized = String(text || '')
        .replace(/^\s*```(?:json)?\s*/iu, '')
        .replace(/\s*```\s*$/u, '')
        .trim();
    if (!normalized) throw ragError('AI không trả nội dung RAG.');
    try {
        return JSON.parse(normalized);
    } catch (_) {
        throw ragError('AI trả dữ liệu RAG không phải JSON hợp lệ.');
    }
}

function validateRagEnvelope(value, candidates) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw ragError('Dữ liệu RAG phải là một object JSON.');
    }
    const mode = String(value.mode || '').trim().toUpperCase();
    if (!['ADAPT_EXISTING', 'NEED_SHOPPING'].includes(mode)) {
        throw ragError('mode RAG không hợp lệ.');
    }
    const candidateIds = new Set((candidates || []).map(recipe => String(recipe.recipeId)));
    const baseRecipeIds = [...new Set((Array.isArray(value.baseRecipeIds) ? value.baseRecipeIds : [])
        .map(id => String(id || '').trim())
        .filter(Boolean))];
    if (baseRecipeIds.some(id => !candidateIds.has(id))) {
        throw ragError('RAG tham chiếu công thức ngoài tập truy xuất.', 'RAG_UNGROUNDED_PROVENANCE');
    }
    if (mode === 'ADAPT_EXISTING' && baseRecipeIds.length === 0) {
        throw ragError('RAG phải nêu công thức tham chiếu khi điều chỉnh.', 'RAG_MISSING_PROVENANCE');
    }
    if (mode === 'ADAPT_EXISTING' && (!value.recipe || typeof value.recipe !== 'object')) {
        throw ragError('RAG thiếu công thức điều chỉnh.');
    }
    return {
        mode,
        baseRecipeIds,
        reasoning: String(value.reasoning || '').normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, 600),
        recipe: mode === 'ADAPT_EXISTING' ? value.recipe : null
    };
}

function toRagMetadata(metadata = {}, retrievalResult = {}) {
    return {
        promptVersion: RECIPE_RAG_PROMPT_VERSION,
        retrieval: retrievalResult.retrieval || 'NONE',
        vectorAttempted: Boolean(retrievalResult.vectorAttempted),
        vectorErrorCode: retrievalResult.vectorErrorCode || null,
        model: metadata.model || null,
        durationMs: Number.isFinite(metadata.durationMs) ? metadata.durationMs : null,
        totalTokenCount: Number.isFinite(metadata.totalTokenCount) ? metadata.totalTokenCount : null
    };
}

module.exports = {
    MAX_QUERY_LENGTH,
    RECIPE_RAG_PROMPT_VERSION,
    buildRecipeRagPrompt,
    normalizeQuery,
    parseRagJson,
    retrieveRecipeGrounding,
    toCandidateContext,
    toInventoryContext,
    toRagMetadata,
    uniqueByRecipeId,
    validateRagEnvelope
};
