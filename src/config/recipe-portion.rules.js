'use strict';

const PORTION_STANDARDS = Object.freeze({
    ANIMAL_PROTEIN: Object.freeze({
        label: 'cá, thịt và hải sản',
        minGrams: 150,
        targetMaxGrams: 200
    }),
    VEGETABLE_MAIN: Object.freeze({
        label: 'rau củ của món chay hoặc món rau chính',
        minGrams: 100,
        targetMaxGrams: 150
    })
});

const ANIMAL_PROTEIN_PATTERN = /\b(ca|tom|thit|ga|bo|heo|lon|muc|luon|cua|ghe|ngan|vit|chim|suon|hai san|cha ca)\b/;
const NON_FISH_CA_PATTERN = /\bca (chua|rot|phao|tim|na|bong)\b/;
const NON_ANIMAL_FOOD_PATTERN = /\b(nam dui ga|dau bo|bo lat|bo tuoi|bo thuc vat|banh trang bo bia|suon chay|thit chay|ga chay|ca chay|trung ga|trung cut|trung ca|mo heo|mo ga)\b/;
const SECONDARY_PROTEIN_PATTERN = /\b(tom kho|ca kho|muc kho|kho muc|thit kho|bo kho|cha bong|thit nguoi|xong khoi|thit muoi|bot thit|thanh cua)\b/;
const NON_MAIN_DISH_TITLE_PATTERN = /\b(snack|goi|salad)\b/;
const PORTION_RULE_DISH_TYPES = new Set(['MAIN', 'SOUP']);
const VEGETABLE_PATTERN = /\b(rau|cu|cai|ca chua|bi|bau|muop|nam|bon bon|bong|dau bap|dau que|kho qua|mang|su hao|ca rot)\b/;
const SECONDARY_VEGETABLE_PATTERN = /\b(bot|sot|nuoc|hat nem|gia vi|dau an)\b/;
const PRESERVED_FOOD_PATTERN = /\b(muoi|ngam)\b/;

const ANIMAL_TITLE_GROUPS = Object.freeze([
    Object.freeze({ ingredient: /\b(ca|cha ca)\b/, title: /\b(ca|cha ca)\b/ }),
    Object.freeze({ ingredient: /\btom\b/, title: /\btom\b/ }),
    Object.freeze({ ingredient: /\b(bo|thit bo)\b/, title: /\b(bo|bit tet)\b/ }),
    Object.freeze({ ingredient: /\b(heo|lon|thit heo|thit lon|suon)\b/, title: /\b(heo|lon|thit|suon)\b/ }),
    Object.freeze({ ingredient: /\b(ga|thit ga)\b/, title: /\b(ga|thit ga)\b/ }),
    Object.freeze({ ingredient: /\bmuc\b/, title: /\bmuc\b/ }),
    Object.freeze({ ingredient: /\bluon\b/, title: /\bluon\b/ }),
    Object.freeze({ ingredient: /\b(cua|ghe)\b/, title: /\b(cua|ghe)\b/ }),
    Object.freeze({ ingredient: /\b(ngan|vit)\b/, title: /\b(ngan|vit)\b/ }),
    Object.freeze({ ingredient: /\bchim\b/, title: /\bchim\b/ }),
    Object.freeze({ ingredient: /\bhai san\b/, title: /\bhai san\b/ }),
    Object.freeze({ ingredient: /\bthit\b/, title: /\bthit\b/ })
]);

function foldIngredientName(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/gi, 'd')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function ingredientName(ingredient) {
    return ingredient?.name || ingredient?.canonicalName || ingredient?.itemName || '';
}

function isVegetarianTitle(value) {
    const title = String(value || '').normalize('NFC').toLowerCase();
    return /(^|[\s(])chay(?=$|[\s)])/u.test(title);
}

function gramsOf(ingredient) {
    const amount = Number(ingredient?.amount);
    const unit = String(ingredient?.unit || '').toUpperCase();
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    if (unit === 'G') return amount;
    if (unit === 'KG') return amount * 1000;
    return 0;
}

