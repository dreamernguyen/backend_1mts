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
const MAX_CONTEXT_RECIPES = 3;

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
            steps: (recipe.steps || []).slice(0, 8),
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

function buildRecipeRagPrompt({ query, inventory, candidates, baseRecipeId = null, createNew = false, randomVariant = false, excludedRecipeIds = [], now = new Date() }) {
    if (createNew) {
        const context = { userIntent: query, baseRecipeId,
            originalRecipe: (candidates || []).map(recipe => ({ recipeId: recipe.recipeId, title: recipe.title, baseServings: recipe.baseServings, ingredients: (recipe.ingredients || []).map(toPublicIngredient), steps: recipe.steps })) };
        return [
            'Bạn là Cappy, đầu bếp hướng dẫn công thức phổ biến, đầy đủ và thực tế. Trả đúng một object JSON, không markdown.',
            'Tạo đúng món được yêu cầu; nếu có originalRecipe, dùng món gốc để hiểu yêu cầu thay đổi. Không cần giữ nhóm chế biến trong luồng tạo món khác.',
            'Không có dữ liệu kho trong nhiệm vụ này. Không tối giản hay thay nguyên liệu để phù hợp kho. Backend đối chiếu kho sau khi tạo công thức.',
            'Mì và mỳ là cùng cách viết. Mì cay phải có mì, nước dùng, thành phần tạo vị cay; mì cay hải sản cần hải sản phù hợp (ví dụ tôm, mực). Không gọi món cá và rau không có mì là mì cay.',
            'Không có duy nhất một công thức chuẩn: chọn một phiên bản phổ biến, ghi rõ nguyên liệu, gia vị và định lượng theo khẩu phần. Nước nấu cần có lượng ML; muối/tiêu tùy chọn có thể NONE, amount=0, required=false.',
            'Yêu cầu không liên quan nấu ăn/nguy hiểm/thực phẩm hỏng: REFUSED; thiếu tên món và không có món gốc để hiểu: CLARIFY. Không giả vờ tìm kiếm web.',
            'Nguyên liệu phải là đầu vào thực tế, không liệt kê đồng thời đầu vào và thành phẩm tự làm. Tự ninh nước dùng: ghi xương, hành, gia vị, Nước lọc và hướng dẫn ninh; không ghi nước dùng như món phải mua. Dùng gói nước lẩu/nước lèo: ghi rõ gói sản phẩm, lượng dùng và nước lọc để pha. Tự luộc cua: ghi cua nguyên liệu và bước luộc/gỡ thịt; chỉ ghi thịt cua sơ chế đóng gói nếu chọn mua sản phẩm đó, không mua trùng cả hai.',
            'Mỗi ingredient có role=MAIN/SECONDARY/SEASONING và purchaseRequired=true/false. Vai trò độc lập với required (cần đối chiếu kho). Nguyên liệu phụ/gia vị vẫn có thể cần mua. Nước lọc: purchaseRequired=false, required=false, giữ amount và unit ML/L để hướng dẫn nấu; mọi thực phẩm/gia vị/gói nước lẩu: purchaseRequired=true. Không tự coi gia vị là đã có trong nhà.',
            'Thành công mode=CREATE_NEW, baseRecipeIds=[]; recipe có title,description,dishType(MAIN/SIDE/SOUP/DRINK/DESSERT/SNACK),cookingTimeMinutes,baseServings,ingredients,steps.',
            'ingredients là array {name,amount,unit(G/KG/ML/L/PIECE/NONE),required,role,purchaseRequired}; có nguyên liệu chính required=true với amount>0. steps là array 4–8 chuỗi hướng dẫn sơ chế, mức lửa, thời gian và dấu hiệu chín. reasoning tối đa 2 câu.',
            'Output {mode,baseRecipeIds,reasoning,changes,recipe}; mode thuộc CREATE_NEW,REFUSED,CLARIFY. Khi từ chối hoặc cần làm rõ recipe=null.',
            `CONTEXT=${JSON.stringify(context)}`
        ].join('\n');
    }
    const context = {
        userIntent: query,
        createNew, randomVariant,
        baseRecipeId,
        avoidRecipeIds: excludedRecipeIds,
        generatedAt: now.toISOString(),
        inventory: toInventoryContext(inventory, now),
        retrievedRecipes: toCandidateContext(candidates, inventory)
    };
    const examples = RECIPE_RAG_FEW_SHOT_EXAMPLES.map(example => ({
        userIntent: example.userIntent,
        expectedOutput: example.expected
    }));
    return [
        'Bạn là Cappy, đầu bếp hướng dẫn nấu ăn thực tế cho sinh viên. Trả JSON, không markdown.',
        'Đánh giá yêu cầu trước: nếu không liên quan nấu ăn, nguy hiểm, thực phẩm hỏng hoặc bất hợp pháp, trả mode REFUSED với lý do, recipe=null. Nếu tên món quá mơ hồ, trả CLARIFY.',
        'Nếu createNew=true: tạo đúng món userIntent theo kiến thức nấu ăn, không giả vờ đã tìm trên mạng. Không ép nguyên liệu theo kho; trả ADAPT_EXISTING, baseRecipeIds=[].',
        'Thêm sốt cay/chấm/rưới là tinh luyện hợp lệ: giữ cách chế biến nền và nguyên liệu chính, thêm nguyên liệu/các bước làm sốt. Giữ chính xác tên nguyên liệu chính của món gốc. Ví dụ nấm chiên giòn kèm sốt cay, không bỏ nấm.',
        'Nếu createNew=false: giữ bản chất món, dùng đúng công thức gốc trong retrievedRecipes làm RAG, giữ nguyên liệu chính và nhóm chế biến. Chỉnh khẩu vị hoặc tạo biến thể gần; đổi món khác trả CLARIFY. Không bỏ nguyên liệu bắt buộc chỉ vì thiếu trong kho.',
        'Nếu randomVariant=true: tạo biến thể gần sử dụng nguyên liệu trong kho; nếu không làm được thì trả NEED_SHOPPING, không tự đổi sang món khác.',
        'Nguyên liệu phải là đầu vào thực tế, không liệt kê đồng thời đầu vào và thành phẩm tự làm. Tự ninh nước dùng: ghi xương, hành, gia vị, Nước lọc và hướng dẫn ninh; không ghi nước dùng như món phải mua. Dùng gói nước lẩu/nước lèo: ghi rõ gói sản phẩm, lượng dùng và nước lọc để pha. Tự luộc cua: ghi cua nguyên liệu và bước luộc/gỡ thịt; chỉ ghi thịt cua sơ chế đóng gói nếu chọn mua sản phẩm đó, không mua trùng cả hai.',
        'Mỗi ingredient có role=MAIN/SECONDARY/SEASONING và purchaseRequired=true/false. Vai trò độc lập với required (cần đối chiếu kho). Nguyên liệu phụ/gia vị vẫn có thể cần mua. Nước lọc: purchaseRequired=false, required=false, giữ amount và unit ML/L để hướng dẫn nấu; mọi thực phẩm/gia vị/gói nước lẩu: purchaseRequired=true. Không tự coi gia vị là đã có trong nhà.',
        'Giữ gia vị và hướng dẫn cần thiết. Gia vị tùy chọn dùng vừa đủ có amount=0, unit=NONE, required=false. Dầu để chiên và nguyên liệu quyết định món phải định lượng và required=true.',
        'Tên món, lời giải thích, nguyên liệu và các bước phải nhất quán; không nói giữ nguyên nguyên liệu rồi bỏ nó khỏi danh sách. Không tự thay cá khác loài/phần. Không dùng nguyên liệu hết hạn.',
        'Viết 4–8 bước thực hiện rõ sơ chế, mức lửa, thời gian và dấu hiệu chín hợp lý; không khẳng định lợi ích điều trị/dinh dưỡng chưa có căn cứ.',
        'reasoning tối đa 2 câu, changes tối đa 4 câu. Output {mode,baseRecipeIds,reasoning,changes,recipe}. mode thuộc ADAPT_EXISTING,NEED_SHOPPING,REFUSED,CLARIFY.',
        'recipe có title,description,dishType (MAIN/SIDE/SOUP/DRINK/DESSERT/SNACK),cookingTimeMinutes,baseServings,ingredients,steps. Ingredient: name,amount,unit(G/KG/ML/L/PIECE/NONE),required,role,purchaseRequired. Nước lọc luôn required=false,purchaseRequired=false. Có ít nhất một required=true,amount>0.',
        'baseRecipeIds khi tinh luyện phải gồm baseRecipeId, không bịa ID. Kho là dữ liệu đối chiếu, không phải mọi nguyên liệu tham khảo đều có sẵn.',
        'Ví dụ chỉ minh họa cấu trúc, không phải dữ liệu kho hoặc nguồn để bịa thêm nguyên liệu.',
        `FEW_SHOT_EXAMPLES=${JSON.stringify(examples)}`,
        `CONTEXT=${JSON.stringify(context)}`
    ].join('\n');
}

