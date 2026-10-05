const mongoose = require('mongoose');
const textField = max => ({ type: String, maxlength: max });
const nonNegative = { type: Number, min: 0 };
const receiptItemV2 = new mongoose.Schema({
    sourceLineId: textField(160),
    rawName: textField(300), itemName: textField(300), quantity: nonNegative,
    unit: textField(30), unitPrice: nonNegative, lineTotal: nonNegative,
    category: textField(80), subCategory: textField(80), brand: textField(100),
    standardQuantity: nonNegative, standardUnit: textField(30),
    measurementStatus: textField(40), measurementBasis: {
        scope: { type: String, enum: ['PER_PURCHASE_UNIT', 'TOTAL'] }, quantity: nonNegative,
        unit: { type: String, enum: ['G', 'ML', 'PIECE'] }, evidence: textField(200)
    }, measurementEvidence: [textField(200)],
    expiryDate: textField(40), storageLocation: textField(80),
    source: textField(40), warningCodes: [textField(80)]
}, { _id: false, strict: true });
receiptItemV2.path('warningCodes').validate(value => !value || value.length <= 30, 'Too many receipt warning codes');
receiptItemV2.path('measurementEvidence').validate(value => !value || value.length <= 8, 'Too much measurement evidence');
const receiptSnapshotV2 = new mongoose.Schema({
    truncated: Boolean, originalItemCount: nonNegative,
    merchantName: textField(300), date: textField(40), category: textField(80),
    totalAmount: nonNegative, discount: nonNegative, items: [receiptItemV2]
}, { _id: false, strict: true });

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
        enum: ['RECEIPT', 'METER_OCR', 'RECIPE_SUGGEST', 'GAMIFICATION', 'INSIGHT'],
        required: true,
        index: true
    },
    subFeature: { type: String, trim: true, maxlength: 50, default: null },
    meterType: {
        type: String,
        enum: ['POWER', 'WATER'],
        required: function() { return this.feature === 'METER_OCR'; }
    },

    /**
     * Loại sự kiện.
     * AI_RESPONSE     — AI vừa trả kết quả (đo latency, output)
     * USER_CONFIRMED  — user xác nhận lưu (đo delta AI vs final)
     * AI_ERROR        — AI thất bại hoàn toàn (không đọc được ảnh, timeout)
     */
    eventType: {
        type: String,
        enum: ['AI_RESPONSE', 'USER_CONFIRMED', 'AI_ERROR', 'OPERATION_STARTED', 'ATTEMPT_STARTED', 'ATTEMPT_COMPLETED', 'RESULT_PRESENTED', 'OPERATION_CANCELLED', 'EVALUATION_COMPLETED'],
        required: true
    },

    /** Nối sự kiện AI_RESPONSE ↔ USER_CONFIRMED trong cùng một lần thao tác. */
    sessionId: { type: String, trim: true, maxlength: 150, index: true },
    schemaVersion: { type: Number, default: 1 },
    pipelineVersion: { type: String, maxlength: 80 },
    evaluatorVersion: { type: String, maxlength: 80 },
    operationId: { type: String, maxlength: 160 },
    attemptId: { type: String, maxlength: 160 },
    eventId: { type: String, maxlength: 160 },
    parentAttemptId: { type: String, maxlength: 160 },
    draftId: { type: String, maxlength: 160 },
    stage: { type: String, maxlength: 80 },
    origin: { type: String, enum: ['CLIENT', 'SERVER'] },
    status: { type: String, enum: ['STARTED', 'READABLE', 'AMBIGUOUS', 'UNREADABLE', 'ERROR', 'CANCELLED', 'CONFIRMED'] },
    reasonCode: { type: String, maxlength: 80 },
    warningCodes: [{ type: String, maxlength: 80 }],
    occurredAt: Date,
    receivedAt: Date,
    timings: {
        processingMs: { type: Number, min: 0 },
        timeToPreviewMs: { type: Number, min: 0 },
        timeToConfirmMs: { type: Number, min: 0 },
        providerMs: { type: Number, min: 0 }
    },
    providerAttempts: { type: Number, min: 0 },
    providerAttemptDetails: [{ _id: false, model: { type: String, maxlength: 80 }, durationMs: { type: Number, min: 0 }, status: { type: String, maxlength: 40 }, code: { type: String, maxlength: 80 } }],
    retryCount: { type: Number, min: 0 },
    tokenUsage: { input: { type: Number, min: 0 }, output: { type: Number, min: 0 }, total: { type: Number, min: 0 } },
    confidence: { value: { type: Number, min: 0, max: 1 }, source: { type: String, maxlength: 40 }, reasons: [{ type: String, maxlength: 80 }] },
    businessRef: { type: { type: String, maxlength: 40 }, id: { type: String, maxlength: 160 } },
    payload: {
        meter: {
            rawReadingText: { type: String, maxlength: 32 }, rawReadingValue: { type: Number, min: 0 },
            readingText: { type: String, maxlength: 32 }, readingValue: { type: Number, min: 0 },
            normalizationReasons: [{ type: String, maxlength: 80 }],
            suggestions: [{ _id: false, readingText: { type: String, maxlength: 32 }, readingValue: { type: Number, min: 0 }, source: { type: String, enum: ['OCR', 'HISTORY'] }, reasonCode: { type: String, maxlength: 80 } }],
            selectedSuggestionSource: { type: String, enum: ['OCR', 'HISTORY', 'MANUAL'] },
            noProposal: Boolean,
            physicalReferenceText: { type: String, maxlength: 32 }, physicalReferenceSource: { type: String, enum: ['IMAGE_REVIEW'] },
            referenceText: { type: String, maxlength: 32 }, referenceValue: { type: Number, min: 0 },
            previousReadingValue: { type: Number, min: 0 }, selectedAttemptId: { type: String, maxlength: 160 },
            decisionReasons: [{ type: String, maxlength: 80 }],
            candidates: [{ _id: false, readingText: { type: String, maxlength: 32 }, readingValue: { type: Number, min: 0 }, sourcePass: { type: String, maxlength: 40 }, score: Number, reasons: [{ type: String, maxlength: 80 }] }]
        },
        receipt: {
            raw: receiptSnapshotV2, predicted: receiptSnapshotV2, reference: receiptSnapshotV2,
            selectedAttemptId: textField(160),
            merchantName: { type: String, maxlength: 300 }, date: { type: String, maxlength: 40 }, totalAmount: { type: Number, min: 0 }, referenceTotalAmount: { type: Number, min: 0 },
            items: [{ _id: false, rawName: { type: String, maxlength: 300 }, itemName: { type: String, maxlength: 300 }, quantity: { type: Number, min: 0 }, unit: { type: String, maxlength: 30 }, unitPrice: { type: Number, min: 0 }, lineTotal: { type: Number, min: 0 }, source: { type: String, maxlength: 40 } }]
        },
        recipe: { outcome: textField(60), query: { type: String, maxlength: 1000 }, returnedRecipeIds: [{ type: String, maxlength: 160 }], selectedRecipeId: { type: String, maxlength: 160 }, selectedRank: { type: Number, min: 1 }, canCook: Boolean, cookSuccess: Boolean,
            candidates: [{ _id: false, recipeId: textField(160), rank: { type: Number, min: 1 }, source: textField(40), score: Number, canCook: Boolean, requiredMissingCount: nonNegative, matchedIngredientCount: nonNegative, reviewRequiredCount: nonNegative, feasibleServings: nonNegative, ingredientCoveragePercent: { type: Number, min: 0, max: 100 } }]
        },
        insight: { insightType: { type: String, maxlength: 60 }, validatorPassed: Boolean, validationCodes: [{ type: String, maxlength: 80 }], finalSource: { type: String, maxlength: 40 }, factSnapshotId: { type: String, maxlength: 160 },
            facts: [{ _id: false, code: textField(80), numericValue: Number, textValue: textField(200), unit: textField(30) }],
            evidence: [{ _id: false, factCode: textField(80), numericValue: Number, textValue: textField(200) }],
            predictedOutput: { headline: textField(300), summary: textField(2000), actionCodes: [textField(80)] },
            finalOutput: { headline: textField(300), summary: textField(2000), actionCodes: [textField(80)] }
        }
    },
    evaluation: { numericEvaluable: Boolean, exactNumericMatch: Boolean, absoluteError: { type: Number, min: 0 }, characterEvaluable: Boolean, editDistance: { type: Number, min: 0 }, referenceLength: { type: Number, min: 0 }, cerPct: { type: Number, min: 0 }, corrected: Boolean,
        proposalCharacterEvaluable: Boolean, proposalEditDistance: nonNegative, proposalLength: nonNegative, finalLength: nonNegative,
        proposalSimilarityPct: { type: Number, min: 0, max: 100 }, ksrPct: Number,
        ksrReasonCode: textField(80), ksrReferenceSource: textField(50),
        rawCharacterEvaluable: Boolean, rawEditDistance: nonNegative, rawReferenceLength: nonNegative, rawCerPct: nonNegative,
        fieldCount: nonNegative, correctFieldCount: nonNegative, editedFieldCount: nonNegative,
        fieldAccuracyPct: { type: Number, min: 0, max: 100 }, nameEditDistance: nonNegative, nameReferenceLength: nonNegative, nameKsrPct: Number,
        receiptEvaluable: Boolean,
        fieldResults: {
            merchantName: { total: nonNegative, correct: nonNegative }, date: { total: nonNegative, correct: nonNegative }, totalAmount: { total: nonNegative, correct: nonNegative }, discount: { total: nonNegative, correct: nonNegative },
            itemName: { total: nonNegative, correct: nonNegative }, quantity: { total: nonNegative, correct: nonNegative }, unit: { total: nonNegative, correct: nonNegative },
            unitPrice: { total: nonNegative, correct: nonNegative }, lineTotal: { total: nonNegative, correct: nonNegative }, standardQuantity: { total: nonNegative, correct: nonNegative }, standardUnit: { total: nonNegative, correct: nonNegative }
        },
        measureErrors: [{ _id: false, unit: { type: String, enum: ['G', 'ML', 'PIECE'] }, count: nonNegative, absoluteErrorSum: nonNegative, mae: nonNegative }],
        amountExactMatch: Boolean, amountAbsoluteError: nonNegative, rawFieldAccuracyPct: { type: Number, min: 0, max: 100 },
        truePositives: nonNegative, falsePositives: nonNegative, falseNegatives: nonNegative,
        precision: { type: Number, min: 0, max: 1 }, recall: { type: Number, min: 0, max: 1 }, f1: { type: Number, min: 0, max: 1 },
        semanticScore: { type: Number, min: 0, max: 1 }, rubricScore: { type: Number, min: 0, max: 10 },
        rubricVersion: textField(80), gradingSource: textField(40)
    },
    dataQuality: { pairingStatus: { type: String, enum: ['PAIRED', 'MISSING_ATTEMPT', 'MISSING_REFERENCE', 'MANUAL', 'PENDING'] }, missingFields: [{ type: String, maxlength: 80 }], referenceSource: { type: String, maxlength: 50 } },

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
    aiReadingText:  { type: String, trim: true, maxlength: 32, default: null }, // công tơ: text AI đọc được
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
    userReadingText:  { type: String, trim: true, maxlength: 32, default: null }, // công tơ: text user nhập
    characterEditDistance: { type: Number, min: 0, default: null },
    characterErrorRatePct: { type: Number, min: 0, default: null },
    characterAccuracyPct:  { type: Number, min: 0, max: 100, default: null },
    editedFieldCount: { type: Number, min: 0, default: null }, // tổng trường bị sửa
    totalFieldCount:  { type: Number, min: 0, default: null }, // tổng trường AI đề xuất (mẫu số)
    wasEdited:        { type: Boolean, default: null },         // shortcut: editedFieldCount > 0

    // ── Chỉ số delta (tính sẵn khi insert) ───────────────────────────────
    /** itemCountDelta = userItemCount - aiItemCount. Dương = AI bỏ sót item. */
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
aiMetricsSchema.index({ userId: 1, feature: 1, occurredAt: -1 });
aiMetricsSchema.index({ userId: 1, operationId: 1, occurredAt: 1 });
aiMetricsSchema.index({ userId: 1, eventId: 1 }, { unique: true, partialFilterExpression: { schemaVersion: 2, eventId: { $type: 'string' } } });
// Bound future feature forms as well as the currently active meter endpoint.
for (const [path, limit] of Object.entries({
    'payload.meter.candidates': 8, 'payload.meter.decisionReasons': 12,
    'payload.meter.normalizationReasons': 12, 'payload.meter.suggestions': 2,
    'payload.receipt.items': 200, 'payload.receipt.predicted.items': 200, 'payload.receipt.reference.items': 200,
    'payload.receipt.raw.items': 200,
    'payload.recipe.returnedRecipeIds': 100, 'payload.recipe.candidates': 100,
    'payload.insight.facts': 100, 'payload.insight.evidence': 100, 'payload.insight.validationCodes': 30,
    'payload.insight.predictedOutput.actionCodes': 20, 'payload.insight.finalOutput.actionCodes': 20,
    warningCodes: 12, providerAttemptDetails: 4
})) {
    const schemaPath = aiMetricsSchema.path(path);
    if (schemaPath) schemaPath.validate(value => !value || value.length <= limit, `Too many entries: ${path}`);
}

module.exports = mongoose.model('AiMetrics', aiMetricsSchema);