function classifyPortionGroup(ingredient) {
    const name = foldIngredientName(ingredientName(ingredient));
    if (
        ANIMAL_PROTEIN_PATTERN.test(name)
        && !NON_FISH_CA_PATTERN.test(name)
        && !NON_ANIMAL_FOOD_PATTERN.test(name)
    ) {
        return 'ANIMAL_PROTEIN';
    }
    if (VEGETABLE_PATTERN.test(name)) return 'VEGETABLE_MAIN';
    return null;
}

function isRequiredIngredient(ingredient) {
    return Boolean(ingredient?.required ?? ingredient?.isCore);
}

function isPrimaryAnimalProtein(ingredient, context = {}) {
    if (classifyPortionGroup(ingredient) !== 'ANIMAL_PROTEIN') return false;
    if (!isRequiredIngredient(ingredient)) return false;
    const name = foldIngredientName(ingredientName(ingredient));
    const title = foldIngredientName(context.title);
    const dishType = String(context.dishType || '').toUpperCase();
    if (
        !title
        || (dishType && !PORTION_RULE_DISH_TYPES.has(dishType))
        || NON_MAIN_DISH_TITLE_PATTERN.test(title)
        || SECONDARY_PROTEIN_PATTERN.test(name)
    ) return false;
    return ANIMAL_TITLE_GROUPS.some(group => group.ingredient.test(name) && group.title.test(title));
}

function isAnimalProteinCandidate(ingredient) {
    if (classifyPortionGroup(ingredient) !== 'ANIMAL_PROTEIN' || !isRequiredIngredient(ingredient)) {
        return false;
    }
    return !SECONDARY_PROTEIN_PATTERN.test(foldIngredientName(ingredientName(ingredient)));
}

function primaryAnimalProteinIndexes(ingredients, context = {}) {
    const dishType = String(context.dishType || '').toUpperCase();
    const title = foldIngredientName(context.title);
    if (
        (dishType && !PORTION_RULE_DISH_TYPES.has(dishType))
        || NON_MAIN_DISH_TITLE_PATTERN.test(title)
    ) return [];

    const candidates = (ingredients || [])
        .map((ingredient, index) => ({ ingredient, index }))
        .filter(({ ingredient }) => isAnimalProteinCandidate(ingredient));
    const namedInTitle = candidates
        .filter(({ ingredient }) => isPrimaryAnimalProtein(ingredient, context));
    if (namedInTitle.length > 0) return namedInTitle.map(item => item.index);
    return dishType === 'SOUP' && candidates.length === 1 ? [candidates[0].index] : [];
}

function primaryAnimalProteinTotal(ingredients, context = {}) {
    const indexes = new Set(primaryAnimalProteinIndexes(ingredients, context));
    return (ingredients || []).reduce(
        (sum, ingredient, index) => sum + (indexes.has(index) ? gramsOf(ingredient) : 0),
        0
    );
}

function portionTotals(ingredients) {
    const totals = { ANIMAL_PROTEIN: 0, VEGETABLE_MAIN: 0 };
    for (const ingredient of ingredients || []) {
        const group = classifyPortionGroup(ingredient);
        if (group) totals[group] += gramsOf(ingredient);
    }
    return totals;
}

