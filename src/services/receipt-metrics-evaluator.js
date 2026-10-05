const { distance } = require('./meter-metrics-evaluator');
const normalizeName = value => typeof value === 'string' ? value.normalize('NFC').trim().toLocaleLowerCase('vi').replace(/\s+/g, ' ') : '';
const present = value => value !== null && value !== undefined && value !== '';
const numeric = value => typeof value === 'number' && Number.isFinite(value);
const same = (a, b) => numeric(a) && numeric(b) ? a === b : normalizeName(String(a ?? '')) === normalizeName(String(b ?? ''));
function snapshot(draft) {
    if (!draft || typeof draft !== 'object') return null;
    const number = value => value === null || value === undefined || value === '' ? undefined : Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : undefined;
    const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : undefined;
    const warningCodes = item => [...new Set([
        ...(Array.isArray(item.warningCodes) ? item.warningCodes : []),
        ...(Array.isArray(item.warnings) ? item.warnings.map(warning => typeof warning === 'string' ? warning : warning?.code) : [])
    ].filter(code => typeof code === 'string' && code.trim()).map(code => code.trim().slice(0, 80)))].slice(0, 30);
    const measurementBasis = value => value && typeof value === 'object' && !Array.isArray(value)
        && ['PER_PURCHASE_UNIT', 'TOTAL'].includes(value.scope) && ['G', 'ML', 'PIECE'].includes(value.unit)
        && typeof value.quantity === 'number' && Number.isFinite(value.quantity) && value.quantity > 0
        && typeof value.evidence === 'string' && value.evidence.trim()
        ? { scope: value.scope, quantity: value.quantity, unit: value.unit, evidence: value.evidence.slice(0, 200) } : undefined;
    return {
        truncated: Array.isArray(draft.items) && draft.items.length > 200, originalItemCount: Array.isArray(draft.items) ? draft.items.length : 0,
        merchantName: text(draft.merchantName, 300), date: text(draft.date, 40), category: text(draft.category, 80),
        totalAmount: number(draft.totalAmount ?? draft.amount), discount: number(draft.discount),
        items: (Array.isArray(draft.items) ? draft.items : []).slice(0, 200).map(item => ({
            sourceLineId: text(item.sourceLineId, 160), rawName: text(item.rawName, 300), itemName: text(item.itemName, 300),
            quantity: number(item.quantity), unit: text(item.unit, 30), unitPrice: number(item.unitPrice ?? item.purchasePrice), lineTotal: number(item.totalPrice ?? item.lineTotal),
            category: text(item.category, 80), subCategory: text(item.subCategory, 80), brand: text(item.brand, 100),
            standardQuantity: number(item.standardQuantity), standardUnit: text(item.standardUnit, 30),
            measurementStatus: text(item.measurementStatus, 40), measurementBasis: measurementBasis(item.measurementBasis),
            measurementEvidence: Array.isArray(item.measurementEvidence) ? item.measurementEvidence.filter(value => typeof value === 'string').slice(0, 8).map(value => value.slice(0, 200)) : undefined,
            warningCodes: warningCodes(item)
        }))
    };
}
function pairRows(predicted, reference) {
    const used = new Set(); const pairs = []; const missing = [];
    for (const finalRow of reference) {
        let index = -1;
        if (finalRow.sourceLineId) index = predicted.findIndex((row, i) => !used.has(i) && row.sourceLineId === finalRow.sourceLineId);
        if (index < 0) index = predicted.findIndex((row, i) => !used.has(i) && !(row.sourceLineId && finalRow.sourceLineId)
            && normalizeName(row.itemName || row.rawName) !== '' && normalizeName(row.itemName || row.rawName) === normalizeName(finalRow.itemName || finalRow.rawName));
        if (index >= 0) { used.add(index); pairs.push([predicted[index], finalRow]); }
        else missing.push(finalRow);
    }
    return { pairs, missing, extra: predicted.filter((_, i) => !used.has(i)) };
}
function evaluateReceipt(predicted, reference) {
    if (!predicted || !reference) return {};
    if (predicted.truncated || reference.truncated) return { receiptEvaluable: false };
    const { pairs, missing, extra } = pairRows(predicted.items || [], reference.items || []);
    const truePositives = pairs.length, falsePositives = extra.length, falseNegatives = missing.length;
    const result = { receiptEvaluable: true, truePositives, falsePositives, falseNegatives, fieldCount: 0, correctFieldCount: 0, nameEditDistance: 0, nameReferenceLength: 0,
        fieldResults: {}, measureErrors: [] };
    if (truePositives + falsePositives > 0) result.precision = truePositives / (truePositives + falsePositives);
    if (truePositives + falseNegatives > 0) result.recall = truePositives / (truePositives + falseNegatives);
    if (2 * truePositives + falsePositives + falseNegatives > 0) result.f1 = 2 * truePositives / (2 * truePositives + falsePositives + falseNegatives);
    const compare = (a, b, fields) => {
        for (const field of fields) {
            if (!present(a?.[field]) && !present(b?.[field])) continue;
            result.fieldCount++;
            const counts = result.fieldResults[field] ||= { total: 0, correct: 0 };
            counts.total++;
            if (present(a?.[field]) && present(b?.[field]) && same(a[field], b[field])) { result.correctFieldCount++; counts.correct++; }
        }
    };
    compare(predicted, reference, ['merchantName', 'date', 'totalAmount', 'discount']);
    const itemFields = ['itemName', 'quantity', 'unit', 'unitPrice', 'lineTotal', 'standardQuantity', 'standardUnit'];
    for (const [ai, final] of pairs) {
        compare(ai, final, itemFields);
        if (numeric(ai.standardQuantity) && numeric(final.standardQuantity) && ai.standardUnit === final.standardUnit && ['G', 'ML', 'PIECE'].includes(ai.standardUnit)) {
            const unit = ai.standardUnit;
            let aggregate = result.measureErrors.find(item => item.unit === unit);
            if (!aggregate) { aggregate = { unit, count: 0, absoluteErrorSum: 0, mae: 0 }; result.measureErrors.push(aggregate); }
            aggregate.count++; aggregate.absoluteErrorSum += Math.abs(ai.standardQuantity - final.standardQuantity);
            aggregate.mae = aggregate.absoluteErrorSum / aggregate.count;
        }
        const a = normalizeName(ai.itemName || ai.rawName), b = normalizeName(final.itemName || final.rawName);
        if (b) { result.nameEditDistance += distance(a, b); result.nameReferenceLength += b.length; }
    }
    for (const final of missing) {
        compare(null, final, itemFields);
        const name = normalizeName(final.itemName || final.rawName);
        result.nameEditDistance += name.length; result.nameReferenceLength += name.length;
    }
    for (const ai of extra) {
        compare(ai, null, itemFields);
        result.nameEditDistance += normalizeName(ai.itemName || ai.rawName).length;
    }
    result.editedFieldCount = result.fieldCount - result.correctFieldCount;
    if (result.fieldCount) result.fieldAccuracyPct = result.correctFieldCount / result.fieldCount * 100;
    if (result.nameReferenceLength) result.nameKsrPct = 100 * (1 - result.nameEditDistance / result.nameReferenceLength);
    if (numeric(predicted.totalAmount) && numeric(reference.totalAmount)) {
        result.amountAbsoluteError = Math.abs(predicted.totalAmount - reference.totalAmount);
        result.amountExactMatch = result.amountAbsoluteError === 0;
    }
    result.corrected = result.editedFieldCount > 0;
    return result;
}
module.exports = { snapshot, pairRows, evaluateReceipt, normalizeName };
