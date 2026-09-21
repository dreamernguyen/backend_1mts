const VALID_METER_TYPES = new Set(['POWER', 'WATER']);
const MAX_READING_VALUE = 9999999999;
const LARGE_DIFFERENCE_PERCENT = 10;
const LARGE_DIFFERENCE_AMOUNT = 10000;

const meterUnit = meterType => meterType === 'POWER' ? 'KWH' : 'M3';

const parseMeterType = value => {
    const meterType = String(value || '').trim().toUpperCase();
    if (!VALID_METER_TYPES.has(meterType)) {
        const error = new Error('Loại công tơ chỉ nhận POWER hoặc WATER.');
        error.statusCode = 400;
        throw error;
    }
    return meterType;
};

const parseNonNegativeNumber = (value, label, { max = Number.MAX_SAFE_INTEGER } = {}) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > max) {
        const error = new Error(`${label} phải là số không âm hợp lệ.`);
        error.statusCode = 400;
        throw error;
    }
    return parsed;
};

const parseDateNotFuture = (value, label = 'Ngày ghi chỉ số') => {
    const parsed = value ? new Date(value) : new Date();
    if (Number.isNaN(parsed.getTime())) {
        const error = new Error(`${label} không hợp lệ.`);
        error.statusCode = 400;
        throw error;
    }
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);
    if (parsed > endOfToday) {
        const error = new Error(`${label} không được nằm trong tương lai.`);
        error.statusCode = 400;
        throw error;
    }
    return parsed;
};

const calculateReading = ({ previousValue, currentValue, unitPrice }) => {
    const current = parseNonNegativeNumber(currentValue, 'Chỉ số hiện tại', { max: MAX_READING_VALUE });
    const price = parseNonNegativeNumber(unitPrice, 'Đơn giá');
    const firstReading = previousValue === null || previousValue === undefined;
    if (firstReading) {
        return { previousValue: null, currentValue: current, usage: 0, estimatedCost: 0, isFirstReading: true };
    }

    const previous = parseNonNegativeNumber(previousValue, 'Chỉ số trước', { max: MAX_READING_VALUE });
    if (current < previous) {
        const error = new Error('Chỉ số hiện tại không được nhỏ hơn chỉ số trước.');
        error.statusCode = 422;
        error.appCode = 'READING_LOWER_THAN_PREVIOUS';
        throw error;
    }

    const usage = Number((current - previous).toFixed(3));
    return {
        previousValue: previous,
        currentValue: current,
        usage,
        estimatedCost: Math.round(usage * price),
        isFirstReading: false
    };
};

const comparePayment = (estimatedCost, paidAmount) => {
    const paid = parseNonNegativeNumber(paidAmount, 'Số tiền thanh toán');
    const differenceAmount = Math.round(paid - estimatedCost);
    const absoluteDifference = Math.abs(differenceAmount);
    const differencePercent = estimatedCost > 0
        ? Number(((absoluteDifference / estimatedCost) * 100).toFixed(2))
        : (paid > 0 ? 100 : 0);
    return {
        paidAmount: Math.round(paid),
        differenceAmount,
        differencePercent,
        hasLargeDifference: differencePercent >= LARGE_DIFFERENCE_PERCENT
            && absoluteDifference >= LARGE_DIFFERENCE_AMOUNT
    };
};

const allocatePayment = (estimatedCosts, paidAmount) => {
    if (!Array.isArray(estimatedCosts) || estimatedCosts.length === 0) return [];
    const costs = estimatedCosts.map(value => parseNonNegativeNumber(value, 'Tiền dự kiến'));
    const paid = Math.round(parseNonNegativeNumber(paidAmount, 'Số tiền thanh toán'));
    const total = costs.reduce((sum, value) => sum + value, 0);
    let allocated = 0;
    return costs.map((cost, index) => {
        const share = index === costs.length - 1
            ? paid - allocated
            : (total > 0 ? Math.round(paid * cost / total) : 0);
        allocated += share;
        return share;
    });
};

const validateMeterImage = imageData => {
    if (!imageData) return { meterImage: null, imageMimeType: null, hasImage: false };
    if (typeof imageData !== 'string') {
        const error = new Error('Ảnh công tơ không hợp lệ.');
        error.statusCode = 400;
        throw error;
    }
    const match = imageData.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!match) {
        const error = new Error('Ảnh công tơ chỉ nhận JPEG, PNG hoặc WEBP dạng Base64.');
        error.statusCode = 400;
        throw error;
    }
    const bytes = Buffer.from(match[2], 'base64').length;
    if (bytes > 750 * 1024) {
        const error = new Error('Ảnh công tơ vượt quá 750 KB. Vui lòng chụp hoặc nén lại ảnh.');
        error.statusCode = 413;
        error.appCode = 'METER_IMAGE_TOO_LARGE';
        throw error;
    }
    return { meterImage: imageData, imageMimeType: match[1], hasImage: true };
};

module.exports = {
    LARGE_DIFFERENCE_PERCENT,
    LARGE_DIFFERENCE_AMOUNT,
    meterUnit,
    parseMeterType,
    parseNonNegativeNumber,
    parseDateNotFuture,
    calculateReading,
    comparePayment,
    allocatePayment,
    validateMeterImage
};
