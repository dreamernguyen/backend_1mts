const RELATION_SCORE = Object.freeze({
    EXACT: 1,
    EQUIVALENT: 0.95,
    SUBSTITUTE: 0.65,
    RELATED: 0.25,
    REVIEW_REQUIRED: 0,
    NO_MATCH: 0
});

const ACCEPTED_RELATIONS = new Set(['EXACT', 'EQUIVALENT', 'SUBSTITUTE']);
const STANDARD_UNITS = new Set(['G', 'KG', 'ML', 'L', 'PIECE']);
const PACKAGE_WORDS = new Set([
    'khay', 'goi', 'tui', 'hop', 'chai', 'lo', 'vi', 'phan',
    'kg', 'gram', 'g', 'ml', 'lit', 'l'
]);
const ANIMALS = new Set(['gà', 'heo', 'bò', 'vịt', 'ngan', 'cá', 'tôm', 'mực', 'cua']);
const PRIMARY_CUT_PHRASES = Object.freeze([
    'ba rọi', 'sườn non', 'ức', 'đùi', 'cánh', 'má', 'chân', 'đầu', 'sườn', 'thăn'
]);
const NON_ANIMAL_FOOD_PHRASES = Object.freeze([
    'dau ga',
    'nam dui ga'
]);

function normalizeText(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/Đ/g, 'D')
        .toLowerCase()
        .replace(/\([^)]*\)/g, ' ')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\b\d+(?:[.,]\d+)?\b/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .filter(token => !PACKAGE_WORDS.has(token))
        .join(' ');
}

function canonicalizeName(value) {
    return normalizeText(value)
        .replace(/\blon\b/g, 'heo')
        .replace(/\bdoc mung\b/g, 'bac ha')
        .replace(/\bthom\b/g, 'dua')
        .replace(/\bngo ri\b/g, 'rau mui')
        .replace(/\bhanh hoa\b/g, 'hanh la')
        .replace(/\s+/g, ' ')
        .trim();
}

function tokenize(value) {
    return new Set(canonicalizeName(value).split(' ').filter(Boolean));
}

function containsPhrase(value, phrase) {
    return (` ${value} `).includes(` ${phrase} `);
}

function nonAnimalFoodIdentity(value) {
    const normalized = canonicalizeName(value);
    return NON_ANIMAL_FOOD_PHRASES.find(phrase => containsPhrase(normalized, phrase)) || null;
}

function semanticText(value) {
    return String(value || '')
        .normalize('NFC')
        .toLowerCase()
        .replace(/\([^)]*\)/g, ' ')
        .replace(/[^a-z0-9à-ỹđ\s]/gi, ' ')
        .replace(/\blợn\b/g, 'heo')
        .replace(/\s+/g, ' ')
        .trim();
}

function animalSignature(value) {
    if (nonAnimalFoodIdentity(value)) {
        return { animal: null, cuts: [], excludedFoodIdentity: true };
    }
    const normalized = semanticText(value);
    const tokens = normalized.split(' ').filter(Boolean);
    const animal = tokens.find(token => ANIMALS.has(token)) || null;
    const cuts = PRIMARY_CUT_PHRASES.filter(phrase => containsPhrase(normalized, phrase));
    return { animal, cuts, excludedFoodIdentity: false };
}

function hasCategoryConflict(ingredient, inventoryItem) {
    const recipeCategory = String(ingredient.category || '').toUpperCase();
    const inventoryCategory = String(inventoryItem.category || '').toUpperCase();
    if (recipeCategory && recipeCategory !== 'OTHER'
        && inventoryCategory && inventoryCategory !== 'OTHER'
        && recipeCategory !== inventoryCategory) {
        return true;
    }

    const recipeSubCategory = String(ingredient.subCategory || '').toUpperCase();
    const inventorySubCategory = String(inventoryItem.subCategory || '').toUpperCase();
    return Boolean(
        recipeSubCategory && recipeSubCategory !== 'OTHER'
        && inventorySubCategory && inventorySubCategory !== 'OTHER'
        && recipeSubCategory !== inventorySubCategory
    );
}