function deriveBaseServings(ingredients, fallbackServings = 1, overrides = {}) {
    const totals = portionTotals(ingredients);
    const primaryProteinG = primaryAnimalProteinTotal(ingredients, overrides);
    const hasAnimalIngredient = (ingredients || []).some(
        ingredient => classifyPortionGroup(ingredient) === 'ANIMAL_PROTEIN'
    );
    const preservedFood = PRESERVED_FOOD_PATTERN.test(foldIngredientName(overrides.title));
    const proteinMin = Number(overrides.proteinMinG)
        || PORTION_STANDARDS.ANIMAL_PROTEIN.minGrams;
    const vegetableMin = Number(overrides.vegetableMinG)
        || PORTION_STANDARDS.VEGETABLE_MAIN.minGrams;
    let basis = 'DECLARED_SERVINGS';
    let baseServings = Math.max(1, Math.round(Number(fallbackServings) || 1));

    if (primaryProteinG > 0) {
        basis = 'PRIMARY_ANIMAL_PROTEIN';
        baseServings = Math.max(1, Math.floor(primaryProteinG / proteinMin));
    } else if (!hasAnimalIngredient && !preservedFood && totals.VEGETABLE_MAIN > 0) {
        basis = 'VEGETABLE_MAIN';
        baseServings = Math.max(1, Math.floor(totals.VEGETABLE_MAIN / vegetableMin));
    }

    return {
        baseServings,
        basis,
        totals,
        primaryProteinG,
        hasAnimalIngredient,
        preservedFood,
        gramsPerServing: {
            animalProtein: Number((primaryProteinG / baseServings).toFixed(2)),
            vegetable: Number((totals.VEGETABLE_MAIN / baseServings).toFixed(2))
        }
    };
}

function validateMinimumPortion(ingredients, baseServings, overrides = {}) {
    const derived = deriveBaseServings(ingredients, baseServings, overrides);
    const proteinMin = Number(overrides.proteinMinG)
        || PORTION_STANDARDS.ANIMAL_PROTEIN.minGrams;
    const vegetableMin = Number(overrides.vegetableMinG)
        || PORTION_STANDARDS.VEGETABLE_MAIN.minGrams;
    const violations = [];
    if (
        derived.primaryProteinG > 0
        && derived.gramsPerServing.animalProtein < proteinMin
    ) {
        violations.push('ANIMAL_PROTEIN_BELOW_MINIMUM');
    } else if (
        derived.primaryProteinG === 0
        && derived.totals.VEGETABLE_MAIN > 0
        && derived.gramsPerServing.vegetable < vegetableMin
    ) {
        violations.push('VEGETABLE_MAIN_BELOW_MINIMUM');
    }
    return { ...derived, violations };
}

function ensureMinimumPrimaryProtein(recipe, overrides = {}) {
    const proteinMin = Number(overrides.proteinMinG)
        || PORTION_STANDARDS.ANIMAL_PROTEIN.minGrams;
    const context = { ...overrides, title: recipe?.title, dishType: recipe?.dishType };
    const primaryIndexes = primaryAnimalProteinIndexes(recipe?.ingredients, context)
        .map(index => ({ ingredient: recipe.ingredients[index], index }))
        .filter(({ ingredient }) => gramsOf(ingredient) > 0);
    const currentTotalG = primaryIndexes.reduce((sum, item) => sum + gramsOf(item.ingredient), 0);
    if (currentTotalG <= 0 || currentTotalG >= proteinMin) {
        return { ingredients: (recipe?.ingredients || []).map(item => ({ ...item })), adjustment: null };
    }

    const scale = proteinMin / currentTotalG;
    const primaryIndexSet = new Set(primaryIndexes.map(item => item.index));
    const ingredients = (recipe.ingredients || []).map((ingredient, index) => {
        if (!primaryIndexSet.has(index)) return { ...ingredient };
        const unit = String(ingredient.unit || '').toUpperCase();
        const scaledGrams = gramsOf(ingredient) * scale;
        const amount = unit === 'KG' ? scaledGrams / 1000 : scaledGrams;
        return { ...ingredient, amount: Number(amount.toFixed(2)) };
    });
    return {
        ingredients,
        adjustment: {
            code: 'PRIMARY_PROTEIN_RAISED_TO_MINIMUM',
            previousTotalG: Number(currentTotalG.toFixed(2)),
            normalizedTotalG: proteinMin,
            ingredients: primaryIndexes.map(item => ingredientName(item.ingredient))
        }
    };
}

