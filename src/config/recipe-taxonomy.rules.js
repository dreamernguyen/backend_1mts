'use strict';

const DISH_TYPES = new Set(['MAIN', 'SIDE', 'SOUP', 'DRINK', 'DESSERT', 'SNACK']);
const TAG_LIMIT = 3;

function compact(value) {
    return String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

function fold(value) {
    return compact(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/gi, 'd')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

const DRINK_TITLE = /\b(tra|sinh to|ca phe|siro|nuoc ep|nuoc rau ma|nuoc tia to|nuoc sau|nuoc nhan|nuoc uong)\b/;
const DESSERT_TITLE = /\b(che|flan|pudding|mousse|banh bong lan|banh qui|banh quy|muffin|mut)\b/;
const SNACK_TITLE = /\b(snack|an vat|khoai tay lac|com chay|banh he|banh trang nuong|banh khoai lang|khoai tay chien|san hap)\b/;
const SOUP_TITLE = /(^|[^\p{L}])(canh|súp|lẩu)(?=$|[^\p{L}])/iu;
const SIDE_TITLE = /\b(salad|goi|nom|muoi (dua|ca|hanh)|dua muoi|ngam (nuoc tuong|giam)|muoi chua|dua bap cai tron|mam chay)\b/;
const BROTH_DISH = /\b(bun [^ ]* nau|bun [^ ]* mang|mien ga|hu tieu)\b/;
const LOW_OIL_METHOD = /\b(hap|luoc|om|ham|salad|goi|nom|canh|sup|lau)\b/;
const HIGH_OIL_METHOD = /\b(chien|ran|xao|rang|mayo|top mo|mo hanh)\b/;

function classifyDishType(recipe, { trustExisting = false } = {}) {
    const title = fold(recipe?.title);
    const originalTitle = compact(recipe?.title).toLowerCase();
    const existing = String(recipe?.dishType || '').toUpperCase();
    if (DRINK_TITLE.test(title)) return 'DRINK';
    if (
        DESSERT_TITLE.test(title)
        || /(^|\s)(kem|kẹo)(?=$|\s)/u.test(originalTitle)
    ) return 'DESSERT';
    if (SNACK_TITLE.test(title)) return 'SNACK';
    if (SOUP_TITLE.test(originalTitle)) return 'SOUP';
    if (/cháo\s+gỏi/u.test(originalTitle)) return 'MAIN';
    // “Mì gói” không phải “gỏi”; bỏ dấu tiếng Việt từng làm món này rơi
    // nhầm vào SIDE_TITLE.
    if (/\bmì gói\b/u.test(originalTitle)) {
        return trustExisting && DISH_TYPES.has(existing) ? existing : 'MAIN';
    }
    if (SIDE_TITLE.test(title)) return 'SIDE';
    return trustExisting && DISH_TYPES.has(existing) ? existing : 'MAIN';
}

function deriveRecipeTags(recipe) {
    const title = fold(recipe?.title);
    const description = fold(recipe?.description);
    const steps = fold((recipe?.steps || [])
        .map(step => typeof step === 'string' ? step : step?.instruction)
        .join(' '));
    const ingredients = fold((recipe?.ingredients || [])
        .map(item => item?.name || item?.canonicalName || item?.itemName)
        .join(' '));
    const content = `${title} ${description} ${steps}`;
    const dishType = classifyDishType(recipe, { trustExisting: true });
    const tags = [];
    const add = tag => {
        if (!tags.includes(tag) && tags.length < TAG_LIMIT) tags.push(tag);
    };

    const originalTitle = compact(recipe?.title).toLowerCase();
    if (
        BROTH_DISH.test(title)
        || /(^|\s)(phở|cháo)(?=$|\s)/u.test(originalTitle)
    ) add('MÓN NƯỚC');
    if (!/\b(giai cam|cam lanh)\b/.test(title) && /\b(giai cam|cam lanh|phong han)\b/.test(content)) {
        add('GIẢI CẢM');
    }
    if (
        !/\b(giai nhiet|thanh mat|thanh nhiet)\b/.test(title)
        && /\b(giai nhiet|thanh mat|thanh nhiet|mat ruot)\b/.test(content)
    ) add('THANH MÁT');
    if (
        !/\b(healthy|lanh manh)\b/.test(title)
        && /\b(healthy|lanh manh|tot cho suc khoe|can bang dinh duong)\b/.test(content)
    ) add('HEALTHY');

    const hasAddedOil = /\b(dau an|mo heo|mo ga|mayo)\b/.test(ingredients);
    if (
        ['MAIN', 'SIDE', 'SOUP', 'SNACK'].includes(dishType)
        && LOW_OIL_METHOD.test(`${title} ${steps}`)
        && !HIGH_OIL_METHOD.test(`${title} ${steps}`)
        && !hasAddedOil
        && !/\b(it dau|khong dau|khong ngam dau)\b/.test(title)
    ) add('ÍT DẦU');

    const cookingTime = Number(recipe?.cookingTimeMinutes);
    if (
        Number.isFinite(cookingTime)
        && cookingTime > 0
        && cookingTime <= 30
        && !/\b(nhanh|\d+ phut)\b/.test(title)
    ) add('NẤU NHANH');
    return tags;
}

function normalizeRecipeSource(recipe) {
    const source = String(recipe?.source || '').toUpperCase();
    const legacyTags = (recipe?.tags || []).map(tag => String(tag).toUpperCase());
    if (
        source === 'AI'
        || source === 'AI_GENERATED'
        || source === 'AI_ADAPTED'
        || String(recipe?.recipeId || '').toLowerCase().startsWith('ai_')
        || legacyTags.includes('AI_CHEF')
        || legacyTags.includes('AI_COLLECTED')
    ) return 'AI';
    return 'SYSTEM';
}

function normalizeRecipeTaxonomy(recipe, options = {}) {
    const dishType = classifyDishType(recipe, options);
    const normalized = { ...recipe, dishType };
    return {
        ...normalized,
        tags: deriveRecipeTags(normalized),
        source: normalizeRecipeSource(recipe)
    };
}

module.exports = {
    DISH_TYPES,
    TAG_LIMIT,
    classifyDishType,
    deriveRecipeTags,
    normalizeRecipeSource,
    normalizeRecipeTaxonomy
};