function substitutionNames(ingredient) {
    return (ingredient.allowedSubstitutions || []).map(substitution => {
        if (typeof substitution === 'string') {
            return { canonicalName: canonicalizeName(substitution), amountFactor: 1 };
        }
        return {
            canonicalName: canonicalizeName(substitution.canonicalName),
            amountFactor: Number(substitution.amountFactor) || 1
        };
    });
}

function classifyIngredientRelation(ingredient, inventoryItem) {
    const recipeName = ingredient.name || ingredient.canonicalName || ingredient.itemName || ingredient.rawName;
    const inventoryName = inventoryItem.itemName || inventoryItem.canonicalName || inventoryItem.rawName;
    const normalizedRecipe = normalizeText(recipeName);
    const normalizedInventory = normalizeText(inventoryName);
    const canonicalRecipe = canonicalizeName(recipeName);
    const canonicalInventory = canonicalizeName(inventoryName);

    if (!canonicalRecipe || !canonicalInventory) {
        return { level: 'REVIEW_REQUIRED', score: 0, amountFactor: 1 };
    }
    if (hasCategoryConflict(ingredient, inventoryItem)) {
        return { level: 'REVIEW_REQUIRED', score: 0, amountFactor: 1 };
    }
    if (normalizedRecipe === normalizedInventory) {
        return { level: 'EXACT', score: RELATION_SCORE.EXACT, amountFactor: 1 };
    }
    if (canonicalRecipe === canonicalInventory) {
        return { level: 'EQUIVALENT', score: RELATION_SCORE.EQUIVALENT, amountFactor: 1 };
    }

    const allowed = substitutionNames(ingredient).find(item => item.canonicalName === canonicalInventory);
    if (allowed) {
        return { level: 'SUBSTITUTE', score: RELATION_SCORE.SUBSTITUTE, amountFactor: allowed.amountFactor };
    }

    const recipeExcludedFood = nonAnimalFoodIdentity(recipeName);
    const inventoryExcludedFood = nonAnimalFoodIdentity(inventoryName);
    if (recipeExcludedFood || inventoryExcludedFood) {
        return {
            level: recipeExcludedFood && recipeExcludedFood === inventoryExcludedFood
                ? 'EQUIVALENT'
                : 'NO_MATCH',
            score: recipeExcludedFood && recipeExcludedFood === inventoryExcludedFood
                ? RELATION_SCORE.EQUIVALENT
                : 0,
            amountFactor: 1
        };
    }

    const recipeSignature = animalSignature(recipeName);
    const inventorySignature = animalSignature(inventoryName);
    if (recipeSignature.animal && recipeSignature.animal === inventorySignature.animal) {
        if (recipeSignature.cuts.length === 0 && inventorySignature.cuts.length > 0) {
            return { level: 'EQUIVALENT', score: RELATION_SCORE.EQUIVALENT, amountFactor: 1 };
        }
        if (recipeSignature.cuts.length > 0 && inventorySignature.cuts.length === 0) {
            return { level: 'REVIEW_REQUIRED', score: 0, amountFactor: 1 };
        }
        if (recipeSignature.cuts.length > 0 && inventorySignature.cuts.length > 0) {
            const inventoryCuts = new Set(inventorySignature.cuts);
            const sameRequiredCut = recipeSignature.cuts.every(cut => inventoryCuts.has(cut));
            return sameRequiredCut
                ? { level: 'EQUIVALENT', score: RELATION_SCORE.EQUIVALENT, amountFactor: 1 }
                : { level: 'RELATED', score: RELATION_SCORE.RELATED, amountFactor: 1 };
        }
        return { level: 'RELATED', score: RELATION_SCORE.RELATED, amountFactor: 1 };
    }

    const recipeTokens = tokenize(recipeName);
    const inventoryTokens = tokenize(inventoryName);
    const sharedTokens = [...recipeTokens].filter(token => token.length > 2 && inventoryTokens.has(token));
    if (sharedTokens.length > 0) {
        return { level: 'RELATED', score: RELATION_SCORE.RELATED, amountFactor: 1 };
    }
    return { level: 'NO_MATCH', score: 0, amountFactor: 1 };
}

