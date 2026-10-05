// Numeric agreement and character agreement are deliberately separate.
const finiteReading = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const normalizeText = value => {
    if (typeof value !== 'string') return null;
    const text = value.trim().replace(/\s*(kwh|m³|m3)\s*$/i, '').replace(/\s/g, '').replace(/,/g, '.');
    if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
    // Ignore display padding, retain decimal placement. Never fabricate text from a number.
    return text.replace(/^0+(?=\d)/, '');
};
const distance = (left, right) => {
    let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
    for (let i = 1; i <= left.length; i++) {
        const current = [i];
        for (let j = 1; j <= right.length; j++) current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
        previous = current;
    }
    return previous[right.length];
};
const evaluateMeter = (predicted = {}, reference = {}) => {
    const numericEvaluable = finiteReading(predicted.readingValue) && finiteReading(reference.referenceValue);
    const predictedText = normalizeText(predicted.readingText);
    const referenceText = normalizeText(reference.referenceText);
    const predictedConsistent = predictedText !== null && (!finiteReading(predicted.readingValue) || Number(predictedText) === predicted.readingValue);
    const referenceConsistent = referenceText !== null && (!finiteReading(reference.referenceValue) || Number(referenceText) === reference.referenceValue);
    const hasRawProvenance = Object.prototype.hasOwnProperty.call(predicted, 'rawReadingText') || Object.prototype.hasOwnProperty.call(predicted, 'rawReadingValue');
    // v2.1 proposal text may contain a separator inserted by a rule. It is not
    // optical output, and user-entered numeric text is not a physical-image label.
    const characterEvaluable = !hasRawProvenance && predictedConsistent && referenceConsistent;
    const result = { numericEvaluable, characterEvaluable };
    result.proposalCharacterEvaluable = predictedConsistent && referenceConsistent;
    if (result.proposalCharacterEvaluable) {
        result.proposalEditDistance = distance(predictedText, referenceText);
        result.proposalLength = predictedText.length;
        result.finalLength = referenceText.length;
        result.proposalSimilarityPct = 100 * (1 - result.proposalEditDistance / Math.max(result.proposalLength, result.finalLength));
        result.ksrPct = 100 * (1 - result.proposalEditDistance / result.finalLength);
        result.ksrReasonCode = 'EDIT_DISTANCE_PROXY';
        result.ksrReferenceSource = 'USER_CONFIRMED';
    } else if (predicted.readingValue === null && (predicted.readingText === null || predicted.readingText === '') && referenceConsistent) {
        // Only an explicitly completed unreadable attempt may represent no proposal.
        // A missing event/pair never reaches this evaluator as a fabricated empty draft.
        result.proposalCharacterEvaluable = true;
        result.proposalEditDistance = referenceText.length;
        result.proposalLength = 0;
        result.finalLength = referenceText.length;
        result.proposalSimilarityPct = 0;
        result.ksrPct = 0;
        result.ksrReasonCode = 'NO_PROPOSAL_MANUAL_ENTRY';
        result.ksrReferenceSource = 'USER_CONFIRMED';
    }
    if (numericEvaluable) {
        result.absoluteError = Math.abs(predicted.readingValue - reference.referenceValue);
        result.exactNumericMatch = result.absoluteError === 0;
        result.corrected = !result.exactNumericMatch;
    }
    if (characterEvaluable) {
        result.editDistance = distance(predictedText, referenceText);
        result.referenceLength = referenceText.length;
        result.cerPct = result.editDistance / result.referenceLength * 100;
    }
    if (hasRawProvenance) {
        const raw = normalizeText(predicted.rawReadingText);
        const physicalReference = normalizeText(reference.physicalReferenceText);
        const rawCharacterEvaluable = reference.physicalReferenceSource === 'IMAGE_REVIEW' && raw !== null && physicalReference !== null;
        result.rawCharacterEvaluable = rawCharacterEvaluable;
        if (rawCharacterEvaluable) {
            result.rawEditDistance = distance(raw, physicalReference);
            result.rawReferenceLength = physicalReference.length;
            result.rawCerPct = result.rawEditDistance / result.rawReferenceLength * 100;
        }
    }
    return result;
};
module.exports = { finiteReading, normalizeText, distance, evaluateMeter };
