/**
 * aiMetrics.service.js
 *
 * Helper ghi chỉ số AI vào MongoDB — luôn fire-and-forget.
 *
 * NGUYÊN TẮC THIẾT KẾ:
 *   - KHÔNG bao giờ throw ra ngoài → lỗi ghi metrics KHÔNG được phép
 *     làm crash hoặc làm chậm request nghiệp vụ của người dùng.
 *   - Tất cả hàm trả về void ngay lập tức, I/O ghi DB chạy song song.
 *   - Caller KHÔNG được await các hàm này.
 */
const AiMetrics = require('../models/aiMetrics.model');

/**
 * Hàm nội bộ: tạo document và nuốt lỗi.
 * @param {Object} payload — các field theo aiMetricsSchema
 */
const _insert = (payload) => {
    AiMetrics.create(payload).catch(err => {
        console.warn('[AiMetrics] Ghi thất bại (non-critical):', err.message);
    });
};

exports.logInsightMetric = ({ userId, sessionId, subFeature, eventType = 'AI_RESPONSE', engine = 'GEMINI', resultStatus = 'SUCCESS', latencyMs = null, aiModel = null, error = null }) => {
    _insert({
        userId, feature: 'GAMIFICATION', subFeature, eventType, sessionId,
        engine, resultStatus, latencyMs, modelLatencyMs: engine === 'GEMINI' ? latencyMs : null,
        endToEndLatencyMs: latencyMs, aiModel,
        failureStage: error ? (resultStatus === 'VALIDATION_REJECTED' ? 'VALIDATION' : 'PROVIDER') : null,
        errorCode: error?.code || null,
        errorMessage: error?.message ? String(error.message).slice(0, 500) : null
    });
};

const proposed = value => value !== null && value !== undefined && value !== '';
const sameValue = (left, right) => String(left ?? '') === String(right ?? '');

const receiptSnapshot = draft => ({
    amount: Number(draft?.amount),
    merchantName: draft?.merchantName ?? null,
    date: draft?.date ?? null,
    category: draft?.category ?? null,
    discount: Number(draft?.discount ?? 0),
    items: (draft?.items || []).map(item => ({
        itemName: item?.itemName ?? null,
        quantity: item?.quantity ?? null,
        purchasePrice: item?.purchasePrice ?? null,
        category: item?.category ?? null,
        subCategory: item?.subCategory ?? null,
        standardQuantity: item?.standardQuantity ?? null,
        standardUnit: item?.standardUnit ?? null,
        storageLocation: item?.storageLocation ?? null,
        expiryDate: item?.expiryDate ?? null
    }))
});

const compareReceiptSnapshot = (ai, finalDraft) => {
    if (!ai || !finalDraft) return {};
    const fields = ['amount', 'merchantName', 'date', 'category', 'discount'];
    let totalFieldCount = 0;
    let editedFieldCount = 0;
    for (const field of fields) {
        if (!proposed(ai[field])) continue;
        totalFieldCount += 1;
        if (!sameValue(ai[field], finalDraft[field])) editedFieldCount += 1;
    }
    const aiItems = Array.isArray(ai.items) ? ai.items : [];
    const finalItems = Array.isArray(finalDraft.items) ? finalDraft.items : [];
    const itemFields = ['itemName', 'quantity', 'purchasePrice', 'category', 'subCategory', 'standardQuantity', 'standardUnit', 'storageLocation', 'expiryDate'];
    for (let index = 0; index < aiItems.length; index += 1) {
        const aiItem = aiItems[index];
        const finalItem = finalItems[index];
        for (const field of itemFields) {
            if (!proposed(aiItem?.[field])) continue;
            totalFieldCount += 1;
            if (!finalItem || !sameValue(aiItem[field], finalItem[field])) editedFieldCount += 1;
        }
    }
    // Item user thêm mới là một omission; dùng số field của item final có dữ liệu.
    for (let index = aiItems.length; index < finalItems.length; index += 1) {
        editedFieldCount += itemFields.filter(field => proposed(finalItems[index]?.[field])).length;
    }
    const aiAmount = Number(ai.amount);
    const userAmount = Number(finalDraft.amount);
    const amountDelta = Number.isFinite(aiAmount) && Number.isFinite(userAmount)
        ? Math.abs(userAmount - aiAmount) : null;
    return {
        aiItemCount: aiItems.length,
        userItemCount: finalItems.length,
        userTotalAmount: Number.isFinite(userAmount) ? userAmount : null,
        editedFieldCount,
        totalFieldCount,
        amountDelta,
        amountDeltaPct: amountDelta === null ? null : Math.round(amountDelta / Math.max(Math.abs(aiAmount), 1) * 10000) / 100
    };
};