function toBaseAmount(amount, unit) {
    const numericAmount = Number(amount);
    const normalizedUnit = String(unit || '').toUpperCase();
    if (!Number.isFinite(numericAmount) || numericAmount < 0 || !STANDARD_UNITS.has(normalizedUnit)) {
        return null;
    }
    if (normalizedUnit === 'KG') return { amount: numericAmount * 1000, unit: 'G', domain: 'MASS' };
    if (normalizedUnit === 'L') return { amount: numericAmount * 1000, unit: 'ML', domain: 'VOLUME' };
    if (normalizedUnit === 'G') return { amount: numericAmount, unit: 'G', domain: 'MASS' };
    if (normalizedUnit === 'ML') return { amount: numericAmount, unit: 'ML', domain: 'VOLUME' };
    return { amount: numericAmount, unit: 'PIECE', domain: 'COUNT' };
}

function isExpired(item, now = new Date()) {
    if (!item.expiryDate || item.expirySource === 'NOT_APPLICABLE') return false;
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const expiry = new Date(item.expiryDate);
    expiry.setHours(23, 59, 59, 999);
    return expiry < today;
}

function usableInventory(items, now = new Date()) {
    return (items || []).filter(item =>
        item.usageStatus === 'ACTIVE'
        && Number(item.quantity) > 0
        && Number(item.standardQuantity) > 0
        && !isExpired(item, now)
    );
}

function scaleIngredientAmount(ingredient, servings, baseServings) {
    const scale = Number(servings) / Number(baseServings);
    const baseAmount = Number(ingredient.amount);
    switch (ingredient.scalingMode || (String(ingredient.unit).toUpperCase() === 'PIECE' ? 'WHOLE_UNIT' : 'PROPORTIONAL')) {
    case 'WHOLE_UNIT': {
        const step = Number(ingredient.wholeUnitStep) || 1;
        return Math.ceil((baseAmount * scale) / step) * step;
    }
    case 'FIXED_MINIMUM':
        return Math.max(baseAmount * scale, Number(ingredient.fixedMinimumAmount) || baseAmount);
    case 'NON_SCALABLE':
        return baseAmount;
    default:
        return baseAmount * scale;
    }
}

function daysRemaining(item, now) {
    if (!item.expiryDate || item.expirySource === 'NOT_APPLICABLE') return null;
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const expiry = new Date(item.expiryDate);
    expiry.setHours(0, 0, 0, 0);
    return Math.ceil((expiry - start) / 86400000);
}

