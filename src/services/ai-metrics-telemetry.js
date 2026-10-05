const Model = require('../models/aiMetrics.model');
const { evaluateMeter } = require('./meter-metrics-evaluator');
const { evaluateReceipt } = require('./receipt-metrics-evaluator');
const CLIENT_EVENTS = ['OPERATION_STARTED', 'ATTEMPT_STARTED', 'ATTEMPT_COMPLETED', 'RESULT_PRESENTED', 'OPERATION_CANCELLED'];
const STATS = { failed: 0, duplicate: 0, dropped: 0 };
let pending = 0;
const MAX_PENDING = 100;
const operationWrites = new Map();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function validateClientEvent(body, userId) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Buffer.byteLength(JSON.stringify(body)) > 16384) throw new Error('Payload metrics vượt giới hạn');
    if (!CLIENT_EVENTS.includes(body.eventType) || !['METER_OCR', 'RECEIPT', 'RECIPE_SUGGEST'].includes(body.feature)) throw new Error('Sự kiện metrics chưa được hỗ trợ');
    const out = {};
    const keys = ['feature', 'meterType', 'operationId', 'eventId', 'attemptId', 'parentAttemptId', 'draftId', 'eventType', 'stage', 'status', 'engine', 'platform', 'occurredAt', 'timings', 'payload', 'reasonCode', 'warningCodes', 'pipelineVersion'];
    for (const key of keys) if (body[key] !== undefined) out[key] = body[key];
    if (out.status === 'CLEAR') out.status = 'READABLE';
    for (const key of ['feature', 'meterType', 'operationId', 'eventId', 'attemptId', 'parentAttemptId', 'eventType', 'stage', 'status', 'engine', 'platform', 'occurredAt', 'reasonCode', 'pipelineVersion']) {
        if (out[key] !== undefined && typeof out[key] !== 'string') throw new Error('Trường văn bản metrics không hợp lệ');
    }
    for (const key of ['operationId', 'eventId']) if (typeof out[key] !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(out[key])) throw new Error('Thiếu hoặc sai mã sự kiện');
    if (['ATTEMPT_STARTED', 'ATTEMPT_COMPLETED'].includes(out.eventType) && !out.attemptId) throw new Error('Thiếu mã lần xử lý');
    for (const key of ['attemptId', 'parentAttemptId', 'draftId']) if (out[key] !== undefined && (typeof out[key] !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(out[key]))) throw new Error('Sai mã lần xử lý');
    if (out.feature === 'METER_OCR' && !['POWER', 'WATER'].includes(out.meterType)) throw new Error('Loại công tơ không hợp lệ');
    if (out.engine && !['ML_KIT', 'UNKNOWN', ...(out.eventType === 'RESULT_PRESENTED' ? ['GEMINI'] : [])].includes(out.engine)) throw new Error('Client không được ghi nhận kết quả provider');
    if (out.occurredAt && !Number.isFinite(Date.parse(out.occurredAt))) throw new Error('Thời điểm không hợp lệ');
    const meter = out.payload?.meter;
    const validStringList = value => Array.isArray(value) && value.length <= 12 && value.every(item => typeof item === 'string' && item.length <= 80);
    if (out.warningCodes !== undefined && !validStringList(out.warningCodes)) throw new Error('Warning không hợp lệ');
    for (const [key, value] of Object.entries(out.timings || {})) if (!['processingMs', 'timeToPreviewMs', 'timeToConfirmMs', 'providerMs'].includes(key) || typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 3600000) throw new Error('Thời gian metrics không hợp lệ');
    if (out.feature === 'RECIPE_SUGGEST') {
        if (out.eventType !== 'RESULT_PRESENTED' || out.payload || out.engine && out.engine !== 'UNKNOWN'
            || Object.keys(out.timings || {}).some(key => key !== 'timeToPreviewMs')) throw new Error('Client chỉ được ghi thời gian hiển thị gợi ý');
        out.sessionId = out.operationId;
        out.userId = userId; out.schemaVersion = 2; out.origin = 'CLIENT'; out.receivedAt = new Date();
        out.occurredAt = out.occurredAt ? new Date(out.occurredAt) : out.receivedAt;
        const doc = new Model(out);
        if (doc.validateSync()) throw new Error('Trường metrics không hợp lệ');
        return doc.toObject();
    }
    if (out.feature === 'RECEIPT') {
        if (out.payload && (Object.keys(out.payload).some(key => key !== 'receipt') || !out.payload.receipt || typeof out.payload.receipt !== 'object' || Object.keys(out.payload.receipt).some(key => key !== 'selectedAttemptId'))) throw new Error('Client chỉ được gửi metadata receipt');
        const selected = out.payload?.receipt?.selectedAttemptId;
        if (selected !== undefined && (typeof selected !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(selected))) throw new Error('Sai mã kết quả receipt');
        out.userId = userId; out.schemaVersion = 2; out.origin = 'CLIENT'; out.receivedAt = new Date();
        out.occurredAt = out.occurredAt ? new Date(out.occurredAt) : out.receivedAt;
        const doc = new Model(out);
        if (doc.validateSync()) throw new Error('Trường metrics không hợp lệ');
        return doc.toObject();
    }
    for (const key of ['readingValue', 'rawReadingValue', 'previousReadingValue']) if (meter?.[key] !== undefined && meter[key] !== null && (typeof meter[key] !== 'number' || !Number.isFinite(meter[key]) || meter[key] < 0)) throw new Error('Chỉ số metrics không hợp lệ');
    if (out.payload && (Object.keys(out.payload).some(key => key !== 'meter') || !meter || typeof meter !== 'object')) throw new Error('Sai snapshot công tơ');
    if (meter?.selectedAttemptId && (typeof meter.selectedAttemptId !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(meter.selectedAttemptId))) throw new Error('Sai mã kết quả được chọn');
    if (meter?.candidates !== undefined && !Array.isArray(meter.candidates)) throw new Error('Candidate phải là danh sách');
    if (meter?.decisionReasons !== undefined && !Array.isArray(meter.decisionReasons)) throw new Error('Lý do phải là danh sách');
    if (meter && (meter.referenceText !== undefined || meter.referenceValue !== undefined)) throw new Error('Client không được gửi nhãn xác nhận');
    const unknownMeterKeys = Object.keys(meter || {}).filter(key => !['readingText', 'readingValue', 'rawReadingText', 'rawReadingValue', 'normalizationReasons', 'suggestions', 'selectedSuggestionSource', 'previousReadingValue', 'selectedAttemptId', 'decisionReasons', 'candidates'].includes(key));
    if (unknownMeterKeys.length) throw new Error(`Trường snapshot công tơ chưa được hỗ trợ: ${unknownMeterKeys.slice(0, 4).join(', ')}`);
    if ((meter?.candidates?.length || 0) > 8 || (meter?.decisionReasons?.length || 0) > 12 || (out.warningCodes?.length || 0) > 12) throw new Error('Snapshot vượt giới hạn');
    if (meter?.candidates?.some(c => !c || Object.keys(c).some(key => !['readingText', 'readingValue', 'sourcePass', 'score', 'reasons'].includes(key)) || (c.reasons?.length || 0) > 12)) throw new Error('Candidate không hợp lệ');
    if (meter?.decisionReasons !== undefined && !validStringList(meter.decisionReasons)) throw new Error('Lý do không hợp lệ');
    if (meter?.normalizationReasons !== undefined && !validStringList(meter.normalizationReasons)) throw new Error('Lý do chuẩn hóa không hợp lệ');
    if (meter?.suggestions !== undefined && (!Array.isArray(meter.suggestions) || meter.suggestions.length > 2)) throw new Error('Gợi ý vượt giới hạn');
    for (const suggestion of meter?.suggestions || []) {
        if (!suggestion || typeof suggestion !== 'object' || Object.keys(suggestion).some(key => !['readingText', 'readingValue', 'source', 'reasonCode'].includes(key)) || !['OCR', 'HISTORY'].includes(suggestion.source)
            || typeof suggestion.readingValue !== 'number' || !Number.isFinite(suggestion.readingValue) || suggestion.readingValue < 0
            || typeof suggestion.readingText !== 'string' || suggestion.readingText.length > 32
            || (suggestion.reasonCode !== undefined && (typeof suggestion.reasonCode !== 'string' || suggestion.reasonCode.length > 80))) throw new Error('Gợi ý không hợp lệ');
    }
    for (const candidate of meter?.candidates || []) {
        for (const key of ['readingValue', 'score']) if (candidate[key] !== undefined && candidate[key] !== null && (typeof candidate[key] !== 'number' || !Number.isFinite(candidate[key]) || (key === 'readingValue' && candidate[key] < 0))) throw new Error('Giá trị candidate không hợp lệ');
        if (candidate.reasons !== undefined && !validStringList(candidate.reasons)) throw new Error('Lý do candidate không hợp lệ');
        for (const key of ['readingText', 'sourcePass']) if (candidate[key] !== undefined && candidate[key] !== null && typeof candidate[key] !== 'string') throw new Error('Chuỗi candidate không hợp lệ');
    }
    for (const key of ['readingText', 'rawReadingText']) if (meter?.[key] !== undefined && meter[key] !== null && typeof meter[key] !== 'string') throw new Error('Chuỗi chỉ số không hợp lệ');
    out.userId = userId; out.schemaVersion = 2; out.origin = 'CLIENT'; out.receivedAt = new Date();
    out.occurredAt = out.occurredAt ? new Date(out.occurredAt) : out.receivedAt;
    const doc = new Model(out);
    const error = doc.validateSync();
    if (error) throw new Error('Trường metrics không hợp lệ');
    return doc.toObject();
}