// ─── RECEIPT ──────────────────────────────────────────────────────────────────

/**
 * Ghi ngay sau khi AI bóc tách hóa đơn thành công.
 * Gọi trong parseDocument, KHÔNG await.
 *
 * @param {Object} p
 * @param {string|ObjectId} p.userId
 * @param {string}          p.sessionId      — scanRequestId từ client
 * @param {number|null}     p.latencyMs      — aiMetadata.durationMs
 * @param {string|null}     p.aiModel        — aiMetadata.model
 * @param {boolean|null}    p.cacheHit
 * @param {string|null}     p.inputMode      — 'image' | 'ocr_text' | 'manual_text'
 * @param {number|null}     p.aiItemCount    — tổng item AI trích được
 * @param {number|null}     p.aiTotalAmount  — tổng tiền AI đọc
 * @param {boolean|null}    p.hasWarnings
 */
exports.logReceiptAiResponse = ({
    userId, sessionId, latencyMs = null, aiModel = null,
    cacheHit = null, inputMode = null,
    aiItemCount = null, aiTotalAmount = null, hasWarnings = null,
    warningCount = null, blockingWarningCount = null, draft = null,
    platform = 'UNKNOWN', endToEndLatencyMs = null
}) => {
    _insert({
        userId, feature: 'RECEIPT', eventType: 'AI_RESPONSE', sessionId,
        latencyMs, modelLatencyMs: latencyMs, endToEndLatencyMs, aiModel, cacheHit, inputMode,
        platform, engine: 'GEMINI', resultStatus: 'SUCCESS',
        aiItemCount, aiTotalAmount, hasWarnings, warningCount, blockingWarningCount,
        receiptSnapshot: draft ? receiptSnapshot(draft) : null
    });
};

/**
 * Ghi khi user xác nhận lưu hóa đơn.
 * Gọi trong addTransaction sau session.commitTransaction(), KHÔNG await.
 *
 * @param {Object} p
 * @param {string|ObjectId} p.userId
 * @param {string}          p.sessionId          — scanRequestId từ client (req.body.scanRequestId)
 * @param {number|null}     p.userItemCount       — số item user lưu thực tế
 * @param {number|null}     p.userTotalAmount     — tổng tiền user lưu
 * @param {number|null}     p.aiItemCount         — số item AI đề xuất (từ req.body.aiItemCount)
 * @param {number|null}     p.editedFieldCount    — số trường user đã sửa
 * @param {number|null}     p.totalFieldCount     — tổng trường AI đề xuất (mẫu số để tính %)
 * @param {boolean|null}    p.wasEdited
 */