function matchIngredient(ingredient, inventory, now, rescueThresholdDays) {
    const required = toBaseAmount(ingredient.amount, ingredient.unit);
    if (!required) {
        const isRequired = Boolean(ingredient.required ?? ingredient.isCore);
        const isPresenceOnly = !isRequired
            && Number(ingredient.amount) === 0
            && String(ingredient.unit || '').toUpperCase() === 'NONE';
        if (isPresenceOnly) {
            let bestAccepted = null;
            let bestRejected = 'NO_MATCH';
            const matchedBatchIds = [];
            const matchedBatches = [];
            for (const item of inventory) {
                const relation = classifyIngredientRelation(ingredient, item);
                if (!ACCEPTED_RELATIONS.has(relation.level)) {
                    if (RELATION_SCORE[relation.level] > RELATION_SCORE[bestRejected]) {
                        bestRejected = relation.level;
                    }
                    continue;
                }
                if (!bestAccepted || relation.score > bestAccepted.score) bestAccepted = relation;
                if (item._id) {
                    matchedBatchIds.push(String(item._id));
                    matchedBatches.push({
                        batchId: String(item._id),
                        itemName: item.itemName || '',
                        rawName: item.rawName || item.itemName || '',
                        standardQuantity: Number(item.standardQuantity) || 0,
                        standardUnit: item.standardUnit || '',
                        expiryDate: item.expiryDate || null,
                        daysRemaining: daysRemaining(item, now),
                        relation: relation.level
                    });
                }
            }
            return {
                ingredient,
                relation: bestAccepted?.level || bestRejected,
                requiredAmount: 0,
                requiredUnit: 'NONE',
                availableAmount: bestAccepted ? 1 : 0,
                quantityRatio: bestAccepted ? 1 : 0,
                relationScore: bestAccepted?.score || 0,
                matchedBatchIds,
                matchedBatches,
                expiringAvailableAmount: 0,
                reason: bestAccepted
                    ? 'Có nguyên liệu phụ; công thức không yêu cầu định lượng cụ thể.'
                    : 'Không tìm thấy nguyên liệu phụ; công thức không yêu cầu định lượng cụ thể.'
            };
        }
        return {
            ingredient,
            relation: 'REVIEW_REQUIRED',
            requiredAmount: Number(ingredient.amount) || 0,
            requiredUnit: String(ingredient.unit || ''),
            availableAmount: 0,
            quantityRatio: 0,
            relationScore: 0,
            matchedBatchIds: [],
            expiringAvailableAmount: 0,
            reason: 'Đơn vị công thức chưa có quy tắc quy đổi an toàn.'
        };
    }

    let availableAmount = 0;
    let expiringAvailableAmount = 0;
    let bestAccepted = null;
    let bestRejected = 'NO_MATCH';
    const matchedBatchIds = [];
    const matchedBatches = [];

    for (const item of inventory) {
        const relation = classifyIngredientRelation(ingredient, item);
        if (!ACCEPTED_RELATIONS.has(relation.level)) {
            if (RELATION_SCORE[relation.level] > RELATION_SCORE[bestRejected]) bestRejected = relation.level;
            continue;
        }
        const available = toBaseAmount(item.standardQuantity, item.standardUnit);
        if (!available || available.domain !== required.domain) {
            bestRejected = 'REVIEW_REQUIRED';
            continue;
        }
        const effectiveAmount = available.amount / relation.amountFactor;
        availableAmount += effectiveAmount;
        const remainingDays = daysRemaining(item, now);
        if (remainingDays !== null && remainingDays >= 0 && remainingDays <= rescueThresholdDays) {
            expiringAvailableAmount += effectiveAmount;
        }
        if (item._id) {
            matchedBatchIds.push(String(item._id));
            matchedBatches.push({
                batchId: String(item._id),
                itemName: item.itemName || '',
                rawName: item.rawName || item.itemName || '',
                standardQuantity: Number(item.standardQuantity) || 0,
                standardUnit: item.standardUnit || '',
                expiryDate: item.expiryDate || null,
                daysRemaining: remainingDays,
                relation: relation.level
            });
        }
        if (!bestAccepted || relation.score > bestAccepted.score) bestAccepted = relation;
    }

    const relation = bestAccepted?.level || bestRejected;
    const relationScore = bestAccepted?.score || 0;
    const quantityRatio = required.amount > 0 ? Math.min(availableAmount / required.amount, 1) : 1;
    return {
        ingredient,
        relation,
        requiredAmount: required.amount,
        requiredUnit: required.unit,
        availableAmount,
        quantityRatio,
        relationScore,
        matchedBatchIds,
        matchedBatches,
        expiringAvailableAmount,
        reason: bestAccepted
            ? (quantityRatio >= 1 ? 'Đủ định lượng.' : 'Có nguyên liệu nhưng chưa đủ định lượng.')
            : (relation === 'RELATED'
                ? 'Chỉ tìm thấy nguyên liệu liên quan, không tự động coi là tương đương.'
                : relation === 'REVIEW_REQUIRED'
                    ? 'Cần kiểm tra tên hoặc đơn vị trước khi kết luận.'
                    : 'Không tìm thấy nguyên liệu phù hợp.')
    };
}

function normalizeServings(rawServings, step) {
    if (!Number.isFinite(rawServings) || rawServings <= 0) return 0;
    const normalized = Math.floor((rawServings + Number.EPSILON) / step) * step;
    return Number(normalized.toFixed(2));
}