async function reconcile(payload) {
    if (payload.feature === 'RECEIPT') return reconcileReceipt(payload);
    if (payload.feature !== 'METER_OCR' || !payload.operationId || !['ATTEMPT_COMPLETED', 'USER_CONFIRMED'].includes(payload.eventType)) return;
    const filter = { userId: payload.userId, schemaVersion: 2, feature: 'METER_OCR', operationId: payload.operationId };
    const confirmations = await Model.find({ ...filter, eventType: 'USER_CONFIRMED' }).limit(8).lean();
    for (const confirmation of confirmations) {
        const reference = confirmation.payload?.meter || {};
        if (!reference.selectedAttemptId) continue;
        const attempt = await Model.findOne({ ...filter, eventType: 'ATTEMPT_COMPLETED', attemptId: reference.selectedAttemptId }).lean();
        if (!attempt) continue;
        const predicted = attempt.payload?.meter || {};
        const evaluation = evaluateMeter(predicted, reference);
        const missingFields = [];
        if (!evaluation.proposalCharacterEvaluable) missingFields.push('MISSING_OR_INCONSISTENT_PROPOSAL_OR_FINAL_TEXT');
        if (evaluation.rawCharacterEvaluable === false) missingFields.push('MISSING_PHYSICAL_IMAGE_REFERENCE');
        const changes = { evaluation, evaluatorVersion: 'meter-2.2', 'dataQuality.pairingStatus': 'PAIRED', 'dataQuality.missingFields': missingFields, readingDelta: evaluation.absoluteError ?? null, wasEdited: evaluation.corrected ?? null };
        // Confirmed record exposes all three values. Client-supplied OCR/proposal
        // is replaced by the actual selected attempt, never by a later chip click.
        for (const key of ['rawReadingText', 'rawReadingValue', 'readingText', 'readingValue', 'normalizationReasons', 'suggestions']) {
            if (predicted[key] !== undefined) changes[`payload.meter.${key}`] = predicted[key];
        }
        await Model.updateOne({ _id: confirmation._id }, { $set: changes });
        // Every engine can be assessed against the same confirmed reading, without counting it as another operation.
        const attempts = await Model.find({ ...filter, eventType: 'ATTEMPT_COMPLETED' }).limit(10).lean();
        for (const item of attempts) await Model.updateOne({ _id: item._id }, { $set: { evaluation: evaluateMeter(item.payload?.meter, reference), evaluatorVersion: 'meter-2.2', 'dataQuality.pairingStatus': 'PAIRED', 'dataQuality.referenceSource': 'USER_CONFIRMED' } });
    }
}

