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

exports.logInsightMetric = ({ userId, sessionId, subFeature, eventType = 'AI_RESPONSE', engine = 'GEMINI', resultStatus = 'SUCCESS', latencyMs = null, aiModel = null, error = null, modelLatencyMs = null, cacheHit = null, pipelineVersion, providerAttempts, providerAttemptDetails, tokenUsage }) => {
    _insert({
        userId, feature: 'GAMIFICATION', subFeature, eventType, sessionId,
        engine, resultStatus, latencyMs, modelLatencyMs, cacheHit, pipelineVersion, providerAttempts, providerAttemptDetails, tokenUsage,
        endToEndLatencyMs: null, aiModel,
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

const normalizeMeterText = (text) => {
    if (text === null || text === undefined) return '';
    let str = String(text).trim().toLowerCase();
    str = str.replace(/(kwh|m³|m3)$/, '');
    str = str.replace(/\s+/g, '');
    str = str.replace(/,/g, '.');
    let res = '';
    let dot = false;
    for (const c of str) {
        if (c >= '0' && c <= '9') {
            res += c;
        } else if (c === '.' && !dot) {
            res += c;
            dot = true;
        }
    }
    return res;
};

const levenshteinDistance = (a, b) => {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    const matrix = [];
    for (let i = 0; i <= b.length; i++) {
        matrix[i] = [i];
    }
    for (let j = 0; j <= a.length; j++) {
        matrix[0][j] = j;
    }
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    matrix[i][j - 1] + 1,
                    matrix[i - 1][j] + 1
                );
            }
        }
    }
    return matrix[b.length][a.length];
};

exports.normalizeMeterText = normalizeMeterText;
exports.levenshteinDistance = levenshteinDistance;

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
    engine = 'GEMINI', fallbackChain = null, meterType = null
}) => {
    _insert({
        userId, feature: 'METER_OCR', eventType: 'AI_RESPONSE', sessionId,
        latencyMs, modelLatencyMs: latencyMs, endToEndLatencyMs, aiModel, platform, engine, fallbackChain, resultStatus: 'SUCCESS', inputMode: 'meter_image',
        aiReadingValue, meterType,
        hasWarnings: aiReadingValue === null // null reading = AI không chắc
    });
};

