const { GoogleGenerativeAI } = require('@google/generative-ai');

const MODELS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
const PIPELINE_VERSION = 'meter-v3';
const MAX_PROVIDER_BUDGET_MS = 25000;
function normalizeMeterBudget(value) {
    const number = Number(value);
    return Math.max(1, Math.min(Number.isFinite(number) && number > 0 ? number : 8000, MAX_PROVIDER_BUDGET_MS));
}
const meterError = (code, message, statusCode = 502) => Object.assign(new Error(message), { code, statusCode });

// Keep optical text separate from its numeric value. Never reconstruct leading
// zeros from a number, strip letters, or infer a missing decimal/prefix.
function parseMeterResult(text, { meterType } = {}) {
    let data;
    try { data = JSON.parse(String(text || '').replace(/```(?:json)?/gi, '').trim()); }
    catch (_) { throw meterError('METER_AI_INVALID_JSON', 'AI trả dữ liệu không hợp lệ.'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw meterError('METER_AI_INVALID_OUTPUT', 'AI trả cấu trúc không hợp lệ.');
    }
    if (data.readable === false || data.readingText === null) {
        return { value: null, aiReadingText: null, rawReadingText: null, rawReadingValue: null,
            normalizationReasons: [], readable: false, status: 'UNREADABLE',
            reasonCode: 'IMAGE_UNREADABLE', warningCodes: ['IMAGE_UNREADABLE'] };
    }
    if (data.readable !== true || typeof data.readingText !== 'string') {
        throw meterError('METER_AI_INVALID_OUTPUT', 'AI chưa cung cấp chuỗi chỉ số hợp lệ.');
    }
    let readingText = data.readingText.trim();
    if (!/^\d{1,10}(?:[.,]\d{1,3})?$/.test(readingText)) {
        throw meterError('METER_AI_INVALID_READING', 'Chuỗi chỉ số không hợp lệ.');
    }
    const rawReadingText = typeof data.rawReadingText === 'string' ? data.rawReadingText.trim() : readingText;
    if (!/^\d{1,10}(?:[.,]\d{1,3})?$/.test(rawReadingText)) {
        throw meterError('METER_AI_INVALID_READING', 'Chuỗi OCR gốc không hợp lệ.');
    }
    const rawReadingValue = Number(rawReadingText.replace(',', '.'));
    const normalizationReasons = [];
    if (meterType === 'POWER' && data.meterProfile === 'POWER_5_PLUS_1' && /^\d{6}$/.test(rawReadingText)) {
        readingText = `${rawReadingText.slice(0, -1)}.${rawReadingText.slice(-1)}`;
        normalizationReasons.push('POWER_TENTHS_PROFILE');
    } else if (readingText !== rawReadingText) {
        const digits = str => str.replace(/[.,]/g, '').replace(/^0+(?=\d)/, '');
        if (digits(readingText) !== digits(rawReadingText)) {
            throw meterError('METER_AI_INVALID_NORMALIZATION', 'Chuẩn hóa đã thay đổi chữ số nhìn thấy.');
        }
        normalizationReasons.push('VISUAL_DECIMAL_POSITION');
    }
    if (rawReadingText.replace(/[.,]/g, '').length < 3) {
        return { value: null, aiReadingText: null, rawReadingText, rawReadingValue,
            normalizationReasons: [], readable: false, status: 'UNREADABLE',
            reasonCode: 'TOO_FEW_DIGITS', warningCodes: ['TOO_FEW_DIGITS'] };
    }
    const value = Number(readingText.replace(',', '.'));
    if (!Number.isFinite(value) || value > 9999999999) {
        throw meterError('METER_AI_INVALID_READING', 'Chỉ số nằm ngoài giới hạn.');
    }
    const warningCodes = Array.isArray(data.warningCodes)
        ? data.warningCodes.filter(code => ['DECIMAL_UNCLEAR', 'DIGIT_UNCLEAR', 'GLARE', 'BLUR'].includes(code)).slice(0, 4) : [];
    return { value, aiReadingText: readingText, rawReadingText, rawReadingValue,
        normalizationReasons, readable: true,
        status: warningCodes.some(code => ['DECIMAL_UNCLEAR', 'DIGIT_UNCLEAR'].includes(code)) ? 'AMBIGUOUS' : 'CLEAR', warningCodes };
}

function boundedCandidates(input) {
    if (!Array.isArray(input)) return [];
    return input.slice(0, 5).flatMap(candidate => {
        const raw = typeof candidate === 'string' ? candidate : candidate?.readingText ?? candidate?.rawText;
        return typeof raw === 'string' && /^\d{1,10}(?:[.,]\d{1,3})?$/.test(raw.trim()) && raw.replace(/[.,]/g, '').length >= 3 ? [raw.trim()] : [];
    });
}

function buildMeterPrompt(meterType, candidates) {
    return `Đọc độc lập chuỗi số trên mặt công tơ ${meterType === 'POWER' ? 'điện (kWh)' : 'nước (m³)'}. `
        + 'Bỏ qua serial, model, điện áp, dòng điện, vòng/kWh và năm. Giữ số 0 đầu, chỉ đặt dấu thập phân khi nhìn rõ trên ảnh. '
        + 'Trên công tơ cơ, đọc ô số lăn cạnh kWh; tem, mã vạch và Số SX không phải chỉ số. Các nhãn 10000,1000,100,10,1,1/10 là trọng số, không nối vào chuỗi số. Chữ số đỏ chỉ là thập phân khi nhãn/trọng số hoặc dấu phân cách trên ảnh xác nhận; không tự áp dụng cho mọi công tơ. '
        + 'Không suy đoán chữ số bị che, không thêm tiền tố, không chọn số theo mức tiêu thụ dự kiến. '
        + `Candidate OCR CHƯA XÁC MINH (có thể sai): ${JSON.stringify(boundedCandidates(candidates))}. `
        + 'Đọc từ ảnh trước; kiểm tra vị trí bất đồng nếu có. Không bắt buộc chọn candidate. '
        + 'Chỉ đọc vùng chỉ số trên ảnh, không phân loại ảnh hay kiểm tra ảnh có đúng loại điện/nước người dùng chọn. Người dùng tự đối chiếu trước khi lưu. '
        + 'Trả JSON {"meterProfile":"POWER_5_PLUS_1|OTHER|UNKNOWN","rawReadingText":string|null,"readingText":string|null,"readable":boolean,"warningCodes":[]}. '
        + 'rawReadingText giữ chuỗi chữ số vật lý nhìn thấy, số 0 đầu và dấu phân cách thực, không chứa đơn vị hay trọng số. readingText là cùng các chữ số với dấu thập phân theo bằng chứng. POWER_5_PLUS_1 chỉ khi xác nhận năm số nguyên và một số đỏ hàng 1/10; không suy ra mẫu này chỉ từ số lượng chữ số. Không tự làm tròn hoặc bỏ số đỏ. Với nước không cố định số chữ số/phần thập phân. '
        + 'Nếu chữ số hoặc dấu thập phân không nhìn rõ: readingText=null, readable=false. '
        + 'warningCodes chỉ dùng DIGIT_UNCLEAR, DECIMAL_UNCLEAR, GLARE, BLUR.';
}

function retryable(error) {
    const status = Number(error?.status ?? error?.apiStatus ?? error?.statusCode);
    return status === 429 || status === 503 || status === 502 || status === 504;
}

async function recognizeMeter({ meterType, imageBase64, mimeType, candidates, budgetMs = 8000, signal, contextImageBase64, contextMimeType = 'image/jpeg' }, dependencies = {}) {
    const apiKey = dependencies.apiKey ?? process.env.GEMINI_API_KEY;
    if (!apiKey && !dependencies.generate) throw meterError('GEMINI_NOT_CONFIGURED', 'AI chưa được cấu hình.', 503);
    const sdk = dependencies.generate ? null : new GoogleGenerativeAI(apiKey);
    const generate = dependencies.generate || ((modelName, promptParts, requestSignal) => sdk.getGenerativeModel({
        model: modelName,
        systemInstruction: 'Bạn là bộ đọc ảnh công tơ, không phải bộ dự đoán. Chỉ đọc bằng chứng nhìn thấy.',
        generationConfig: { responseMimeType: 'application/json', temperature: 0 }
    }).generateContent({ contents: [{ role: 'user', parts: promptParts }] }, { signal: requestSignal }));
    const duration = normalizeMeterBudget(budgetMs);
    const started = performance.now();
    const controller = new AbortController();
    let rejectCancelled;
    const cancelled = new Promise((_, reject) => { rejectCancelled = reject; });
    const abort = () => {
        controller.abort();
        rejectCancelled(meterError('AI_CANCELLED', 'Đã dừng xác minh.', 499));
    };
    if (signal?.aborted) throw meterError('AI_CANCELLED', 'Đã dừng xác minh.', 499);
    signal?.addEventListener('abort', abort, { once: true });
    let timer;
    const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(meterError('AI_TIMEOUT', 'Đã hết thời gian xác minh. Bạn có thể chụp lại hoặc nhập tay.', 504)); }, duration);
    });
    const promptParts = [{ text: buildMeterPrompt(meterType, candidates) }, { inlineData: { mimeType, data: imageBase64 } }];
    if (contextImageBase64) {
        promptParts.push({ text: 'Ảnh đầu là vùng nghi vấn, có thể khoanh sai. Ảnh tiếp theo là toàn cảnh để xác định ô số thực. Nếu vùng crop là tem/serial, đọc ô hiển thị trong toàn cảnh; không dùng tem làm chỉ số.' },
            { inlineData: { mimeType: contextMimeType, data: contextImageBase64 } });
    }
    const attempts = [];
    try {
        for (const model of MODELS) {
            if (controller.signal.aborted) throw meterError('AI_CANCELLED', 'Đã dừng xác minh.', 499);
            const attemptStarted = performance.now();
            try {
                const result = await Promise.race([generate(model, promptParts, controller.signal), deadline, cancelled]);
                const response = result.response;
                const parsed = parseMeterResult(response.text(), { meterType });
                attempts.push({ model, durationMs: Math.round(performance.now() - attemptStarted), status: parsed.status });
                return { ...parsed, metadata: { model, durationMs: Math.round(performance.now() - started),
                    modelLatencyMs: Math.round(performance.now() - attemptStarted), providerAttempts: attempts,
                    pipelineVersion: PIPELINE_VERSION, ...response.usageMetadata } };
            } catch (error) {
                attempts.push({ model, durationMs: Math.round(performance.now() - attemptStarted), status: 'ERROR', code: error.code || `HTTP_${error.status || 'UNKNOWN'}` });
                if (controller.signal.aborted || !retryable(error) || model === MODELS.at(-1)) {
                    const finalError = error.code ? error : meterError(`GEMINI_HTTP_${error.status || 'UNKNOWN'}`, 'Chưa thể xác minh bằng AI.', Number(error.status) || 502);
                    finalError.providerAttempts = attempts;
                    throw finalError;
                }
            }
        }
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
    }
}

module.exports = { recognizeMeter, parseMeterResult, boundedCandidates, buildMeterPrompt, PIPELINE_VERSION, normalizeMeterBudget };
