const ITEM_CATEGORIES = new Set([
    'MEAT', 'SEAFOOD', 'VEGETABLE', 'FRUIT', 'EGG', 'DRY_FOOD',
    'DRINK', 'SPICE', 'COSMETIC', 'SUPPLEMENT', 'OTHER'
]);
const COOKABLE_ITEM_CATEGORIES = new Set([
    'MEAT', 'SEAFOOD', 'VEGETABLE', 'FRUIT', 'EGG', 'DRY_FOOD', 'DRINK', 'SPICE'
]);
const { endOfVietnamDay, addVietnamDays } = require('./vietnam-date.service');

const TRANSACTION_CATEGORIES = new Set([
    'HOUSING', 'ACADEMICS', 'RESTAURANT', 'MARKET', 'CLOTHING',
    'TRANSPORT', 'HEALTHCARE', 'ENTERTAINMENT', 'SAVINGS',
    'APPLIANCES', 'SALARY', 'ALLOWANCE', 'SCHOLARSHIP', 'OTHERS'
]);

const STORAGE_LOCATIONS = new Set(['FRIDGE', 'FREEZER', 'PANTRY']);
const EXPIRY_SOURCES = new Set([
    'USER', 'ESTIMATED_RULE', 'LEGACY_UNKNOWN', 'NOT_APPLICABLE'
]);

const DEFAULT_STORAGE_BY_CATEGORY = Object.freeze({
    MEAT: 'FRIDGE', SEAFOOD: 'FRIDGE', VEGETABLE: 'FRIDGE',
    FRUIT: 'FRIDGE', EGG: 'FRIDGE', DRINK: 'PANTRY',
    DRY_FOOD: 'PANTRY', SPICE: 'PANTRY', COSMETIC: 'PANTRY',
    SUPPLEMENT: 'PANTRY', OTHER: 'PANTRY'
});

const DEFAULT_EXPIRY_RULES = Object.freeze({
    MEAT_FRIDGE: { code: 'MEAT_CHILLED', days: 3 },
    MEAT_FREEZER: { code: 'MEAT_FROZEN', days: 90 },
    SEAFOOD_FRIDGE: { code: 'SEAFOOD_CHILLED', days: 3 },
    SEAFOOD_FREEZER: { code: 'SEAFOOD_FROZEN', days: 90 },
    VEGETABLE: { code: 'VEGETABLE_DEFAULT', days: 7 },
    FRUIT: { code: 'FRUIT_DEFAULT', days: 7 },
    EGG: { code: 'EGG_DEFAULT', days: 7 },
    MILK_FRIDGE: { code: 'MILK_CHILLED', days: 7 },
    MILK_PANTRY: { code: 'MILK_UHT_UNOPENED', days: 180 },
    DRINK: { code: 'DRINK_UNOPENED', days: 30 },
    DRY_FOOD: { code: 'DRY_FOOD_DEFAULT', days: 30 },
    SAUCE: { code: 'SAUCE_UNOPENED', days: 180 },
    SPICE: { code: 'SPICE_DEFAULT', days: 365 }
});

const SUBCATEGORY_TO_CATEGORY = Object.freeze({
    PORK: 'MEAT', BEEF: 'MEAT', CHICKEN: 'MEAT', DUCK: 'MEAT',
    GOOSE: 'MEAT', PROCESSED_MEAT: 'MEAT', OTHER_MEAT: 'MEAT',
    FISH: 'SEAFOOD', SHRIMP: 'SEAFOOD', SQUID_OCTOPUS: 'SEAFOOD',
    CRAB_SHELLFISH: 'SEAFOOD', OTHER_SEAFOOD: 'SEAFOOD',
    LEAFY_VEG: 'VEGETABLE', ROOT_VEG: 'VEGETABLE', MUSHROOM: 'VEGETABLE',
    HERB_SPICE_VEG: 'VEGETABLE', OTHER_VEG: 'VEGETABLE',
    CITRUS: 'FRUIT', TROPICAL: 'FRUIT', TEMPERATE: 'FRUIT', OTHER_FRUIT: 'FRUIT',
    MILK: 'DRINK', WATER: 'DRINK', SODA_JUICE: 'DRINK',
    COFFEE_TEA: 'DRINK', ALCOHOL: 'DRINK',
    NOODLE_PASTA: 'DRY_FOOD', RICE_GRAIN: 'DRY_FOOD',
    BASIC_SPICE: 'SPICE', SAUCE: 'SPICE', OTHER: 'OTHER'
});