async function reconcileReceipt(payload) {
    if (!payload.operationId || !['ATTEMPT_COMPLETED', 'USER_CONFIRMED'].includes(payload.eventType)) return;
    const filter = { userId: payload.userId, schemaVersion: 2, feature: 'RECEIPT', operationId: payload.operationId };
    const confirmations = await Model.find({ ...filter, eventType: 'USER_CONFIRMED' }).limit(20).lean();
    for (const confirmation of confirmations) {
        const receipt = confirmation.payload?.receipt;
        if (!confirmation.draftId || !receipt?.selectedAttemptId || !receipt.reference) continue;
        const attempt = await Model.findOne({ ...filter, eventType: 'ATTEMPT_COMPLETED', attemptId: receipt.selectedAttemptId, draftId: confirmation.draftId }).lean();
        if (!attempt?.payload?.receipt?.predicted) continue;
        const predicted = attempt.payload.receipt.predicted;
        const raw = attempt.payload.receipt.raw;
        const evaluation = evaluateReceipt(predicted, receipt.reference);
        if (raw) evaluation.rawFieldAccuracyPct = evaluateReceipt(raw, receipt.reference).fieldAccuracyPct;
        await Model.updateOne({ _id: confirmation._id }, { $set: {
            evaluation, evaluatorVersion: 'receipt-2.0', 'dataQuality.pairingStatus': 'PAIRED',
            'dataQuality.missingFields': evaluation.receiptEvaluable === false ? ['SNAPSHOT_TRUNCATED'] : [],
            'payload.receipt.predicted': predicted, ...(raw ? { 'payload.receipt.raw': raw } : {}),
            aiItemCount: predicted.items?.length || 0, userItemCount: receipt.reference.items?.length || 0,
            fieldAccuracyPct: evaluation.fieldAccuracyPct ?? null, editedFieldCount: evaluation.editedFieldCount,
            totalFieldCount: evaluation.fieldCount, wasEdited: evaluation.corrected, amountDelta: evaluation.amountAbsoluteError ?? null
        } });
    }
}