function ensureMinimumPrimaryVegetable(recipe, overrides = {}) {
    const vegetableMin = Number(overrides.vegetableMinG)
        || PORTION_STANDARDS.VEGETABLE_MAIN.minGrams;
    const dishType = String(recipe?.dishType || '').toUpperCase();
    const title = foldIngredientName(recipe?.title);
    const ingredients = recipe?.ingredients || [];
    if (
        !PORTION_RULE_DISH_TYPES.has(dishType)
        || NON_MAIN_DISH_TITLE_PATTERN.test(title)
        || ingredients.some(isAnimalProteinCandidate)
    ) return { ingredients: ingredients.map(item => ({ ...item })), adjustment: null };

    const candidates = ingredients
        .map((ingredient, index) => ({ ingredient, index }))
        .filter(({ ingredient }) => (
            classifyPortionGroup(ingredient) === 'VEGETABLE_MAIN'
            && isRequiredIngredient(ingredient)
            && gramsOf(ingredient) > 0
            && !SECONDARY_VEGETABLE_PATTERN.test(foldIngredientName(ingredientName(ingredient)))
        ));
    const titleConfirmsVegetable = isVegetarianTitle(recipe?.title) || candidates.some(({ ingredient }) => {
        const significantWords = foldIngredientName(ingredientName(ingredient))
            .split(' ')
            .filter(word => word.length >= 3);
        return significantWords.some(word => new RegExp(`\\b${word}\\b`).test(title));
    });
    const currentTotalG = candidates.reduce((sum, item) => sum + gramsOf(item.ingredient), 0);
    if (!titleConfirmsVegetable || currentTotalG <= 0 || currentTotalG >= vegetableMin) {
        return { ingredients: ingredients.map(item => ({ ...item })), adjustment: null };
    }

    const scale = vegetableMin / currentTotalG;
    const candidateIndexes = new Set(candidates.map(item => item.index));
    return {
        ingredients: ingredients.map((ingredient, index) => {
            if (!candidateIndexes.has(index)) return { ...ingredient };
            const unit = String(ingredient.unit || '').toUpperCase();
            const scaledGrams = gramsOf(ingredient) * scale;
            return {
                ...ingredient,
                amount: Number((unit === 'KG' ? scaledGrams / 1000 : scaledGrams).toFixed(2))
            };
        }),
        adjustment: {
            code: 'PRIMARY_VEGETABLE_RAISED_TO_MINIMUM',
            previousTotalG: Number(currentTotalG.toFixed(2)),
            normalizedTotalG: vegetableMin,
            ingredients: candidates.map(item => ingredientName(item.ingredient))
        }
    };
}

const AI_PORTION_RULES = `
QUY TẮC KHẨU PHẦN BẮT BUỘC:
- Một khẩu phần có cá, thịt hoặc hải sản phải dùng tối thiểu 150g và thường trong khoảng 150-200g tổng nhóm này.
- Món chay hoặc món lấy rau củ làm thành phần chính phải có tối thiểu 100g và thường trong khoảng 100-150g rau củ cho mỗi khẩu phần.
- Các thực phẩm khác điều chỉnh theo loại món và kỹ thuật nấu; không tự bịa phép đổi giữa G, ML và PIECE.
- baseServings phải khớp tổng định lượng. Ví dụ 300g cá = 2 phần, 350g thịt = 2 phần, 600g cá = 4 phần.
- Luôn trả minCookServings=1, servingStep=1 và allowScaleDown=true. Backend sẽ kiểm tra và tính lại trước khi lưu.
`;

module.exports = {
    AI_PORTION_RULES,
    PORTION_STANDARDS,
    classifyPortionGroup,
    deriveBaseServings,
    ensureMinimumPrimaryProtein,
    ensureMinimumPrimaryVegetable,
    foldIngredientName,
    isPrimaryAnimalProtein,
    isVegetarianTitle,
    portionTotals,
    primaryAnimalProteinTotal,
    validateMinimumPortion
};