exports.logMeterAiError = ({ userId, sessionId, platform = 'UNKNOWN', errorCode = null, errorMessage = null, meterType = null }) => {
    _insert({
        userId, feature: 'METER_OCR', eventType: 'AI_ERROR', sessionId, platform, engine: 'GEMINI',
        inputMode: 'meter_image', resultStatus: 'ERROR', failureStage: 'PROVIDER', errorCode,
        errorMessage: errorMessage ? String(errorMessage).slice(0, 500) : null, meterType
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
    wasEdited = null, inputSource = null, platform = 'UNKNOWN', engine = 'UNKNOWN', fallbackChain = null,
    meterType = null, aiReadingText = null, userReadingText = null
}) => {
    const readingDelta = (typeof aiReadingValue === 'number' && typeof userReadingValue === 'number')
        ? Math.abs(userReadingValue - aiReadingValue)
        : null;

    let characterEditDistance = null;
    let characterErrorRatePct = null;
    let characterAccuracyPct = null;
    
    const normAi = normalizeMeterText(aiReadingText);
    const normUser = normalizeMeterText(userReadingText);

    if (normAi.length > 0 && normUser.length > 0) {
        characterEditDistance = levenshteinDistance(normAi, normUser);
        characterErrorRatePct = (characterEditDistance / normUser.length) * 100;
        characterAccuracyPct = Math.max(0, 100 - characterErrorRatePct);
    }

    _insert({
        userId, feature: 'METER_OCR', eventType: 'USER_CONFIRMED', sessionId,
        inputMode: inputSource === 'MANUAL' ? 'manual_text' : 'meter_image', platform, engine, fallbackChain,
        aiReadingValue, userReadingValue, meterType,
        aiReadingText: aiReadingText ? String(aiReadingText).slice(0, 32) : null,
        userReadingText: userReadingText ? String(userReadingText).slice(0, 32) : null,
        characterEditDistance, characterErrorRatePct, characterAccuracyPct,
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
    userId, sessionId, latencyMs = null, usedAiFallback = false, suggestionCount = null,
    aiModel = null, recipeId = null, recommendationSource = null, platform = 'UNKNOWN',
    subFeature = null, candidates = [], returnedRecipeIds = [], provider = null, outcome = null, errorCode = null, query
}) => {
    _insert({
        userId, feature: 'RECIPE_SUGGEST', eventType: 'AI_RESPONSE', sessionId,
        pipelineVersion: 'recipe-metrics-2', subFeature, latencyMs,
        modelLatencyMs: provider?.totalDurationMs ?? provider?.durationMs ?? null,
        endToEndLatencyMs: null,
        providerAttempts: usedAiFallback ? provider?.providerAttemptCount ?? null : 0,
        timings: { processingMs: latencyMs, providerMs: provider?.totalDurationMs ?? provider?.durationMs ?? undefined },
        payload: { recipe: { outcome, query: typeof query === 'string' ? query.slice(0, 1000) : undefined,
            returnedRecipeIds: returnedRecipeIds.slice(0, 30),
            candidates: candidates.slice(0, 30).map((c, i) => ({ recipeId: c.recipeId, rank: i + 1, source: recommendationSource,
                score: c.matchScore, canCook: c.canCook, feasibleServings: c.feasibleServings,
                ingredientCoveragePercent: c.ingredientCoveragePercent,
                requiredMissingCount: c.missingCoreIngredients?.length,
                reviewRequiredCount: c.reviewRequiredIngredients?.length })) } },
        aiModel: provider?.model || aiModel, usedAiFallback, suggestionCount, recipeId, recommendationSource, platform,
        errorCode, engine: usedAiFallback ? 'GEMINI' : 'RULE_DB',
        resultStatus: outcome === 'ERROR' ? 'ERROR' : usedAiFallback ? 'FALLBACK' : 'SUCCESS'
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
        let response = await AiMetrics.findOne({ userId, feature: 'RECIPE_SUGGEST', eventType: 'AI_RESPONSE',
            pipelineVersion: 'recipe-metrics-2', sessionId,
            $or: [{ recipeId }, { 'payload.recipe.returnedRecipeIds': recipeId }] }).select('payload.recipe recommendationSource usedAiFallback').lean();
        if (!response) {
            const saved = await AiMetrics.findOne({ userId, feature: 'RECIPE_SUGGEST', eventType: 'RESULT_PRESENTED', stage: 'DRAFT_SAVED', sessionId, recipeId }).select('_id').lean();
            if (saved) response = await AiMetrics.findOne({ userId, feature: 'RECIPE_SUGGEST', eventType: 'AI_RESPONSE', pipelineVersion: 'recipe-metrics-2', sessionId }).select('payload.recipe recommendationSource usedAiFallback').lean();
        }
        if (!response) return;
        const rank = response.payload?.recipe?.returnedRecipeIds?.indexOf(recipeId);
        _insert({ userId, feature: 'RECIPE_SUGGEST', pipelineVersion: 'recipe-metrics-2', eventType: 'USER_CONFIRMED',
            sessionId, suggestionRank: rank >= 0 ? rank + 1 : null, cookSuccess,
            usedAiFallback: response.usedAiFallback, recommendationSource: response.recommendationSource, recipeId,
            payload: { recipe: { selectedRecipeId: recipeId, selectedRank: rank >= 0 ? rank + 1 : undefined, cookSuccess } } });
    }).catch(error => console.warn('[AiMetrics] Không thể nối recipe session:', error.message));
};

// v2 meter callers keep the legacy function names. No duplicate v1 document is
// emitted when an operationId is supplied. Other features retain their APIs.
const telemetry = require('./ai-metrics-telemetry');
const { evaluateMeter } = require('./meter-metrics-evaluator');
const legacyMeterResponse = exports.logMeterAiResponse;
const legacyMeterError = exports.logMeterAiError;
const legacyMeterConfirmation = exports.logMeterUserConfirmed;
const baseMeterEvent = (p, eventType) => ({
    userId: p.userId, feature: 'METER_OCR', meterType: p.meterType,
    schemaVersion: 2, pipelineVersion: p.pipelineVersion || 'meter-v2',
    operationId: p.operationId, sessionId: p.sessionId || p.operationId,
    attemptId: p.attemptId, parentAttemptId: p.parentAttemptId,
    eventId: p.eventId || `${p.operationId}:${p.attemptId || 'confirmation'}:${eventType}`,
    eventType, origin: 'SERVER', occurredAt: new Date(), receivedAt: new Date(),
    stage: p.stage || (eventType === 'USER_CONFIRMED' ? 'CONFIRMATION' : 'GEMINI'),
    engine: p.engine || 'GEMINI', platform: p.platform || 'UNKNOWN',
    aiModel: p.aiModel, timings: { processingMs: p.endToEndLatencyMs ?? p.latencyMs, providerMs: p.modelLatencyMs ?? p.latencyMs,
        timeToConfirmMs: typeof p.timeToConfirmMs === 'number' && p.timeToConfirmMs >= 0 && p.timeToConfirmMs <= 3600000 ? p.timeToConfirmMs : undefined },
    businessRef: p.businessRef
});
exports.logMeterAiResponse = p => {
    if (!p.operationId) return legacyMeterResponse(p);
    const readable = typeof p.aiReadingValue === 'number' && Number.isFinite(p.aiReadingValue) && p.aiReadingValue >= 0;
    telemetry.enqueue({ ...baseMeterEvent(p, 'ATTEMPT_COMPLETED'), status: p.status === 'CLEAR' ? 'READABLE' : (p.status || (readable ? 'READABLE' : 'UNREADABLE')),
        payload: { meter: { readingValue: p.aiReadingValue, readingText: p.aiReadingText,
            rawReadingValue: p.rawReadingValue, rawReadingText: p.rawReadingText,
            normalizationReasons: p.normalizationReasons, suggestions: p.suggestions,
            decisionReasons: p.decisionReasons || [] } },
        reasonCode: p.reasonCode, warningCodes: p.warningCodes,
        tokenUsage: p.tokenUsage ? { input: p.tokenUsage.input ?? p.tokenUsage.promptTokenCount, output: p.tokenUsage.output ?? p.tokenUsage.candidatesTokenCount, total: p.tokenUsage.total ?? p.tokenUsage.totalTokenCount } : undefined,
        providerAttempts: Array.isArray(p.providerAttempts) ? p.providerAttempts.length : p.providerAttempts,
        providerAttemptDetails: Array.isArray(p.providerAttempts) ? p.providerAttempts.slice(0, 4) : undefined,
        aiReadingValue: p.aiReadingValue, aiReadingText: p.aiReadingText });
};
exports.logMeterAiError = p => {
    if (!p.operationId) return legacyMeterError(p);
    telemetry.enqueue({ ...baseMeterEvent(p, 'ATTEMPT_COMPLETED'), status: 'ERROR', reasonCode: p.errorCode,
        providerAttempts: Array.isArray(p.providerAttempts) ? p.providerAttempts.length : undefined,
        providerAttemptDetails: Array.isArray(p.providerAttempts) ? p.providerAttempts.slice(0, 4) : undefined,
        errorCode: p.errorCode, errorMessage: p.errorMessage ? String(p.errorMessage).slice(0, 500) : null });
};
exports.logMeterUserConfirmed = p => {
    if (!p.operationId) return legacyMeterConfirmation(p);
    const selectedAttemptId = p.selectedAttemptId || p.attemptId;
    const explicitManualNoProposal = p.noProposal === true && p.inputSource === 'MANUAL' && !selectedAttemptId
        && p.aiReadingValue == null && (p.aiReadingText == null || p.aiReadingText === '');
    const evaluation = explicitManualNoProposal
        ? evaluateMeter({ readingValue: null, readingText: null }, { referenceValue: p.userReadingValue, referenceText: p.userReadingText })
        : { numericEvaluable: false, characterEvaluable: false };
    if (explicitManualNoProposal && evaluation.proposalCharacterEvaluable) evaluation.ksrReferenceSource = 'MANUAL_CONFIRMED_NO_PROPOSAL';
    telemetry.enqueue({ ...baseMeterEvent(p, 'USER_CONFIRMED'), engine: p.engine || 'UNKNOWN', status: 'CONFIRMED',
        payload: { meter: { readingValue: p.aiReadingValue, readingText: p.aiReadingText,
            rawReadingValue: p.rawReadingValue, rawReadingText: p.rawReadingText,
            normalizationReasons: p.normalizationReasons, selectedSuggestionSource: p.selectedSuggestionSource,
            noProposal: explicitManualNoProposal,
            referenceValue: p.userReadingValue, referenceText: p.userReadingText, selectedAttemptId } },
        evaluation, evaluatorVersion: 'meter-2.2',
        dataQuality: { pairingStatus: selectedAttemptId ? 'MISSING_ATTEMPT' : 'MANUAL', referenceSource: 'USER_CONFIRMED' },
        userReadingValue: p.userReadingValue, userReadingText: p.userReadingText,
        aiReadingValue: p.aiReadingValue, aiReadingText: p.aiReadingText,
        readingDelta: evaluation.absoluteError ?? null, wasEdited: evaluation.corrected ?? null });
};
exports.logTelemetryEvent = telemetry.enqueue;

const receiptEvaluator = require('./receipt-metrics-evaluator');
const legacyReceiptResponse = exports.logReceiptAiResponse;
const legacyReceiptConfirmed = exports.logReceiptUserConfirmed;
const legacyReceiptError = exports.logReceiptAiError;
const baseReceiptEvent = (p, eventType) => ({
    userId: p.userId, schemaVersion: 2, feature: 'RECEIPT', pipelineVersion: p.pipelineVersion || 'receipt-v2',
    operationId: p.operationId, sessionId: p.sessionId || p.operationId, attemptId: p.attemptId,
    draftId: p.draftId, eventId: p.eventId || `${p.attemptId || p.operationId}:${p.draftId || 'operation'}:${eventType}`,
    eventType, origin: 'SERVER', engine: 'GEMINI', platform: p.platform || 'UNKNOWN',
    occurredAt: new Date(), receivedAt: new Date(), aiModel: p.aiModel, cacheHit: p.cacheHit, inputMode: p.inputMode,
    timings: { processingMs: p.endToEndLatencyMs ?? p.latencyMs, providerMs: p.modelLatencyMs ?? p.latencyMs,
        timeToPreviewMs: typeof p.timeToPreviewMs === 'number' && Number.isFinite(p.timeToPreviewMs) && p.timeToPreviewMs >= 0 ? p.timeToPreviewMs : undefined,
        timeToConfirmMs: typeof p.timeToConfirmMs === 'number' && Number.isFinite(p.timeToConfirmMs) && p.timeToConfirmMs >= 0 ? p.timeToConfirmMs : undefined },
    businessRef: p.businessRef
});
exports.logReceiptAiResponse = p => {
    if (!p.operationId) return legacyReceiptResponse(p);
    const attempts = p.providerAttempts || [];
    telemetry.enqueue({ ...baseReceiptEvent(p, 'ATTEMPT_COMPLETED'), stage: 'NORMALIZED_DRAFT', status: 'READABLE',
        payload: { receipt: { raw: receiptEvaluator.snapshot(p.rawDraft), predicted: receiptEvaluator.snapshot(p.draft) } },
        providerAttempts: p.cacheHit ? 0 : (p.providerAttemptCount ?? attempts.length),
        providerAttemptDetails: p.cacheHit ? [] : attempts.slice(0, 4).map(a => ({ model: a.model, durationMs: a.durationMs, status: a.status, code: a.code || a.errorCode })),
        tokenUsage: p.tokenUsage ? { input: p.tokenUsage.promptTokenCount ?? p.tokenUsage.input, output: p.tokenUsage.candidatesTokenCount ?? p.tokenUsage.output, total: p.tokenUsage.totalTokenCount ?? p.tokenUsage.total } : undefined,
        warningCount: p.warningCount, blockingWarningCount: p.blockingWarningCount, hasWarnings: p.hasWarnings });
};
exports.logReceiptUserConfirmed = p => {
    if (!p.operationId) return legacyReceiptConfirmed(p);
    telemetry.enqueue({ ...baseReceiptEvent(p, 'USER_CONFIRMED'), engine: 'UNKNOWN', stage: 'CONFIRMATION', status: 'CONFIRMED',
        payload: { receipt: { reference: receiptEvaluator.snapshot(p.finalDraft), selectedAttemptId: p.selectedAttemptId } },
        evaluatorVersion: 'receipt-2.0', dataQuality: { pairingStatus: 'MISSING_ATTEMPT', referenceSource: 'USER_CONFIRMED' } });
};
exports.logReceiptAiError = p => {
    if (!p.operationId) return legacyReceiptError(p);
    telemetry.enqueue({ ...baseReceiptEvent(p, 'ATTEMPT_COMPLETED'), status: 'ERROR', stage: p.failureStage || 'PROVIDER',
        reasonCode: p.errorCode, errorCode: p.errorCode, errorMessage: p.errorMessage ? String(p.errorMessage).slice(0, 500) : undefined,
        providerAttempts: p.providerAttemptCount ?? p.providerAttempts?.length,
        providerAttemptDetails: (p.providerAttempts || []).slice(0, 4).map(a => ({ model: a.model, durationMs: a.durationMs, status: a.status, code: a.code || a.errorCode })) });
};

exports.logRecipeSaved = ({ userId, sessionId, recipeId }) => {
 _insert({ userId, feature: 'RECIPE_SUGGEST', pipelineVersion: 'recipe-metrics-2', eventType: 'RESULT_PRESENTED', stage: 'DRAFT_SAVED', sessionId, operationId: sessionId, recipeId, origin: 'SERVER' });
};