const UNIT_ALIASES = Object.freeze({
    g: 'g', gram: 'g', gam: 'g',
    kg: 'kg', kilogram: 'kg',
    ml: 'ml', milliliter: 'ml',
    l: 'L', lit: 'L', litre: 'L', liter: 'L',
    cai: 'Cái', chiec: 'Cái',
    qua: 'Trái/Quả', trai: 'Trái/Quả', 'trai/qua': 'Trái/Quả',
    phan: 'Phần', khay: 'Khay', vi: 'Vỉ', lon: 'Lon',
    chai: 'Chai', goi: 'Gói', bo: 'Bó', hop: 'Hộp'
});

function normalizeWhitespace(value) {
    return String(value ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

function foldVietnamese(value) {
    return normalizeWhitespace(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/gi, 'd')
        .toLowerCase();
}

function sentenceCase(value) {
    const normalized = normalizeWhitespace(value).toLocaleLowerCase('vi');
    return normalized ? normalized[0].toLocaleUpperCase('vi') + normalized.slice(1) : '';
}

function normalizeItemName(value) {
    let name = normalizeWhitespace(value)
        .replace(/\b\d+(?:[.,]\d+)?\s*(?:kg|g|ml|l)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    name = name.replace(/\blợn\b/gi, 'heo');
    return sentenceCase(name);
}

function escapeRegExp(value) {
    return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripBrandFromItemName(value, brand) {
    const name = normalizeWhitespace(value);
    const normalizedBrand = normalizeWhitespace(brand);
    if (!name || !normalizedBrand || foldVietnamese(normalizedBrand) === 'no name') return name;

    return normalizeWhitespace(name.replace(
        new RegExp(`(^|\\s)${escapeRegExp(normalizedBrand)}(?=\\s|$)`, 'giu'),
        ' '
    ));
}

const COMMERCIAL_DESCRIPTORS_BY_CATEGORY = Object.freeze({
    MEAT: [/tươi ngon/giu, /tươi/giu, /hữu cơ/giu, /\borganic\b/giu, /\bvietgap\b/giu],
    SEAFOOD: [/tươi ngon/giu, /tươi/giu, /hữu cơ/giu, /\borganic\b/giu, /\bvietgap\b/giu],
    VEGETABLE: [/tươi ngon/giu, /hữu cơ/giu, /\borganic\b/giu, /\bvietgap\b/giu, /sạch/giu],
    FRUIT: [/tươi ngon/giu, /hữu cơ/giu, /\borganic\b/giu, /\bvietgap\b/giu, /sạch/giu]
});

function stripCommercialDescriptors(value, category) {
    let name = normalizeWhitespace(value)
        .replace(/\b(?:loại|hạng)\s*(?:đặc biệt|[a-c]|\d+)\b/giu, ' ')
        .replace(/\b(?:size|cỡ)\s*(?:xs|s|m|l|xl|xxl|nhỏ|vừa|lớn)\b/giu, ' ')
        .replace(/\b(?:combo|khuyến mãi)\b/giu, ' ');

    for (const pattern of COMMERCIAL_DESCRIPTORS_BY_CATEGORY[category] || []) {
        name = name.replace(pattern, ' ');
    }
    if (category === 'MEAT') {
        name = name
            .replace(/phi\s*lê/giu, ' ')
            .replace(/fillet/giu, ' ')
            .replace(/(?:có|không)\s+da/giu, ' ')
            .replace(/rút\s+xương/giu, ' ');
    }
    return normalizeWhitespace(name);
}

// Danh tính cấp kho chỉ giữ nguyên liệu gốc và trạng thái thực sự làm thay đổi
// cách sử dụng. Các mô tả thương mại vẫn được giữ nguyên trong rawName của lô.
function canonicalizeEggIdentity(value) {
    const folded = foldVietnamese(value);
    const species = [
        { pattern: /\btrung\s+ga\b/u, label: 'Trứng gà' },
        { pattern: /\btrung\s+vit\b/u, label: 'Trứng vịt' },
        { pattern: /\btrung\s+cut\b/u, label: 'Trứng cút' },
        { pattern: /\btrung\s+ngong\b/u, label: 'Trứng ngỗng' }
    ].find(entry => entry.pattern.test(folded));

    if (!species) return sentenceCase(value);

    if (/\blong\s+do\b/u.test(folded)) return `Lòng đỏ ${species.label.toLocaleLowerCase('vi')}`;
    if (/\blong\s+trang\b/u.test(folded)) return `Lòng trắng ${species.label.toLocaleLowerCase('vi')}`;
    if (/\bbot\s+trung\b/u.test(folded)) return `Bột ${species.label.toLocaleLowerCase('vi')}`;

    const processingStates = [
        { pattern: /\bbac\s+thao\b/u, label: 'bắc thảo' },
        { pattern: /\bmuoi\b/u, label: 'muối' },
        { pattern: /\blon\b/u, label: 'lộn' },
        { pattern: /\bnon\b/u, label: 'non' },
        { pattern: /\bluoc\b/u, label: 'luộc' }
    ];
    const state = processingStates.find(entry => entry.pattern.test(folded));
    return sentenceCase(state ? `${species.label} ${state.label}` : species.label);
}

function normalizeIngredientIdentity(input = {}) {
    const sourceName = input.itemName || input.rawName;
    let itemName = normalizeItemName(sourceName);
    itemName = stripBrandFromItemName(itemName, input.brand);

    const category = normalizeWhitespace(input.category).toUpperCase();
    itemName = stripCommercialDescriptors(itemName, category);
    if (category === 'EGG') itemName = canonicalizeEggIdentity(itemName);

    return normalizeItemName(itemName);
}

function inferKnownItemTaxonomy(value) {
    const name = foldVietnamese(value);
    if (/(^|\s)dau ga(?=\s|$)/u.test(name)) {
        return { category: 'DRY_FOOD', subCategory: 'RICE_GRAIN' };
    }
    if (/(^|\s)nam dui ga(?=\s|$)/u.test(name)) {
        return { category: 'VEGETABLE', subCategory: 'MUSHROOM' };
    }
    return null;
}

function parseDecimal(value, fallback = 0) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
    const raw = normalizeWhitespace(value).replace(/\s/g, '');
    if (!raw) return fallback;
    let normalized = raw.replace(/[^0-9,.-]/g, '');
    if (normalized.includes(',') && normalized.includes('.')) {
        const decimalSeparator = normalized.lastIndexOf(',') > normalized.lastIndexOf('.') ? ',' : '.';
        normalized = normalized
            .replace(decimalSeparator === ',' ? /\./g : /,/g, '')
            .replace(decimalSeparator, '.');
    } else if (normalized.includes(',')) {
        normalized = normalized.replace(',', '.');
    }
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function parseMoney(value, fallback = 0) {
    if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : fallback;
    const raw = normalizeWhitespace(value);
    if (!raw) return fallback;
    const parsed = Number(raw.replace(/[^0-9-]/g, ''));
    return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
}

function calculateBaseUnitPrice(item = {}) {
    const purchasePrice = Math.max(0, parseMoney(item.purchasePrice, 0));
    const quantity = Math.max(0, parseDecimal(item.quantity, 0));
    const standardQuantity = parseDecimal(item.standardQuantity, 0);
    if (purchasePrice <= 0 || quantity <= 0 || standardQuantity <= 0) return 0;
    return Math.round((purchasePrice * quantity) / standardQuantity);
}

function normalizeUnit(value) {
    const raw = normalizeWhitespace(value);
    if (!raw) return '';
    const folded = foldVietnamese(raw).replace(/[^a-z/]/g, '');
    return UNIT_ALIASES[folded] || raw;
}

function warning(code, field, message, severity = 'warning') {
    return { code, field, severity, message };
}

function readMeasureFromName(rawName) {
    // \b coi ký tự tiếng Việt có dấu là non-word, nên "1 GÓI" từng bị
    // nhận nhầm thành 1 gram. Chỉ chấp nhận khi sau token đơn vị không còn
    // là một chữ cái Unicode.
    const match = normalizeWhitespace(rawName).match(
        /(\d+(?:[.,]\d+)?)\s*(kg|g|ml|l)(?!\p{L})/iu
    );
    if (!match) return null;
    return { quantity: parseDecimal(match[1], 0), unit: match[2].toUpperCase() };
}

function toBaseMeasure(measure) {
    if (!measure) return null;
    if (measure.unit === 'KG') return { quantity: measure.quantity * 1000, unit: 'G' };
    if (measure.unit === 'L') return { quantity: measure.quantity * 1000, unit: 'ML' };
    return measure;
}

function readMeasureFromPurchaseUnit(item) {
    const quantity = parseDecimal(item.quantity, 0);
    const unit = foldVietnamese(normalizeUnit(item.unit));
    if (quantity <= 0) return null;
    if (unit === 'kg') return { quantity: quantity * 1000, unit: 'G' };
    if (unit === 'g') return { quantity, unit: 'G' };
    if (unit === 'l') return { quantity: quantity * 1000, unit: 'ML' };
    if (unit === 'ml') return { quantity, unit: 'ML' };
    return null;
}

function normalizeMeasure(item, warnings, { requireConfirmation = false } = {}) {
    let standardQuantity = parseDecimal(item.standardQuantity, 0);
    let standardUnit = normalizeWhitespace(item.standardUnit).toUpperCase();
    let measurementStatus = normalizeWhitespace(item.measurementStatus).toUpperCase();
    if (standardUnit === 'GRAM' || standardUnit === 'GR') standardUnit = 'G';
    if (standardUnit === 'LITRE' || standardUnit === 'LITER') standardUnit = 'L';

    if (standardQuantity <= 0 || !['G', 'KG', 'ML', 'L', 'PIECE'].includes(standardUnit)) {
        const detected = readMeasureFromName(item.rawName || item.itemName);
        if (detected) {
            standardQuantity = detected.quantity;
            standardUnit = detected.unit;
            warnings.push(warning(
                'INFERRED_MEASURE_FROM_NAME',
                'standardQuantity',
                'Định lượng được đọc từ tên hàng và cần được kiểm tra.'
            ));
        }
    }

    if (standardUnit === 'KG') {
        standardQuantity *= 1000;
        standardUnit = 'G';
    } else if (standardUnit === 'L') {
        standardQuantity *= 1000;
        standardUnit = 'ML';
    }

    // Hóa đơn hàng cân thường ghi quantity dạng kg thập phân (0,350 hoặc
    // 0.350). Cặp quantity + unit là bằng chứng xác định, nên dùng nó để sửa
    // trường hợp AI giữ 0.350 nhưng gắn nhầm standardUnit=G thành 0.350 gram.
    const purchaseMeasure = readMeasureFromPurchaseUnit(item);
    if (purchaseMeasure && (
        standardQuantity <= 0
        || standardUnit !== purchaseMeasure.unit
        || !nearlyEqual(standardQuantity, purchaseMeasure.quantity)
    )) {
        standardQuantity = purchaseMeasure.quantity;
        standardUnit = purchaseMeasure.unit;
        warnings.push(warning(
            'MEASURE_DERIVED_FROM_PURCHASE_UNIT',
            'standardQuantity',
            'Định lượng chuẩn được quy đổi từ số lượng và đơn vị kg/g/l/ml trên hóa đơn.'
        ));
    }

    if (standardQuantity <= 0 || !['G', 'ML', 'PIECE'].includes(standardUnit)) {
        standardQuantity = 1;
        standardUnit = 'PIECE';
        if (requireConfirmation) measurementStatus = 'REVIEW_REQUIRED';
        warnings.push(warning(
            'AMBIGUOUS_UNIT',
            'standardQuantity',
            'Không xác định được định lượng; hệ thống tạm tính là 1 đơn vị.'
        ));
    }

    if (measurementStatus === 'REVIEW_REQUIRED' && item.measurementConfirmed !== true) {
        warnings.push(warning(
            'MEASUREMENT_CONFIRMATION_REQUIRED',
            'standardQuantity',
            'Thực phẩm chưa có định lượng rõ ràng; hệ thống đang lưu theo đơn vị mua và cần người dùng kiểm tra khi sử dụng.'
        ));
    } else {
        measurementStatus = 'CONFIRMED';
    }

    // standardQuantity trong collection Item luôn là TỔNG lượng khả dụng của
    // cả dòng mua. AI đôi khi trả khối lượng của một gói dù quantity > 1;
    // chỉ nhân khi tên nguyên bản xác nhận rõ đúng định lượng mỗi bao bì.
    const quantity = parseDecimal(item.quantity, 1);
    const purchaseUnit = foldVietnamese(normalizeUnit(item.unit));
    const packagedUnits = new Set([
        'khay', 'tui', 'hop', 'goi', 'vi', 'lon', 'chai', 'can', 'hu', 'lo', 'tuyp', 'bo'
    ]);
    const detectedPerPackage = toBaseMeasure(readMeasureFromName(item.rawName || item.itemName));
    if (quantity > 1
        && packagedUnits.has(purchaseUnit)
        && detectedPerPackage
        && detectedPerPackage.unit === standardUnit
        && nearlyEqual(standardQuantity, detectedPerPackage.quantity)) {
        standardQuantity *= quantity;
        warnings.push(warning(
            'PACKAGED_MEASURE_TOTALIZED',
            'standardQuantity',
            'Định lượng mỗi bao bì đã được nhân với số lượng mua để lưu tổng lượng khả dụng.'
        ));
    }
    return { standardQuantity, standardUnit, measurementStatus };
}

function isValidCategorySubCategory(categoryValue, subCategoryValue) {
    const category = normalizeWhitespace(categoryValue).toUpperCase();
    const subCategory = normalizeWhitespace(subCategoryValue).toUpperCase() || 'OTHER';
    if (!ITEM_CATEGORIES.has(category)) return false;
    if (subCategory === 'OTHER') return true;
    return SUBCATEGORY_TO_CATEGORY[subCategory] === category;
}

function normalizeConfidence(input, defaults) {
    const source = input && typeof input === 'object' ? input : {};
    const result = {};
    for (const [key, fallback] of Object.entries(defaults)) {
        const value = Number(source[key]);
        result[key] = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
    }
    return result;
}

function parseDate(value) {
    if (!value) return null;
    const parsed = value instanceof Date ? new Date(value) : new Date(String(value));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function endOfDay(value) {
    return endOfVietnamDay(value);
}

function includesAny(value, keywords) {
    return keywords.some(keyword => value.includes(keyword));
}

function resolveStorageLocation(input = {}, category = 'OTHER', subCategory = 'OTHER') {
    const explicit = normalizeWhitespace(input.storageLocation).toUpperCase();
    if (STORAGE_LOCATIONS.has(explicit)) return explicit;

    const searchableName = foldVietnamese(`${input.rawName || ''} ${input.itemName || ''}`);
    if (includesAny(searchableName, ['dong lanh', 'frozen'])) return 'FREEZER';

    if (subCategory === 'MILK') {
        if (includesAny(searchableName, ['tiet trung', 'uht', 'hop giay'])) return 'PANTRY';
        return 'FRIDGE';
    }

    return DEFAULT_STORAGE_BY_CATEGORY[category] || 'PANTRY';
}

function selectExpiryRule(category, subCategory, storageLocation) {
    if (category === 'MEAT' || category === 'SEAFOOD') {
        return DEFAULT_EXPIRY_RULES[`${category}_${storageLocation}`]
            || DEFAULT_EXPIRY_RULES[`${category}_FRIDGE`];
    }
    if (subCategory === 'MILK') {
        return DEFAULT_EXPIRY_RULES[`MILK_${storageLocation}`]
            || DEFAULT_EXPIRY_RULES.MILK_FRIDGE;
    }
    if (subCategory === 'SAUCE') return DEFAULT_EXPIRY_RULES.SAUCE;
    return DEFAULT_EXPIRY_RULES[category] || null;
}

function resolveExpiry(input, context, category, subCategory, storageLocation) {
    const suppliedDate = endOfDay(input.expiryDate);
    const suppliedSource = normalizeWhitespace(input.expirySource).toUpperCase();

    // Ngày người dùng chủ động chọn là nguồn có độ ưu tiên cao nhất. Payload cũ
    // có ngày nhưng chưa có expirySource cũng được xem là người dùng nhập tay.
    if (suppliedDate && (suppliedSource === 'USER' || !EXPIRY_SOURCES.has(suppliedSource))) {
        return { expiryDate: suppliedDate, expirySource: 'USER', expiryRuleCode: null };
    }

    const rule = selectExpiryRule(category, subCategory, storageLocation);
    if (!rule) {
        return {
            expiryDate: null,
            expirySource: 'NOT_APPLICABLE',
            expiryRuleCode: 'NON_FOOD'
        };
    }

    // Không tin ngày ước lượng do client gửi lên: luôn tính lại theo ngày mua.
    const purchaseDate = endOfDay(context?.purchaseDate) || endOfDay(new Date());
    const expiryDate = addVietnamDays(purchaseDate, rule.days);
    return {
        expiryDate,
        expirySource: 'ESTIMATED_RULE',
        expiryRuleCode: rule.code
    };
}

function nearlyEqual(left, right, toleranceRatio = 0.02) {
    if (left <= 0 || right <= 0) return false;
    return Math.abs(left - right) <= Math.max(0.01, right * toleranceRatio);
}

function reconcileWeightedLine({ input, quantity, unit, measure, purchasePrice, warnings, context }) {
    const rawLineTotal = input.totalPrice ?? input.lineTotal;
    const hasLineTotal = rawLineTotal !== undefined && rawLineTotal !== null
        && normalizeWhitespace(rawLineTotal) !== '';
    const lineTotal = hasLineTotal ? Math.max(0, parseMoney(rawLineTotal, 0)) : 0;
    const foldedUnit = foldVietnamese(unit);
    const isMassOrVolumeMeasure = ['G', 'ML'].includes(measure.standardUnit);
    const isMeasuredPurchaseUnit = ['g', 'kg', 'ml', 'l'].includes(foldedUnit);
    const isFractionalMeasuredPurchase = isMeasuredPurchaseUnit
        && quantity > 0 && quantity < 1;
    const duplicatesMeasure = nearlyEqual(quantity, measure.standardQuantity);
    const looksLikeWeightedLine = isMassOrVolumeMeasure && (
        quantity > 20 || quantity > 0 && quantity < 1
        || isMeasuredPurchaseUnit && duplicatesMeasure
    );

    if (!looksLikeWeightedLine) {
        return { quantity, unit, purchasePrice, lineTotal, hasLineTotal };
    }

    const computedTotal = Math.round(quantity * purchasePrice);
    const transactionAmount = Math.max(0, parseMoney(context?.transactionAmount, 0));
    const impossibleAgainstReceipt = transactionAmount > 0
        && computedTotal > Math.max(transactionAmount * 3, transactionAmount + 100000);
    const lineTotalSupportsCorrection = lineTotal > 0
        && Math.abs(computedTotal - lineTotal) > Math.max(1000, lineTotal * 0.02);

    if (!duplicatesMeasure && !isFractionalMeasuredPurchase
        && !impossibleAgainstReceipt && !lineTotalSupportsCorrection) {
        return { quantity, unit, purchasePrice, lineTotal, hasLineTotal };
    }

    warnings.push(warning(
        'WEIGHTED_LINE_NORMALIZED',
        'quantity',
        'Hệ thống nhận diện đây là định lượng của một phần hàng cân và đã tách khỏi số lượng mua.'
    ));

    return {
        quantity: 1,
        unit: 'Phần',
        purchasePrice: lineTotal > 0 ? lineTotal : purchasePrice,
        lineTotal: lineTotal > 0 ? lineTotal : purchasePrice,
        hasLineTotal
    };
}

function normalizeReceiptItem(input = {}, context = {}) {
    const warnings = [];
    const rawName = normalizeWhitespace(input.rawName || input.itemName);
    const searchableName = foldVietnamese(`${input.itemName || ''} ${rawName}`);

    let subCategory = normalizeWhitespace(input.subCategory).toUpperCase() || 'OTHER';
    let category = normalizeWhitespace(input.category).toUpperCase();
    if (!ITEM_CATEGORIES.has(category)) category = 'OTHER';
    const knownTaxonomy = inferKnownItemTaxonomy(searchableName);
    if (knownTaxonomy
        && (category !== knownTaxonomy.category || subCategory !== knownTaxonomy.subCategory)) {
        category = knownTaxonomy.category;
        subCategory = knownTaxonomy.subCategory;
        warnings.push(warning(
            'CATEGORY_CORRECTED_FROM_IDENTITY',
            'category',
            'Danh mục được sửa lại từ cụm tên nguyên liệu đã nhận diện chắc chắn.'
        ));
    }
    const expectedCategory = SUBCATEGORY_TO_CATEGORY[subCategory];
    if (expectedCategory && category !== expectedCategory && subCategory !== 'OTHER') {
        category = expectedCategory;
        warnings.push(warning(
            'CATEGORY_CORRECTED_FROM_SUBCATEGORY',
            'category',
            'Nhóm mặt hàng được đồng bộ lại theo phân loại chi tiết.'
        ));
    }
    // Trứng chưa có subCategory riêng. Tên có cả "trứng + loài" là tín hiệu
    // đủ rõ để sửa cả category/subCategory AI trả sai.
    if (category !== 'EGG' && /\btrung\s+(?:ga|vit|cut|ngong)\b/u.test(searchableName)) {
        category = 'EGG';
        subCategory = 'OTHER';
        warnings.push(warning(
            'CATEGORY_CORRECTED_FROM_IDENTITY',
            'category',
            'Nhóm Trứng được xác định lại từ tên nguyên liệu.'
        ));
    }

    const itemName = normalizeIngredientIdentity({
        itemName: input.itemName || rawName,
        rawName,
        brand: input.brand,
        category,
        subCategory
    });
    if (!normalizeWhitespace(input.rawName)) {
        warnings.push(warning('MISSING_RAW_NAME', 'rawName', 'Không có tên nguyên văn từ hóa đơn.'));
    }
    if (!itemName) {
        warnings.push(warning('MISSING_ITEM_NAME', 'itemName', 'Không xác định được tên mặt hàng.', 'error'));
    }

    let quantity = parseDecimal(input.quantity, 1);
    if (quantity <= 0) {
        quantity = 1;
        warnings.push(warning('INVALID_QUANTITY', 'quantity', 'Số lượng không hợp lệ; tạm đặt là 1.', 'error'));
    }
    let unit = normalizeUnit(input.unit) || 'Cái';
    if (!normalizeWhitespace(input.unit)) {
        warnings.push(warning('MISSING_UNIT', 'unit', 'Không đọc được đơn vị mua; tạm đặt là Cái.'));
    }

    const measure = normalizeMeasure(input, warnings, {
        requireConfirmation: COOKABLE_ITEM_CATEGORIES.has(category)
    });

    let purchasePrice = Math.max(0, parseMoney(input.purchasePrice, 0));
    const reconciled = reconcileWeightedLine({
        input, quantity, unit, measure, purchasePrice, warnings, context
    });
    quantity = reconciled.quantity;
    unit = reconciled.unit;
    purchasePrice = reconciled.purchasePrice;

    const computedTotal = Math.round(quantity * purchasePrice);
    const suppliedTotal = reconciled.hasLineTotal ? reconciled.lineTotal : computedTotal;
    const tolerance = Math.max(1000, suppliedTotal * 0.02);
    if (suppliedTotal > 0 && Math.abs(computedTotal - suppliedTotal) > tolerance) {
        warnings.push(warning(
            'TOTAL_MISMATCH',
            'totalPrice',
            'Số lượng nhân đơn giá không khớp thành tiền của mặt hàng.'
        ));
    }

    const confidence = normalizeConfidence(input.confidence, {
        rawName: rawName ? 0.9 : 0.3,
        itemName: itemName ? 0.8 : 0.2,
        quantity: warnings.some(entry => entry.field === 'quantity')
            ? 0.6 : input.quantity != null ? 0.85 : 0.5,
        unit: input.unit ? 0.8 : 0.4,
        standardQuantity: warnings.some(entry => entry.field === 'standardQuantity') ? 0.55 : 0.8,
        category: category !== 'OTHER' ? 0.8 : 0.5,
        purchasePrice: purchasePrice > 0 ? 0.85 : 0.5
    });

    const storageLocation = resolveStorageLocation(input, category, subCategory);
    const expiry = resolveExpiry(input, context, category, subCategory, storageLocation);

    return {
        rawName,
        itemName,
        brand: normalizeWhitespace(input.brand) || 'No name',
        category,
        subCategory: SUBCATEGORY_TO_CATEGORY[subCategory] ? subCategory : 'OTHER',
        quantity,
        originalQuantity: quantity,
        unit,
        standardQuantity: measure.standardQuantity,
        standardUnit: measure.standardUnit,
        // Chế độ trừ kho được suy ra từ đơn vị chuẩn, không phụ thuộc AI hay
        // một công tắc người dùng có thể đặt lệch với định lượng.
        isSingleUse: measure.standardUnit === 'PIECE',
        measurementStatus: measure.measurementStatus,
        measurementConfirmed: measure.measurementStatus === 'CONFIRMED',
        purchasePrice,
        totalPrice: suppliedTotal,
        storageLocation,
        ...expiry,
        confidence,
        warnings
    };
}

function normalizeTransactionDraft(input = {}) {
    if (input.isReadable === false) {
        return {
            isReadable: false,
            reason: normalizeWhitespace(input.reason) || 'Không thể đọc được ảnh hóa đơn.',
            confidence: normalizeConfidence(input.confidence, { document: 0 }),
            warnings: [warning('UNREADABLE_DOCUMENT', 'document', 'Ảnh không đủ rõ để đọc.', 'error')]
        };
    }

    const warnings = [];
    let category = normalizeWhitespace(input.category).toUpperCase();
    if (!TRANSACTION_CATEGORIES.has(category)) {
        category = 'OTHERS';
        warnings.push(warning('UNKNOWN_TRANSACTION_CATEGORY', 'category', 'Chưa xác định được nhóm giao dịch.'));
    }
    const parsedDate = input.date ? new Date(input.date) : null;
    const date = parsedDate && !Number.isNaN(parsedDate.getTime())
        ? parsedDate.toISOString().slice(0, 10)
        : null;
    if (input.date && !date) warnings.push(warning('INVALID_DATE', 'date', 'Ngày trên hóa đơn không hợp lệ.'));

    const amount = Math.max(0, parseMoney(input.amount, 0));
    const rawItems = Array.isArray(input.items) ? input.items : [];
    const purchaseDate = date ? new Date(date) : new Date();
    const items = category === 'MARKET'
        ? rawItems.map(item => normalizeReceiptItem(item, {
            purchaseDate,
            transactionAmount: amount
        }))
        : [];
    if (category !== 'MARKET' && rawItems.length > 0) {
        warnings.push(warning(
            'ITEMS_IGNORED_FOR_NON_MARKET',
            'items',
            'Mặt hàng chỉ được nhập kho đối với giao dịch Đi chợ / Siêu thị.'
        ));
    }

    const discount = Math.max(0, parseMoney(input.discount, 0));
    const itemWarnings = items.flatMap((item, index) =>
        item.warnings.map(entry => ({ ...entry, itemIndex: index }))
    );
    // `amount` là số tiền cuối cùng sau voucher. Chỉ đối soát những dòng có
    // thành tiền xác định; không suy diễn các dòng thiếu giá/định lượng.
    const itemTotals = items
        .map(item => Number(item.totalPrice))
        .filter(total => Number.isFinite(total) && total > 0);
    if (category === 'MARKET' && itemTotals.length > 0 && amount > 0) {
        const expectedAmount = Math.max(0, itemTotals.reduce((sum, total) => sum + total, 0) - discount);
        const absoluteDelta = Math.abs(expectedAmount - amount);
        const relativeDelta = absoluteDelta / Math.max(amount, expectedAmount, 1);
        const tolerance = Math.max(1000, Math.max(amount, expectedAmount) * 0.02);
        if (absoluteDelta > tolerance) {
            const severity = absoluteDelta >= 10000 && relativeDelta >= 0.1 ? 'error' : 'warning';
            warnings.push(warning(
                'RECEIPT_TOTAL_MISMATCH',
                'amount',
                'Tổng thành tiền các mặt hàng không khớp số tiền thanh toán. Vui lòng kiểm tra lại hóa đơn.',
                severity
            ));
        }
    }

    return {
        isReadable: true,
        merchantName: normalizeWhitespace(input.merchantName),
        transactionType: normalizeWhitespace(input.transactionType).toUpperCase() === 'INCOME' ? 'INCOME' : 'EXPENSE',
        category,
        amount,
        discount,
        date,
        note: normalizeWhitespace(input.note) || (category === 'MARKET' ? 'Mua sắm nhu yếu phẩm' : 'Giao dịch'),
        paymentMethod: normalizeWhitespace(input.paymentMethod).toUpperCase() || 'CASH',
        items,
        confidence: normalizeConfidence(input.confidence, {
            document: 0.8,
            amount: amount > 0 ? 0.85 : 0.5,
            date: date ? 0.8 : 0.5,
            category: category !== 'OTHERS' ? 0.8 : 0.5
        }),
        warnings: [...warnings, ...itemWarnings]
    };
}

function normalizeTransactionList(value) {
    const list = Array.isArray(value) ? value : [value];
    return list.filter(entry => entry && typeof entry === 'object').map(normalizeTransactionDraft);
}

function normalizeUtilityDraft(input = {}) {
    if (!input || typeof input !== 'object') {
        return { isReadable: false, reason: 'AI không trả về hóa đơn tiện ích hợp lệ.' };
    }
    if (input.isReadable === false) {
        return {
            isReadable: false,
            reason: normalizeWhitespace(input.reason) || 'Không thể đọc được hóa đơn tiện ích.'
        };
    }
    const provider = normalizeWhitespace(input.provider);
    const amount = parseMoney(input.amount, NaN);
    const billingPeriod = normalizeWhitespace(input.billingPeriod);
    if (!provider || !Number.isFinite(amount) || amount <= 0 || !billingPeriod) {
        return { isReadable: false, reason: 'Dữ liệu hóa đơn tiện ích thiếu nhà cung cấp, số tiền hoặc kỳ hóa đơn.' };
    }
    return { isReadable: true, provider, amount, billingPeriod };
}

function validateExtractedReceiptTransactions(transactions, { inputMode = 'manual_text' } = {}) {
    if (!Array.isArray(transactions) || transactions.length === 0) {
        return {
            valid: false,
            code: 'RECEIPT_EMPTY_RESULT',
            message: 'AI không trả về dữ liệu hóa đơn.',
            data: []
        };
    }

    // Text nhập tay/voice có thể mô tả nhiều giao dịch. OCR text vẫn đại diện
    // cho đúng một hóa đơn nên phải chịu cùng validation với ảnh.
    if (inputMode !== 'image' && inputMode !== 'ocr_text') {
        return { valid: true, data: transactions };
    }

    const usable = transactions.filter(transaction => {
        if (!transaction || transaction.isReadable === false) return false;
        const amount = Number(transaction.amount) || 0;
        const items = Array.isArray(transaction.items) ? transaction.items : [];
        const warningCodes = new Set((transaction.warnings || []).map(entry => entry.code));
        if (amount <= 0 || warningCodes.has('UNKNOWN_TRANSACTION_CATEGORY')) return false;
        if (transaction.category === 'MARKET' && items.length === 0) return false;
        return true;
    });

    if (usable.length === 0) {
        return {
            valid: false,
            code: 'RECEIPT_NO_USABLE_DATA',
            message: 'Không đọc được số tiền hoặc mặt hàng hợp lệ từ hóa đơn. Vui lòng chụp rõ và quét lại.',
            data: []
        };
    }
    if (usable.length > 1) {
        return {
            valid: false,
            code: 'RECEIPT_AMBIGUOUS_RESULT',
            message: 'AI trả về nhiều giao dịch cho cùng một ảnh hóa đơn. Kết quả đã bị chặn để tránh lưu sai.',
            data: []
        };
    }
    return { valid: true, data: usable };
}

function hasBlockingWarnings(draft) {
    return Array.isArray(draft?.warnings) && draft.warnings.some(entry => entry.severity === 'error');
}

module.exports = {
    calculateBaseUnitPrice,
    foldVietnamese,
    normalizeItemName,
    normalizeIngredientIdentity,
    inferKnownItemTaxonomy,
    normalizeReceiptItem,
    normalizeTransactionDraft,
    normalizeTransactionList,
    normalizeUtilityDraft,
    validateExtractedReceiptTransactions,
    isValidCategorySubCategory,
    resolveStorageLocation,
    resolveExpiry,
    hasBlockingWarnings,
    parseDecimal,
    parseMoney
};