function resolveRequestedServings(recipe, rawServings) {
    const baseServings = Number(recipe.baseServings || recipe.servings || 1);
    const minCookServings = Number(recipe.minCookServings || 1);
    const servingStep = Number(recipe.servingStep || 1);
    const servings = rawServings === undefined || rawServings === null
        ? minCookServings
        : Number(rawServings);
    const alignedServings = normalizeServings(servings, servingStep);
    if (
        !Number.isFinite(servings)
        || servings < minCookServings
        || Math.abs(alignedServings - servings) > 1e-8
        || (recipe.allowScaleDown === false && servings < baseServings)
    ) {
        const error = new Error('Số khẩu phần không hợp lệ theo mẻ nấu tối thiểu.');
        error.code = 'INVALID_SERVINGS';
        throw error;
    }
    return servings;
}

function analyzeRecipe(recipeInput, items, options = {}) {
    const recipe = typeof recipeInput.toObject === 'function' ? recipeInput.toObject() : recipeInput;
    const now = options.now || new Date();
    const rescueThresholdDays = Number(options.rescueThresholdDays) || 7;
    const baseServings = Number(recipe.baseServings || recipe.servings || 1);
    const minCookServings = Number(recipe.minCookServings || 1);
    const servingStep = Number(recipe.servingStep || 1);
    const inventory = usableInventory(items, now);
    const ingredientMatches = (recipe.ingredients || []).map(ingredient =>
        matchIngredient(ingredient, inventory, now, rescueThresholdDays)
    );

    const coreMatches = ingredientMatches.filter(match => match.ingredient.required ?? match.ingredient.isCore);
    let rawFeasibleServings = baseServings;
    if (coreMatches.length > 0) {
        rawFeasibleServings = Math.min(...coreMatches.map(match => {
            if (!ACCEPTED_RELATIONS.has(match.relation) || match.requiredAmount <= 0) return 0;
            return baseServings * (match.availableAmount / match.requiredAmount);
        }));
    }
    if (recipe.allowScaleDown === false && rawFeasibleServings < baseServings) {
        rawFeasibleServings = 0;
    }
    const feasibleServings = normalizeServings(rawFeasibleServings, servingStep);
    const canCook = feasibleServings >= minCookServings
        && coreMatches.every(match => ACCEPTED_RELATIONS.has(match.relation));

    const missingCoreIngredients = coreMatches
        .filter(match => {
            if (!ACCEPTED_RELATIONS.has(match.relation)) return true;
            const requiredAtMinimum = toBaseAmount(
                scaleIngredientAmount(match.ingredient, minCookServings, baseServings),
                match.ingredient.unit
            );
            return !requiredAtMinimum || match.availableAmount < requiredAtMinimum.amount;
        })
        .map(match => match.ingredient);
    const missingOptionalIngredients = ingredientMatches
        .filter(match => !(match.ingredient.required ?? match.ingredient.isCore))
        .filter(match => !ACCEPTED_RELATIONS.has(match.relation) || match.quantityRatio < 1)
        .map(match => match.ingredient);
    const reviewRequiredIngredients = ingredientMatches
        .filter(match => match.relation === 'REVIEW_REQUIRED')
        .map(match => match.ingredient);

    const scoreCoverage = matches => matches.length === 0 ? 0 : matches.reduce(
        (sum, match) => sum + (match.relationScore * match.quantityRatio),
        0
    ) / matches.length;

    const quantifiedOptionalMatches = ingredientMatches.filter(match =>
        !(match.ingredient.required ?? match.ingredient.isCore)
        && match.requiredAmount > 0
        && match.requiredUnit !== 'NONE'
    );
    const presenceOptionalMatches = ingredientMatches.filter(match =>
        !(match.ingredient.required ?? match.ingredient.isCore)
        && (match.requiredAmount <= 0 || match.requiredUnit === 'NONE')
    );

    const coreCoverage = scoreCoverage(coreMatches);
    const optionalCoverageQuantified = scoreCoverage(quantifiedOptionalMatches);
    const optionalCoveragePresence = presenceOptionalMatches.length === 0 ? 0 : presenceOptionalMatches.reduce(
        (sum, match) => sum + (match.relationScore * (ACCEPTED_RELATIONS.has(match.relation) ? 1 : 0)),
        0
    ) / presenceOptionalMatches.length;

    let totalWeight = 0;
    let weightedSum = 0;
    if (coreMatches.length > 0) {
        totalWeight += 0.80;
        weightedSum += 0.80 * coreCoverage;
    }
    if (quantifiedOptionalMatches.length > 0) {
        totalWeight += 0.15;
        weightedSum += 0.15 * optionalCoverageQuantified;
    }
    if (presenceOptionalMatches.length > 0) {
        totalWeight += 0.05;
        weightedSum += 0.05 * optionalCoveragePresence;
    }

    const coverageRatio = totalWeight === 0 ? 0 : weightedSum / totalWeight;
    const ingredientCoveragePercent = Math.round(100 * coverageRatio);

    const rescueWeight = coreMatches.length * 3 + quantifiedOptionalMatches.length;
    const rescueScore = rescueWeight === 0 ? 0 : [
        ...coreMatches.map(match => ({ match, weight: 3 })),
        ...quantifiedOptionalMatches.map(match => ({ match, weight: 1 }))
    ].reduce((sum, { match, weight }) => {
        const rescuedRatio = match.requiredAmount > 0
            ? Math.min(match.expiringAvailableAmount / match.requiredAmount, 1)
            : 0;
        return sum + weight * rescuedRatio;
    }, 0) / rescueWeight;

    const recommendationScore = Number((10 * Math.min(Math.max(0.85 * coverageRatio + 0.15 * rescueScore, 0), 1)).toFixed(1));
    const matchScore = ingredientCoveragePercent;

    const explanations = [];
    if (canCook) explanations.push(`Có thể nấu tối đa ${feasibleServings} khẩu phần.`);
    if (missingCoreIngredients.length > 0) explanations.push(`Thiếu hoặc chưa đủ ${missingCoreIngredients.length} nguyên liệu chính.`);
    if (reviewRequiredIngredients.length > 0) explanations.push(`Có ${reviewRequiredIngredients.length} nguyên liệu cần kiểm tra tên/đơn vị.`);
    if (rescueScore > 0) explanations.push('Công thức dùng được nguyên liệu còn hạn nhưng sắp hết hạn.');

    return {
        canCook,
        ingredientCoveragePercent,
        recommendationScore,
        matchScore,
        feasibleServings,
        baseServings,
        minCookServings,
        missingCoreIngredients,
        missingOptionalIngredients,
        reviewRequiredIngredients,
        explanations,
        inventoryCoverage: Number(coverageRatio.toFixed(4)),
        coreCoverage: Number(coreCoverage.toFixed(4)),
        optionalCoverage: Number(optionalCoverageQuantified.toFixed(4)),
        rescueScore: Number(rescueScore.toFixed(4)),
        rescueBonus: 0,
        usesExpiringIngredients: rescueScore > 0,
        ingredientMatches
    };
}

