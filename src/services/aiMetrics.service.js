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
    aiItemCount = null, aiTotalAmount = null, hasWarnings = null
}) => {
    _insert({
        userId, feature: 'RECEIPT', eventType: 'AI_RESPONSE', sessionId,
        latencyMs, aiModel, cacheHit, inputMode,
        aiItemCount, aiTotalAmount, hasWarnings
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
    totalFieldCount = null, wasEdited = null
}) => {
    // Tính sẵn delta và accuracy để query báo cáo không phải compute
    const amountDelta = null; // không có aiTotalAmount tại đây nên bỏ qua

    let fieldAccuracyPct = null;
    if (
        typeof editedFieldCount === 'number' &&
        typeof totalFieldCount === 'number' &&
        totalFieldCount > 0
    ) {
        fieldAccuracyPct = Math.max(
            0,
            Math.round((1 - editedFieldCount / totalFieldCount) * 10000) / 100
        );
    }

    const itemCountDelta = (typeof userItemCount === 'number' && typeof aiItemCount === 'number')
        ? userItemCount - aiItemCount
        : null;

    _insert({
        userId, feature: 'RECEIPT', eventType: 'USER_CONFIRMED', sessionId,
        userItemCount, userTotalAmount,
        editedFieldCount, totalFieldCount,
        wasEdited: wasEdited ?? (typeof editedFieldCount === 'number' ? editedFieldCount > 0 : null),
        itemCountDelta, fieldAccuracyPct, amountDelta
    });
};

/**
 * Ghi khi AI hóa đơn bị lỗi (timeout, API error, parse fail).
 * Gọi trong parseDocument catch, KHÔNG await.
 */
exports.logReceiptAiError = ({
    userId, sessionId, inputMode = null,
    errorCode = null, errorMessage = null
}) => {
    _insert({
        userId, feature: 'RECEIPT', eventType: 'AI_ERROR', sessionId,
        inputMode, errorCode,
        errorMessage: errorMessage ? String(errorMessage).slice(0, 500) : null
    });
};

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
    aiModel = null, aiReadingValue = null
}) => {
    _insert({
        userId, feature: 'METER_OCR', eventType: 'AI_RESPONSE', sessionId,
        latencyMs, aiModel, inputMode: 'meter_image',
        aiReadingValue,
        hasWarnings: aiReadingValue === null // null reading = AI không chắc
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
    wasEdited = null, inputSource = null
}) => {
    const readingDelta = (typeof aiReadingValue === 'number' && typeof userReadingValue === 'number')
        ? Math.abs(userReadingValue - aiReadingValue)
        : null;

    _insert({
        userId, feature: 'METER_OCR', eventType: 'USER_CONFIRMED', sessionId,
        inputMode: inputSource === 'MANUAL' ? 'manual_text' : 'meter_image',
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
    usedAiFallback = false, suggestionCount = null, aiModel = null
}) => {
    _insert({
        userId, feature: 'RECIPE_SUGGEST', eventType: 'AI_RESPONSE', sessionId,
        latencyMs, aiModel, usedAiFallback, suggestionCount
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
    suggestionRank = null, cookSuccess = false, usedAiFallback = false
}) => {
    _insert({
        userId, feature: 'RECIPE_SUGGEST', eventType: 'USER_CONFIRMED', sessionId,
        suggestionRank, cookSuccess, usedAiFallback
    });
};
