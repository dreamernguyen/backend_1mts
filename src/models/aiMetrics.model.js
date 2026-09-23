const mongoose = require('mongoose');

/**
 * aiMetrics — Đo lường tự động hiệu quả AI và hành vi người dùng.
 *
 * Mỗi lần người dùng dùng tính năng AI, hệ thống ghi 2 sự kiện:
 *   1. AI_RESPONSE  — ngay sau khi AI trả kết quả.
 *   2. USER_CONFIRMED — khi người dùng xác nhận lưu (so sánh AI vs final).
 *
 * Hai sự kiện được nối qua sessionId (= requestId/scanRequestId từ client).
 * Delta giữa AI đề xuất và giá trị user lưu là proxy chất lượng khách quan.
 */
const aiMetricsSchema = new mongoose.Schema({
    // ── Định danh sự kiện ──────────────────────────────────────────────────
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },

    /**
     * Tính năng AI tương ứng.
     * RECEIPT          — quét hóa đơn mua sắm (Gemini vision/text)
     * METER_OCR        — quét chỉ số công tơ điện/nước (Gemini + ML Kit)
     * RECIPE_SUGGEST   — gợi ý món ăn từ kho (thuật toán + AI fallback)
     * GAMIFICATION     — phân tích HP/MANA/DEF/WIS bằng Gemini
     */
    feature: {
        type: String,
        enum: ['RECEIPT', 'METER_OCR', 'RECIPE_SUGGEST', 'GAMIFICATION'],
        required: true,
        index: true
    },
    subFeature: { type: String, trim: true, maxlength: 50, default: null },

    /**
     * Loại sự kiện.
     * AI_RESPONSE     — AI vừa trả kết quả (đo latency, output)
     * USER_CONFIRMED  — user xác nhận lưu (đo delta AI vs final)
     * AI_ERROR        — AI thất bại hoàn toàn (không đọc được ảnh, timeout)
     */
    eventType: {
        type: String,
        enum: ['AI_RESPONSE', 'USER_CONFIRMED', 'AI_ERROR'],
        required: true
    },

    /** Nối sự kiện AI_RESPONSE ↔ USER_CONFIRMED trong cùng một lần thao tác. */
    sessionId: { type: String, trim: true, maxlength: 150, index: true },

    // ── Hiệu suất AI ──────────────────────────────────────────────────────
    latencyMs:  { type: Number, min: 0, default: null },
    modelLatencyMs: { type: Number, min: 0, default: null },
    endToEndLatencyMs: { type: Number, min: 0, default: null },
    inputMode:  { type: String, trim: true, maxlength: 50, default: null },
    // image | ocr_text | manual_text | meter_image | recipe_rag
    cacheHit:   { type: Boolean, default: null },
    aiModel:    { type: String, trim: true, maxlength: 80, default: null },
    platform:   { type: String, enum: ['WEB', 'ANDROID', 'IOS', 'DESKTOP', 'UNKNOWN'], default: 'UNKNOWN' },
    engine:     { type: String, enum: ['GEMINI', 'ML_KIT', 'RULE_DB', 'UNKNOWN'], default: 'UNKNOWN' },
    fallbackChain: { type: String, trim: true, maxlength: 120, default: null },
    resultStatus: { type: String, enum: ['SUCCESS', 'FALLBACK', 'ERROR', 'VALIDATION_REJECTED'], default: null },
    failureStage: { type: String, trim: true, maxlength: 80, default: null },

    // ── Output AI (tại lúc AI trả — eventType = AI_RESPONSE) ─────────────
    aiItemCount:    { type: Number, min: 0, default: null }, // hóa đơn: số item trích được
    aiTotalAmount:  { type: Number, min: 0, default: null }, // hóa đơn: tổng tiền AI đọc
    aiReadingValue: { type: Number, min: 0, default: null }, // công tơ: chỉ số AI đọc
    hasWarnings:    { type: Boolean, default: null },        // AI có trả warnings không
    warningCount: { type: Number, min: 0, default: null },
    blockingWarningCount: { type: Number, min: 0, default: null },
    // Snapshot đã chuẩn hóa, tối thiểu cho việc đối chiếu khi user xác nhận.
    // Không lưu ảnh, prompt hay raw OCR.
    receiptSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },

    // ── Chỉnh sửa của user (tại lúc user xác nhận — eventType = USER_CONFIRMED) ──
    userItemCount:    { type: Number, min: 0, default: null },
    userTotalAmount:  { type: Number, min: 0, default: null },
    userReadingValue: { type: Number, min: 0, default: null },
    editedFieldCount: { type: Number, min: 0, default: null }, // tổng trường bị sửa
    totalFieldCount:  { type: Number, min: 0, default: null }, // tổng trường AI đề xuất (mẫu số)
    wasEdited:        { type: Boolean, default: null },         // shortcut: editedFieldCount > 0

    // ── Chỉ số delta (tính sẵn khi insert) ───────────────────────────────
    /** itemCountDelta = userItemCount - aiItemCount. Âm = AI bỏ sót item. */
    itemCountDelta:   { type: Number, default: null },
    /** |userTotalAmount - aiTotalAmount| — tiền lệch tuyệt đối. */
    amountDelta:      { type: Number, min: 0, default: null },
    /** amountDelta / aiTotalAmount * 100 — % sai số tiền. */
    amountDeltaPct:   { type: Number, min: 0, default: null },
    /** |userReadingValue - aiReadingValue| — đơn vị sai số công tơ. */
    readingDelta:     { type: Number, min: 0, default: null },
    /** (1 - editedFieldCount/totalFieldCount) * 100 — % trường AI đúng. */
    fieldAccuracyPct: { type: Number, min: 0, max: 100, default: null },

    // ── Recipe / Gợi ý ───────────────────────────────────────────────────
    suggestionCount:  { type: Number, min: 0, default: null }, // số gợi ý trả về
    suggestionRank:   { type: Number, min: 1, default: null }, // user chọn gợi ý thứ mấy
    recipeId: { type: String, trim: true, maxlength: 160, default: null },
    recommendationSource: { type: String, trim: true, maxlength: 40, default: null },
    usedAiFallback:   { type: Boolean, default: null },        // có gọi Gemini không
    cookSuccess:      { type: Boolean, default: null },        // trừ kho thành công

    // ── Lỗi ──────────────────────────────────────────────────────────────
    errorCode:    { type: String, trim: true, maxlength: 80,  default: null },
    errorMessage: { type: String, trim: true, maxlength: 500, default: null }

}, {
    timestamps: true,
    // Không cần versionKey cho collection log — tránh field thừa
    versionKey: false
});

// Index tra cứu nhanh khi query báo cáo
aiMetricsSchema.index({ feature: 1, eventType: 1, createdAt: -1 });
aiMetricsSchema.index({ userId: 1, feature: 1, createdAt: -1 });

module.exports = mongoose.model('AiMetrics', aiMetricsSchema);