exports.logReceiptUserConfirmed = ({
    userId, sessionId,
    userItemCount = null, userTotalAmount = null,
    aiItemCount = null, editedFieldCount = null,
    totalFieldCount = null, wasEdited = null, finalDraft = null
}) => {
    Promise.resolve().then(async () => {
        const response = await AiMetrics.findOne({ userId, feature: 'RECEIPT', eventType: 'AI_RESPONSE', sessionId })
            .sort({ createdAt: -1 }).lean();
        const comparison = compareReceiptSnapshot(response?.receiptSnapshot, finalDraft) || {};
        const resolvedEdited = comparison.editedFieldCount ?? editedFieldCount;
        const resolvedTotal = comparison.totalFieldCount ?? totalFieldCount;
        const resolvedAiItems = comparison.aiItemCount ?? aiItemCount;
        const resolvedUserItems = comparison.userItemCount ?? userItemCount;
        const resolvedUserTotal = comparison.userTotalAmount ?? userTotalAmount;
        const fieldAccuracyPct = typeof resolvedEdited === 'number' && typeof resolvedTotal === 'number' && resolvedTotal > 0
            ? Math.max(0, Math.round((1 - resolvedEdited / resolvedTotal) * 10000) / 100) : null;
        _insert({
            userId, feature: 'RECEIPT', eventType: 'USER_CONFIRMED', sessionId,
            userItemCount: resolvedUserItems, userTotalAmount: resolvedUserTotal, aiItemCount: resolvedAiItems,
            editedFieldCount: resolvedEdited, totalFieldCount: resolvedTotal,
            wasEdited: wasEdited ?? (typeof resolvedEdited === 'number' ? resolvedEdited > 0 : null),
            itemCountDelta: typeof resolvedUserItems === 'number' && typeof resolvedAiItems === 'number' ? resolvedUserItems - resolvedAiItems : null,
            fieldAccuracyPct, amountDelta: comparison.amountDelta ?? null, amountDeltaPct: comparison.amountDeltaPct ?? null
        });
    }).catch(error => console.warn('[AiMetrics] Không thể đối chiếu receipt:', error.message));
};

/**
 * Ghi khi AI hóa đơn bị lỗi (timeout, API error, parse fail).
 * Gọi trong parseDocument catch, KHÔNG await.
 */
exports.logReceiptAiError = ({
    userId, sessionId, inputMode = null,
    errorCode = null, errorMessage = null, failureStage = 'PROVIDER', platform = 'UNKNOWN'
}) => {
    _insert({
        userId, feature: 'RECEIPT', eventType: 'AI_ERROR', sessionId,
        inputMode, errorCode, platform, engine: 'GEMINI', resultStatus: failureStage === 'PROVIDER' ? 'ERROR' : 'VALIDATION_REJECTED', failureStage,
        errorMessage: errorMessage ? String(errorMessage).slice(0, 500) : null
    });
};

exports.compareReceiptSnapshot = compareReceiptSnapshot;

// ─── METER OCR ────────────────────────────────────────────────────────────────

/**
 * Ghi ngay sau khi AI đọc chỉ số công tơ.
 * Gọi trong recognizeReading, KHÔNG await.
 *
 * @param {Object} p
 * @param {string|ObjectId} p.userId
 * @param {string}          p.sessionId       — X-Request-Id hoặc tự sinh
 * @param {number|null}     p.latencyMs       — metadata.durationMs
 * @param {string|null}     p.aiModel
 * @param {number|null}     p.aiReadingValue  — giá trị AI đọc (null nếu không đọc được)
 */
exports.logMeterAiResponse = ({
    userId, sessionId, latencyMs = null,
    aiModel = null, aiReadingValue = null, platform = 'UNKNOWN', endToEndLatencyMs = null,
    engine = 'GEMINI', fallbackChain = null
}) => {
    _insert({
        userId, feature: 'METER_OCR', eventType: 'AI_RESPONSE', sessionId,
        latencyMs, modelLatencyMs: latencyMs, endToEndLatencyMs, aiModel, platform, engine, fallbackChain, resultStatus: 'SUCCESS', inputMode: 'meter_image',
        aiReadingValue,
        hasWarnings: aiReadingValue === null // null reading = AI không chắc
    });
};

exports.logMeterAiError = ({ userId, sessionId, platform = 'UNKNOWN', errorCode = null, errorMessage = null }) => {
    _insert({
        userId, feature: 'METER_OCR', eventType: 'AI_ERROR', sessionId, platform, engine: 'GEMINI',
        inputMode: 'meter_image', resultStatus: 'ERROR', failureStage: 'PROVIDER', errorCode,
        errorMessage: errorMessage ? String(errorMessage).slice(0, 500) : null
    });
};

