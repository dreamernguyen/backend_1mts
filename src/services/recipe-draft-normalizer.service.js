'use strict';

const { canonicalizeName } = require('./recipe-matching.service');
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
        const presenceOnly = unit === 'NONE' && amount === 0 && !(item.required ?? item.isCore);
        if (!name || !Number.isFinite(amount) || (!presenceOnly && (amount <= 0 || !VALID_UNITS.has(unit)))) {
            throw validationError(`Nguyên liệu AI thứ ${index + 1} không hợp lệ.`);
        }
        const identity = canonicalizeName(name);
        const water = /^(nuoc loc|nuoc sach|nuoc uong)$/.test(identity);
        const role = item.role == null ? null : String(item.role).toUpperCase();
        if (role && !['MAIN', 'SECONDARY', 'SEASONING'].includes(role)) throw validationError('Vai trò nguyên liệu không hợp lệ.');
        if (item.purchaseRequired != null && typeof item.purchaseRequired !== 'boolean') throw validationError('purchaseRequired phải là boolean.');
        // Plain water is an instruction quantity, never stock or a shopping item.
        // Normalize these flags deterministically; do not exempt any food.
        const purchaseRequired = water ? false : item.purchaseRequired ?? true;
        if (!purchaseRequired && !water) throw validationError('Thực phẩm và gia vị vẫn cần đối chiếu kho hoặc đưa vào đi chợ.');
        if (/^nuoc (dung|leo|luoc)/.test(identity) && !/goi|dong goi|hop|chai/.test(identity)) throw validationError('Cần liệt kê nguyên liệu nấu nước dùng hoặc gói nước dùng mua được, không liệt kê thành phẩm tự nấu.');
        if (/thit cua.*luoc san/.test(identity) && !/dong goi|hop|mua san/.test(identity)) throw validationError('Cần ghi cua nguyên liệu hoặc thịt cua sơ chế đóng gói, không ghi chung chung thịt cua luộc sẵn.');
        const requestedScalingMode = compact(item?.scalingMode).toUpperCase();
        const hasRequestedScalingMode = ['PROPORTIONAL', 'WHOLE_UNIT', 'FIXED_MINIMUM', 'NON_SCALABLE'].includes(requestedScalingMode);
        const scalingMode = hasRequestedScalingMode
            ? requestedScalingMode
            : unit === 'PIECE' ? 'WHOLE_UNIT' : null;
        const wholeUnitStep = Number(item?.wholeUnitStep);
        return {
            name,
            ...(item.purchaseRequired != null || water ? { purchaseRequired } : {}),
            ...(role ? { role } : {}),
            amount,
            unit,
            required: water ? false : Boolean(item?.required ?? item?.isCore),
            ...(scalingMode ? {
                scalingMode,
                wholeUnitStep: scalingMode === 'WHOLE_UNIT' && Number.isFinite(wholeUnitStep) && wholeUnitStep > 0
                    ? wholeUnitStep
                    : scalingMode === 'WHOLE_UNIT' ? 1 : null
            } : {})
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
