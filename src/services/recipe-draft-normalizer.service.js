'use strict';

const VALID_UNITS = new Set(['G', 'KG', 'ML', 'L', 'PIECE']);
const VALID_DISH_TYPES = new Set(['MAIN', 'SIDE', 'SOUP', 'DRINK', 'DESSERT', 'SNACK']);
const {
    deriveBaseServings,
    validateMinimumPortion
} = require('../config/recipe-portion.rules');
const {
    classifyDishType,
    deriveRecipeTags
} = require('../config/recipe-taxonomy.rules');

function compact(value, maxLength) {
    const text = String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim();
    return maxLength ? text.slice(0, maxLength) : text;
}

function validationError(message) {
    const error = new Error(message);
    error.code = 'INVALID_AI_RECIPE';
    error.statusCode = 422;
    return error;
}

function normalizeGeneratedRecipe(input, defaults = {}) {
    const title = compact(input?.title || defaults.title, 160);
    if (!title) throw validationError('Công thức AI thiếu tên món.');

    const ingredients = (input?.ingredients || []).slice(0, 30).map((item, index) => {
        const name = compact(item?.name || item?.itemName || item?.canonicalName, 120);
        const amount = Number(item?.amount);
        const unit = compact(item?.unit).toUpperCase();
        if (!name || !Number.isFinite(amount) || amount <= 0 || !VALID_UNITS.has(unit)) {
            throw validationError(`Nguyên liệu AI thứ ${index + 1} không hợp lệ.`);
        }
        return {
            name,
            amount,
            unit,
            required: Boolean(item?.required ?? item?.isCore)
        };
    });
    if (ingredients.length === 0 || !ingredients.some(item => item.required)) {
        throw validationError('Công thức AI phải có ít nhất một nguyên liệu bắt buộc.');
    }

    const steps = (input?.steps || []).slice(0, 10)
        .map(step => compact(typeof step === 'string' ? step : step?.instruction, 500))
        .filter(Boolean);
    if (steps.length === 0) throw validationError('Công thức AI thiếu bước nấu.');

    const rawDishType = compact(input?.dishType || defaults.dishType || 'MAIN').toUpperCase();
    const requestedDishType = VALID_DISH_TYPES.has(rawDishType) ? rawDishType : 'MAIN';
    const dishType = classifyDishType(
        { title, dishType: requestedDishType },
        { trustExisting: true }
    );
    const rawCookingTime = Number(input?.cookingTimeMinutes)
        || (Number(input?.prepTime) + Number(input?.cookTime))
        || Number(defaults.cookingTimeMinutes)
        || 30;
    const rawBaseServings = Number(input?.baseServings || input?.servings || defaults.baseServings || 1);
    const portionContext = { title, dishType };
    const portion = deriveBaseServings(ingredients, rawBaseServings, portionContext);
    const portionValidation = validateMinimumPortion(
        ingredients,
        portion.baseServings,
        portionContext
    );
    if (portionValidation.violations.length > 0) {
        throw validationError(`Công thức AI không đạt khẩu phần tối thiểu: ${portionValidation.violations.join(', ')}.`);
    }

    const normalized = {
        title,
        description: compact(input?.description || defaults.description, 500),
        imageUrl: compact(input?.imageUrl || defaults.imageUrl, 1000),
        sourceUrl: compact(input?.sourceUrl || defaults.sourceUrl, 1000),
        dishType,
        cookingTimeMinutes: Math.min(Math.max(Math.round(rawCookingTime), 1), 300),
        baseServings: Math.min(Math.max(portion.baseServings, 1), 50),
        minCookServings: 1,
        servingStep: 1,
        allowScaleDown: true,
        ingredients,
        steps,
        tags: []
    };
    return { ...normalized, tags: deriveRecipeTags(normalized) };
}

module.exports = { normalizeGeneratedRecipe };