/**
 * Ghi khi user lưu chỉ số công tơ (xác nhận hoặc chỉnh sửa).
 * Gọi trong createReading sau session.commitTransaction(), KHÔNG await.
 *
 * @param {Object} p
 * @param {string|ObjectId} p.userId
 * @param {string}          p.sessionId
 * @param {number|null}     p.aiReadingValue   — AI đã đọc được (từ req.body.ocrValue)
 * @param {number|null}     p.userReadingValue — user lưu thực tế (currentValue)
 * @param {boolean|null}    p.wasEdited        — req.body.aiIsValueEdited
 * @param {string}          p.inputSource      — 'OCR' | 'MANUAL'
 */
exports.logMeterUserConfirmed = ({
    userId, sessionId,
    aiReadingValue = null, userReadingValue = null,
    wasEdited = null, inputSource = null, platform = 'UNKNOWN', engine = 'UNKNOWN', fallbackChain = null
}) => {
    const readingDelta = (typeof aiReadingValue === 'number' && typeof userReadingValue === 'number')
        ? Math.abs(userReadingValue - aiReadingValue)
        : null;

    _insert({
        userId, feature: 'METER_OCR', eventType: 'USER_CONFIRMED', sessionId,
        inputMode: inputSource === 'MANUAL' ? 'manual_text' : 'meter_image', platform, engine, fallbackChain,
        aiReadingValue, userReadingValue,
        wasEdited, readingDelta
    });
};

// ─── RECIPE SUGGEST ───────────────────────────────────────────────────────────

/**
 * Ghi khi hệ thống trả kết quả gợi ý món ăn.
 * Gọi trong suggestTodayRecipe / ragSuggestRecipe, KHÔNG await.
 *
 * @param {Object} p
 * @param {string|ObjectId} p.userId
 * @param {string}          p.sessionId
 * @param {number|null}     p.latencyMs
 * @param {boolean}         p.usedAiFallback  — true nếu gọi Gemini (không phải DB match)
 * @param {number|null}     p.suggestionCount — số gợi ý trả về
 * @param {string|null}     p.aiModel
 */
exports.logRecipeAiResponse = ({
    userId, sessionId, latencyMs = null,
    usedAiFallback = false, suggestionCount = null, aiModel = null,
    recipeId = null, recommendationSource = null, platform = 'UNKNOWN'
}) => {
    _insert({
        userId, feature: 'RECIPE_SUGGEST', eventType: 'AI_RESPONSE', sessionId,
        latencyMs, modelLatencyMs: usedAiFallback ? latencyMs : null, endToEndLatencyMs: latencyMs,
        aiModel, usedAiFallback, suggestionCount, recipeId, recommendationSource, platform,
        engine: usedAiFallback ? 'GEMINI' : 'RULE_DB', resultStatus: usedAiFallback ? 'FALLBACK' : 'SUCCESS'
    });
};

/**
 * Ghi khi user chọn nấu một công thức.
 * Gọi trong cookRecipe, KHÔNG await.
 *
 * @param {Object} p
 * @param {string|ObjectId} p.userId
 * @param {string}          p.sessionId
 * @param {number|null}     p.suggestionRank  — user chọn gợi ý thứ mấy (1-based)
 * @param {boolean}         p.cookSuccess     — trừ kho thành công
 * @param {boolean}         p.usedAiFallback
 */
exports.logRecipeUserConfirmed = ({
    userId, sessionId,
    suggestionRank = null, cookSuccess = false, usedAiFallback = false, recipeId = null
}) => {
    Promise.resolve().then(async () => {
        const response = await AiMetrics.exists({ userId, feature: 'RECIPE_SUGGEST', eventType: 'AI_RESPONSE', sessionId, recipeId });
        if (!response) return;
        _insert({ userId, feature: 'RECIPE_SUGGEST', eventType: 'USER_CONFIRMED', sessionId, suggestionRank, cookSuccess, usedAiFallback, recipeId });
    }).catch(error => console.warn('[AiMetrics] Không thể nối recipe session:', error.message));
};