function buildConsumptionPlan(recipeInput, items, requestedServings, options = {}) {
    const recipe = typeof recipeInput.toObject === 'function' ? recipeInput.toObject() : recipeInput;
    const servings = resolveRequestedServings(recipe, requestedServings);
    const baseServings = Number(recipe.baseServings || recipe.servings || 1);

    const now = options.now || new Date();
    const inventory = usableInventory(items, now);
    const remainingById = new Map(inventory.map(item => [String(item._id), Number(item.standardQuantity)]));
    const planByBatch = new Map();

    for (const ingredient of (recipe.ingredients || []).filter(item => item.required ?? item.isCore)) {
        const scaledAmount = scaleIngredientAmount(ingredient, servings, baseServings);
        const required = toBaseAmount(scaledAmount, ingredient.unit);
        if (!required) {
            const error = new Error(`Không thể quy đổi đơn vị của nguyên liệu ${ingredient.name || ingredient.canonicalName || ingredient.itemName}.`);
            error.code = 'UNIT_REVIEW_REQUIRED';
            throw error;
        }

        const candidates = inventory
            .map(item => ({ item, relation: classifyIngredientRelation(ingredient, item) }))
            .filter(candidate => ACCEPTED_RELATIONS.has(candidate.relation.level))
            .map(candidate => ({
                ...candidate,
                converted: toBaseAmount(remainingById.get(String(candidate.item._id)), candidate.item.standardUnit)
            }))
            .filter(candidate => candidate.converted && candidate.converted.domain === required.domain)
            .sort((a, b) => {
                if (b.relation.score !== a.relation.score) return b.relation.score - a.relation.score;
                const aExpiry = a.item.expiryDate ? new Date(a.item.expiryDate).getTime() : Number.MAX_SAFE_INTEGER;
                const bExpiry = b.item.expiryDate ? new Date(b.item.expiryDate).getTime() : Number.MAX_SAFE_INTEGER;
                return aExpiry - bExpiry;
            });

        let remainingRequired = required.amount;
        for (const candidate of candidates) {
            if (remainingRequired <= 1e-8) break;
            const batchId = String(candidate.item._id);
            const availableOriginal = remainingById.get(batchId) || 0;
            const unitBase = toBaseAmount(1, candidate.item.standardUnit);
            if (!unitBase || availableOriginal <= 0) continue;
            const availableBase = availableOriginal * unitBase.amount;
            const effectiveAvailable = availableBase / candidate.relation.amountFactor;
            const effectiveUsed = Math.min(effectiveAvailable, remainingRequired);
            const actualBaseUsed = effectiveUsed * candidate.relation.amountFactor;
            const actualOriginalUsed = actualBaseUsed / unitBase.amount;
            remainingById.set(batchId, Math.max(availableOriginal - actualOriginalUsed, 0));
            remainingRequired -= effectiveUsed;

            const existingPlan = planByBatch.get(batchId) || {
                batchId,
                standardAmount: 0,
                standardUnit: candidate.item.standardUnit,
                ingredients: []
            };
            existingPlan.standardAmount += actualOriginalUsed;
            existingPlan.ingredients.push({
                canonicalName: ingredient.name || ingredient.canonicalName || ingredient.itemName,
                relation: candidate.relation.level
            });
            planByBatch.set(batchId, existingPlan);
        }

        if (remainingRequired > 1e-8) {
            const error = new Error(`Không đủ nguyên liệu chính: ${ingredient.name || ingredient.canonicalName || ingredient.itemName}.`);
            error.code = 'INSUFFICIENT_CORE_INGREDIENT';
            throw error;
        }
    }

    return {
        requestedServings: servings,
        plan: [...planByBatch.values()].map(entry => ({
            ...entry,
            standardAmount: Number(entry.standardAmount.toFixed(6))
        }))
    };
}