function parseRagJson(text) {
    const normalized = String(text || '')
        .replace(/^\s*```(?:json)?\s*/iu, '')
        .replace(/\s*```\s*$/u, '')
        .trim();
    if (!normalized) throw ragError('AI không trả nội dung.', 'AI_EMPTY_RESPONSE');
    try {
        return JSON.parse(normalized);
    } catch (_) {
        throw ragError('AI trả dữ liệu không phải JSON hợp lệ.', 'AI_INVALID_JSON');
    }
}

function validateRagEnvelope(value, candidates, baseRecipeId = null, createNew = false) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw ragError('Phản hồi phải là một object JSON.', 'AI_INVALID_ENVELOPE');
    }
    const rawMode = String(value.mode || '').trim().toUpperCase();
    const mode = createNew && rawMode === 'CREATE_NEW' ? 'ADAPT_EXISTING' : rawMode;
    if (!['ADAPT_EXISTING', 'NEED_SHOPPING', 'REFUSED', 'CLARIFY'].includes(mode)) {
        throw ragError('mode phản hồi không hợp lệ.', 'AI_INVALID_MODE');
    }
    const candidateIds = new Set((candidates || []).map(recipe => String(recipe.recipeId)));
    const baseRecipeIds = [...new Set((Array.isArray(value.baseRecipeIds) ? value.baseRecipeIds : [])
        .map(id => String(id || '').trim())
        .filter(Boolean))];
    if (baseRecipeIds.some(id => !candidateIds.has(id))) {
        throw ragError('RAG tham chiếu công thức ngoài tập truy xuất.', 'RAG_UNGROUNDED_PROVENANCE');
    }
    if (mode === 'ADAPT_EXISTING' && !createNew && baseRecipeIds.length === 0) {
        throw ragError('RAG phải nêu công thức tham chiếu khi điều chỉnh.', 'RAG_MISSING_PROVENANCE');
    }
    if (mode === 'ADAPT_EXISTING' && !createNew && baseRecipeId && !baseRecipeIds.includes(baseRecipeId)) {
        throw ragError('Cappy không điều chỉnh đúng công thức đã chọn.', 'RAG_BASE_RECIPE_MISMATCH');
    }
    if (mode === 'ADAPT_EXISTING' && (!value.recipe || typeof value.recipe !== 'object' || Array.isArray(value.recipe))) {
        throw ragError('AI thiếu object công thức.', 'AI_MISSING_RECIPE');
    }
    return {
        mode,
        changes: (Array.isArray(value.changes) ? value.changes : []).filter(entry => typeof entry === 'string').slice(0, 6).map(entry => compactText(entry, 200)),
        baseRecipeIds,
        reasoning: String(value.reasoning || '').normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, 600),
        recipe: mode === 'ADAPT_EXISTING' ? value.recipe : null
    };
}

function fishReplacementClarification(query, baseRecipe, inventory) {
    if (!/thay.*cá.*khác/iu.test(query)) return null;
    const originalNames = new Set((baseRecipe.ingredients || []).map(i => String(i.name || '').trim().toLocaleLowerCase('vi-VN')));
    const alternatives = [...new Set(inventory.map(item => String(item.itemName || '').trim())
        .filter(name => /cá\s/iu.test(name) && !originalNames.has(name.toLocaleLowerCase('vi-VN'))))].slice(0, 6);
    if (alternatives.some(name => query.toLocaleLowerCase('vi-VN').includes(name.toLocaleLowerCase('vi-VN')))) return null;
    return {
        type: alternatives.length ? 'NEED_CLARIFICATION' : 'NEED_SHOPPING',
        reasoning: alternatives.length ? 'Bạn muốn thay bằng loại cá nào đang có trong kho? Chọn bên dưới rồi gửi lại; lượng khả dụng sẽ được kiểm tra sau.' : 'Chưa thấy loại cá khác trong kho để thay. Bạn có thể bổ sung cá hoặc giữ nguyên công thức.',
        options: alternatives
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
    fishReplacementClarification,
    uniqueByRecipeId,
    validateRagEnvelope
};