async function persist(payload) {
    for (let retry = 0; retry < 2; retry++) {
        try {
            await Model.updateOne({ userId: payload.userId, eventId: payload.eventId, schemaVersion: 2 }, { $setOnInsert: payload }, { upsert: true, runValidators: true });
            await reconcile(payload);
            return true;
        } catch (error) {
            if (error.code === 11000) { STATS.duplicate++; return true; }
            if (error.name === 'ValidationError' || error.name === 'CastError') break;
            if (!retry) await pause(100);
        }
    }
    STATS.failed++;
    console.warn('[AiMetrics] Không ghi/đối soát được sự kiện (non-critical)');
    return false;
}

function validServerPayload(payload) {
    return payload && /^[A-Za-z0-9_.:-]{1,160}$/.test(payload.operationId || '')
        && /^[A-Za-z0-9_.:-]{1,160}$/.test(payload.eventId || '')
        && (!payload.attemptId || /^[A-Za-z0-9_.:-]{1,160}$/.test(payload.attemptId))
        && !new Model(payload).validateSync();
}
function scheduleReserved(payload) {
    const key = `${payload.userId}:${payload.operationId}`;
    // Serialize writes AND reconciliation within an operation. Confirmation-first
    // and attempt-first both observe the prior write; unrelated operations parallelize.
    const previous = operationWrites.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => persist(payload)).catch(() => { STATS.failed++; }).finally(() => {
        pending--;
        if (operationWrites.get(key) === current) operationWrites.delete(key);
    });
    operationWrites.set(key, current);
}
function enqueueBatch(payloads) {
    if (!Array.isArray(payloads) || !payloads.length || payloads.length > 20 || !payloads.every(validServerPayload)) { STATS.dropped++; return false; }
    if (process.env.AI_METRICS_ENABLED === 'false') return true;
    if (pending + payloads.length > MAX_PENDING) { STATS.dropped += payloads.length; return false; }
    // Reserve all capacity synchronously before any scheduling: never partial accept.
    pending += payloads.length;
    for (const payload of payloads) scheduleReserved(payload);
    return true;
}
function enqueue(payload) { return enqueueBatch([payload]); }
module.exports = { validateClientEvent, enqueue, enqueueBatch, persist, reconcile, stats: STATS };