function calculateRemainingBatchAmounts(batch, consumedStandardAmount) {
    const quantity = Number(batch?.quantity);
    const standardQuantity = Number(batch?.standardQuantity);
    const consumed = Number(consumedStandardAmount);
    if (!Number.isFinite(quantity) || !Number.isFinite(standardQuantity)
        || !Number.isFinite(consumed) || quantity < 0 || standardQuantity <= 0 || consumed < 0) {
        return null;
    }
    const remainingStandardQuantity = Math.max(standardQuantity - consumed, 0);
    const remainingRatio = remainingStandardQuantity / standardQuantity;
    return {
        quantity: Number((quantity * remainingRatio).toFixed(6)),
        standardQuantity: Number(remainingStandardQuantity.toFixed(6))
    };
}

function selectTodayRecipe(rankedRecipes, excludedRecipeIds = []) {
    const excluded = new Set(
        excludedRecipeIds
            .map(value => String(value || '').trim())
            .filter(Boolean)
    );
    const cookableRecipes = rankedRecipes.filter(entry => entry?.analysis?.canCook);
    if (cookableRecipes.length === 0) {
        return { entry: null, rotationReset: false };
    }

    const nextEntry = cookableRecipes.find(
        candidate => !excluded.has(String(candidate.recipe?.recipeId || ''))
    );
    return {
        entry: nextEntry || cookableRecipes[0],
        rotationReset: nextEntry == null && excluded.size > 0
    };
}

function formatGroundedAmount(amount, unit) {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return '';
    const rounded = Number(value.toFixed(2));
    const labels = {
        G: 'g',
        ML: 'ml',
        PIECE: 'cái'
    };
    return `${rounded} ${labels[String(unit || '').toUpperCase()] || String(unit || '').toLowerCase()}`.trim();
}

function expiryPhrase(days) {
    if (days === 0) return 'hết hạn hôm nay';
    if (days === 1) return 'ngày mai là hết hạn';
    if (days === 2) return 'ngày mốt là hết hạn';
    return `còn ${days} ngày sử dụng`;
}

