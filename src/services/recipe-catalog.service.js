'use strict';

const PUBLIC_RECIPE_FIELDS = Object.freeze([
    'recipeId',
    'title',
    'description',
    'imageUrl',
    'sourceUrl',
    'dishType',
    'cookingTimeMinutes',
    'baseServings',
    'ingredients',
    'steps',
    'tags',
    'source'
]);

const DISH_TYPES = new Set(['MAIN', 'SIDE', 'SOUP', 'DRINK', 'DESSERT', 'SNACK']);

// File import mới không có status. Điều kiện thứ hai giúp 349 recipe đó hiển thị
// ngay, trong khi vẫn đọc an toàn các AI draft/recipe legacy còn status.
const VISIBLE_RECIPE_CLAUSE = Object.freeze({
    $or: [
        { status: { $in: ['ACTIVE', 'TEST'] } },
        { status: { $exists: false } }
    ]
});

function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseOptionalPositiveNumber(value, fieldName) {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        const error = new Error(`${fieldName} phải là số lớn hơn 0.`);
        error.code = 'INVALID_RECIPE_FILTER';
        throw error;
    }
    return parsed;
}

function buildRecipeFilter({ query, dishType, maxCookingTime } = {}) {
    const clauses = [VISIBLE_RECIPE_CLAUSE];
    if (dishType) {
        const normalizedDishType = String(dishType).trim().toUpperCase();
        if (!DISH_TYPES.has(normalizedDishType)) {
            const error = new Error('dishType không hợp lệ.');
            error.code = 'INVALID_RECIPE_FILTER';
            throw error;
        }
        clauses.push({ dishType: normalizedDishType });
    }
    const cookingTimeLimit = parseOptionalPositiveNumber(maxCookingTime, 'maxCookingTime');
    if (cookingTimeLimit !== null) {
        clauses.push({ cookingTimeMinutes: { $lte: cookingTimeLimit } });
    }
    if (query && String(query).trim()) {
        const normalizedQuery = String(query).trim();
        if (normalizedQuery.length > 300) {
            const error = new Error('query không được dài quá 300 ký tự.');
            error.code = 'INVALID_RECIPE_FILTER';
            throw error;
        }
        const text = new RegExp(escapeRegExp(normalizedQuery), 'i');
        clauses.push({
            $or: [
                { title: text },
                { description: text },
                { tags: text },
                { 'ingredients.name': text },
                // Chỉ để đọc tương thích catalog cũ trong giai đoạn chuyển đổi.
                { aliases: text },
                { searchText: text },
                { 'ingredients.canonicalName': text },
                { 'ingredients.itemName': text }
            ]
        });
    }
    return clauses.length === 1 ? clauses[0] : { $and: clauses };
}

function publicRecipeProjection() {
    return Object.fromEntries([
        ...PUBLIC_RECIPE_FIELDS.map(field => [field, 1]),
        ['_id', 0]
    ]);
}

function toPublicIngredient(ingredient = {}) {
    return {
        name: ingredient.name || ingredient.canonicalName || ingredient.itemName || '',
        amount: Number(ingredient.amount) || 0,
        unit: String(ingredient.unit || 'NONE').toUpperCase(),
        required: Boolean(ingredient.required ?? ingredient.isCore)
    };
}

function toPublicRecipe(recipeInput) {
    const recipe = typeof recipeInput?.toObject === 'function'
        ? recipeInput.toObject()
        : (recipeInput || {});
    const output = Object.fromEntries(PUBLIC_RECIPE_FIELDS
        .filter(field => recipe[field] !== undefined)
        .map(field => [field, recipe[field]]));
    if (Array.isArray(output.ingredients)) {
        output.ingredients = output.ingredients.map(toPublicIngredient);
    }
    if (Array.isArray(output.steps)) {
        output.steps = output.steps
            .map(step => typeof step === 'string' ? step : step?.instruction)
            .filter(Boolean);
    }
    return output;
}

module.exports = {
    DISH_TYPES,
    PUBLIC_RECIPE_FIELDS,
    VISIBLE_RECIPE_CLAUSE,
    buildRecipeFilter,
    publicRecipeProjection,
    toPublicIngredient,
    toPublicRecipe
};