function inferUpcomingMeal(now = new Date(), cookingTimeMinutes = 0, timeZone = 'Asia/Ho_Chi_Minh') {
    const formatter = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
    });
    const parts = Object.fromEntries(
        formatter.formatToParts(now).map(part => [part.type, part.value])
    );
    const currentMinutes = (Number(parts.hour) * 60) + Number(parts.minute);
    const safeCookingMinutes = Math.min(
        Math.max(Number(cookingTimeMinutes) || 0, 0),
        240
    );
    const readyAtMinutes = currentMinutes + safeCookingMinutes;

    if (readyAtMinutes <= (9 * 60) + 30) {
        return { code: 'BREAKFAST', label: 'bữa sáng nay', nextMealLabel: 'bữa trưa' };
    }
    if (readyAtMinutes <= 14 * 60) {
        return { code: 'LUNCH', label: 'bữa trưa nay', nextMealLabel: 'bữa tối' };
    }
    if (readyAtMinutes <= (20 * 60) + 30) {
        return { code: 'DINNER', label: 'bữa tối nay', nextMealLabel: null };
    }
    return { code: 'NEXT_BREAKFAST', label: 'bữa sáng mai', nextMealLabel: null };
}

function canSuggestLeftovers(recipe, mealContext, feasibleServings) {
    if (Number(feasibleServings) < 2 || !mealContext.nextMealLabel) return false;
    const dishType = String(recipe.dishType || recipe.dishRole || '').toUpperCase();
    const title = normalizeText(recipe.title || '');
    return dishType === 'SOUP'
        || /(^| )(canh|sup|chao|ham|kho)( |$)/.test(title);
}

function buildTodaySuggestionReasoning(recipe, analysis, options = {}) {
    const mealContext = inferUpcomingMeal(
        options.now || new Date(),
        recipe.cookingTimeMinutes,
        options.timeZone || 'Asia/Ho_Chi_Minh'
    );
    const expiringBatch = (analysis.ingredientMatches || [])
        .flatMap(match => match.matchedBatches || [])
        .filter(batch => Number.isInteger(batch.daysRemaining)
            && batch.daysRemaining >= 0
            && batch.daysRemaining <= 7)
        .sort((a, b) => a.daysRemaining - b.daysRemaining)[0];

    const sentences = [
        `Chà, ${recipe.title} khá hợp cho ${mealContext.label} đấy.`,
        `Trong kho đủ nguyên liệu để nấu tối đa ${analysis.feasibleServings} khẩu phần.`
    ];

    if (expiringBatch) {
        const ingredientName = String(expiringBatch.itemName || expiringBatch.rawName || 'nguyên liệu').trim();
        const amount = formatGroundedAmount(
            expiringBatch.standardQuantity,
            expiringBatch.standardUnit
        );
        const inventoryFact = amount
            ? `${amount} ${ingredientName.toLowerCase()}`
            : ingredientName.toLowerCase();
        sentences.push(
            `Đặc biệt, ${inventoryFact} ${expiryPhrase(expiringBatch.daysRemaining)}, nên dùng sớm để vừa ngon vừa đỡ lãng phí nhé.`
        );
    }

    if (canSuggestLeftovers(recipe, mealContext, analysis.feasibleServings)) {
        sentences.push(
            `Nếu nấu 2 khẩu phần, phần còn lại có thể để dành cho ${mealContext.nextMealLabel}, miễn là được bảo quản đúng cách và hâm nóng lại trước khi dùng.`
        );
    }

    return sentences.join(' ');
}

module.exports = {
    RELATION_SCORE,
    ACCEPTED_RELATIONS,
    normalizeText,
    canonicalizeName,
    classifyIngredientRelation,
    toBaseAmount,
    isExpired,
    usableInventory,
    scaleIngredientAmount,
    resolveRequestedServings,
    analyzeRecipe,
    buildConsumptionPlan,
    calculateRemainingBatchAmounts,
    selectTodayRecipe,
    inferUpcomingMeal,
    buildTodaySuggestionReasoning
};
