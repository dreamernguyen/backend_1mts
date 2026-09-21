const mongoose = require('mongoose');
const Transaction = require('../models/transaction.model');
const Item = require('../models/item.model');
const RpgLog = require('../models/rpgLog.model');
const User = require('../models/user.model');
const MeterReading = require('../models/meterReading.model');
const moment = require('moment-timezone');
const { asyncHandler } = require('../middleware/errorHandler.middleware');
const rpgService = require('../services/rpg.service');
const questService = require('../services/quest.service');
const geminiService = require('../services/gemini.service');
const financeInsightService = require('../services/finance-insight.service');
const survivalInsightService = require('../services/survival-insight.service');
const {
    createReceiptCacheKey,
    getOrCreateReceiptRequest,
    deleteReceiptRequestCache
} = require('../services/receipt-request-cache.service');
const {
    calculateBaseUnitPrice,
    normalizeTransactionDraft,
    normalizeTransactionList,
    validateExtractedReceiptTransactions,
    hasBlockingWarnings
} = require('../services/receipt-normalizer.service');

const parseHistoryPeriod = period => {
    if (period == null || String(period).trim() === '') return null;
    const raw = String(period).trim();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(raw)) return undefined;
    const start = moment.tz(raw, 'YYYY-MM', true, 'Asia/Ho_Chi_Minh');
    if (!start.isValid()) return undefined;
    return { $gte: start.toDate(), $lt: start.clone().add(1, 'month').toDate() };
};

exports.parseHistoryPeriod = parseHistoryPeriod;

// Chuẩn hóa bản nháp từ ML Kit/Firebase AI. Không lưu DB và không gọi AI.
exports.normalizeDraft = asyncHandler(async (req, res) => {
    const input = req.body?.transactions ?? req.body?.draft ?? req.body;
    const normalizedTransactions = normalizeTransactionList(input);
    if (normalizedTransactions.length === 0) {
        return res.status(400).json({ success: false, message: 'Bản nháp hóa đơn không có dữ liệu hợp lệ.' });
    }
    if (normalizedTransactions[0].isReadable === false) {
        return res.status(400).json({
            success: false,
            message: normalizedTransactions[0].reason || 'Không thể đọc hóa đơn.',
            warnings: normalizedTransactions[0].warnings
        });
    }
    return res.status(200).json({
        success: true,
        message: 'Đã chuẩn hóa bản nháp hóa đơn.',
        data: normalizedTransactions
    });
});

// Bóc tách hóa đơn bằng AI
exports.parseDocument = asyncHandler(async (req, res) => {
    const { base64Image, rawText, scanRequestId, inputSource, forceRefresh, type } = req.body;

    if (!base64Image && (!rawText || rawText.trim() === '')) {
        return res.status(400).json({
            success: false,
            message: 'Vui lòng truyền lên base64Image (ảnh hóa đơn) hoặc rawText (câu ghi chú nhanh).'
        });
    }

    const requestId = typeof scanRequestId === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(scanRequestId)
        ? scanRequestId
        : `receipt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const cleanRawText = rawText?.trim() || '';
    const inputMode = base64Image ? 'image' : inputSource === 'OCR_TEXT' ? 'ocr_text' : 'manual_text';
    const lineCount = cleanRawText ? cleanRawText.split(/\r?\n/).filter(Boolean).length : 0;
    const imageBytes = base64Image
        ? Math.max(0, Math.floor((base64Image.split(',').pop().length * 3) / 4))
        : 0;
    const startedAt = Date.now();
    console.info('[Receipt request started]', {
        requestId,
        inputMode,
        type: type || 'grocery',
        ocrCharacterCount: cleanRawText.length,
        ocrLineCount: lineCount,
        imageBytes
    });

    // system prompt cho AI
    let systemInstruction = '';
    
    if (type === 'utility') {
        systemInstruction = `Bạn là hệ thống AI cấu trúc hóa dữ liệu chi tiêu.
Nhiệm vụ: Bóc tách hóa đơn tiện ích (điện, nước, internet). Trả về JSON: { provider, amount, billingPeriod }.

QUY TẮC SỐ 1: NẾU ẢNH MỜ
Nếu ảnh hoàn toàn mờ hoặc không liên quan hóa đơn điện nước, trả về JSON:
{
    "isReadable": false,
    "reason": "Ảnh quá mờ hoặc không phải hóa đơn điện/nước/internet hợp lệ."
}

QUY TẮC SỐ 2: NẾU ĐỌC ĐƯỢC, BẮT BUỘC TRẢ VỀ JSON SAU:
{
    "isReadable": true,
    "provider": "Tên nhà cung cấp (VD: EVN, SAWACO, VNPT, Viettel)",
    "amount": Tổng tiền thực tế phải thanh toán (Number - không lấy thập phân),
    "billingPeriod": "Kỳ hóa đơn (VD: '10/2023' hoặc 'Tháng 10 năm 2023')"
}
- Trả về thuần JSON, không bọc thẻ markdown.`;
    } else {
        systemInstruction = `
    Bạn là hệ thống AI cấu trúc hóa dữ liệu chi tiêu của ứng dụng "Một Mình Tôi Sống" (1MTS).
    Nhiệm vụ: Phân tích văn bản từ ảnh chụp (OCR) hoặc câu ghi chép nhanh và trích xuất JSON chi tiêu.

    QUY TẮC SỐ 1: BÁO CÁO ẢNH MỜ / KHÔNG LIÊN QUAN
    Nếu ảnh đính kèm hoàn toàn mờ, không thể đọc được chữ, hoặc không liên quan đến chi tiêu/hóa đơn, BẮT BUỘC trả về duy nhất JSON sau (Tuyệt đối không đoán mò):
    {
        "isReadable": false,
        "reason": "Ảnh quá mờ hoặc bị chói sáng, không thể nhận diện."
    }

    QUY TẮC SỐ 2: NẾU ĐỌC ĐƯỢC, TRẢ VỀ JSON KHỚP 100% ĐẶC TẢ SAU:
    {
        "isReadable": true,
        "merchantName": "Tên siêu thị/cửa hàng (VD: 'WinMart+', 'GongCha', 'Petrolimex')",
        "transactionType": "EXPENSE",
        "category": "Chọn đúng 1 trong: HOUSING | ACADEMICS | RESTAURANT | MARKET | CLOTHING | TRANSPORT | HEALTHCARE | ENTERTAINMENT | SAVINGS | APPLIANCES | OTHERS",
        "amount": Tổng tiền thực tế sau giảm giá (Number - không lấy thập phân),
        "discount": Số tiền giảm giá/voucher/khuyến mãi trên hóa đơn (Number, không có thì là 0),
        "date": "Ngày mua trên hóa đơn định dạng 'YYYY-MM-DD'. NẾU HÓA ĐƠN KHÔNG GHI NĂM, BẮT BUỘC SỬ DỤNG NĂM HIỆN TẠI LÀ ${new Date().getFullYear()}. Tuyệt đối không tự đoán năm cũ. Không tìm thấy ngày thì trả về null",
        "note": "Ghi chú tóm tắt hành vi bằng tiếng Việt có dấu (VD: 'Mua sắm thực phẩm WinMart', 'Ăn sáng phở bò')",
        "items": [
            {
                "itemName": "Tên DANH TÍNH NGUYÊN LIỆU để gom kho: giữ nguyên liệu gốc + phần/bộ phận quan trọng + trạng thái chế biến làm đổi cách dùng; bỏ brand, định lượng, bao bì, kích cỡ, hạng và mô tả thương mại. Ví dụ Trứng gà so/ta/công nghiệp/Omega 3 đều là 'Trứng gà'; nhưng Trứng vịt, Trứng cút, Trứng vịt lộn, Trứng muối không được gộp. Ức gà và Đùi gà phải khác nhau. Không chứa định lượng/đơn vị.",
                "rawName": "Giữ NGUYÊN BẢN 100% chữ cái trên hóa đơn (VD: 'Ức gà phi lê có da tươi CP 500g'). Tuyệt đối không tự bịa hay rút gọn.",
                "brand": "Thương hiệu nếu có, không có thì là 'No name'",
                "subCategory": "BẮT BUỘC trả về ĐÚNG 1 trong các MÃ CODE sau (Tuyệt đối không dùng tiếng Việt): PORK | BEEF | CHICKEN | DUCK | GOOSE | PROCESSED_MEAT | OTHER_MEAT | FISH | SHRIMP | SQUID_OCTOPUS | CRAB_SHELLFISH | OTHER_SEAFOOD | LEAFY_VEG | ROOT_VEG | MUSHROOM | HERB_SPICE_VEG | OTHER_VEG | CITRUS | TROPICAL | TEMPERATE | OTHER_FRUIT | MILK | WATER | SODA_JUICE | COFFEE_TEA | ALCOHOL | NOODLE_PASTA | RICE_GRAIN | BASIC_SPICE | SAUCE | OTHER. Rất quan trọng để phân loại tủ đồ.",
                "quantity": Số lượng mua (Number),
                "originalQuantity": Số lượng ban đầu - luôn bằng với quantity tại thời điểm mua (Number),
                "unit": "Đơn vị hiển thị (BẮT BUỘC CHỈ DÙNG: 'g', 'kg', 'ml', 'L', 'Trái/Quả', 'Cái', 'Phần', 'Khay', 'Vỉ', 'Lon', 'Chai', 'Gói', 'Bó'). Ưu tiên dùng 'Trái/Quả' thay vì 'cái/phần' nếu là trứng/trái cây.",
                "standardQuantity": TỔNG định lượng quy đổi của toàn bộ quantity trên dòng hàng (VD: 2 khay, mỗi khay 500g -> 1000; chai 1L -> 1000; 10 quả trứng -> 10). Nếu input không nói rõ thì trả 0, không được tự đoán,
                "standardUnit": "Đơn vị quy chuẩn: G | ML | PIECE. Luôn đổi KG sang G và L sang ML. Nếu thiếu bằng chứng định lượng thì trả chuỗi rỗng",
                "purchasePrice": Đơn giá của 1 đơn vị unit, không phân bổ voucher tổng. Ví dụ 2 gói có lineTotal 89.000đ và không có đơn giá riêng thì purchasePrice = 44.500đ; lineTotal vẫn là 89.000đ. Không đủ bằng chứng thì trả về 0,
                "lineTotal": Thành tiền THỰC TẾ của riêng dòng hàng trên hóa đơn (Number). Với hàng cân theo kg/g, đây là số tiền sau khi nhân trọng lượng với đơn giá/kg. Không dùng tổng toàn hóa đơn,
                "category": "BẮT BUỘC LÀ 1 TRONG: MEAT | SEAFOOD | VEGETABLE | FRUIT | EGG | DRY_FOOD | DRINK | SPICE | COSMETIC | SUPPLEMENT | OTHER"
            }
        ]
    }

    QUY TẮC CHỐNG ẢO GIÁC BẮT BUỘC:
    - Đọc TRỌN VẸN hóa đơn từ phần đầu đến phần tổng thanh toán. Không được dừng sau khi thấy vài mặt hàng đầu tiên.
    - Mỗi dòng hàng hóa có tên và thành tiền phải được ánh xạ vào đúng 1 item; không bỏ dòng chỉ vì tên viết tắt hoặc khó phân loại.
    - Không đưa dòng VAT, voucher, tổng cộng, tiền khách đưa/tiền thừa hoặc mã hàng thành item.
    - Mảng "items" CHỈ có phần tử khi category = "MARKET", các loại khác để mảng rỗng [].
    - amount = Tổng tiền THỰC TẾ THANH TOÁN (đã trừ discount trên bill - lấy số tiền cuối cùng user phải trả).
    - PHÂN BIỆT quantity và standardQuantity: "500g" hoặc "0.5kg" là định lượng, KHÔNG phải 500 sản phẩm. Ví dụ một phần thịt 500g: quantity=1, unit="Phần", standardQuantity=500, standardUnit="G".
    - standardQuantity luôn là TỔNG lượng của cả dòng hàng. Ví dụ 2 gói, mỗi gói 500g: quantity=2, unit="Gói", standardQuantity=1000, standardUnit="G".
    - Không suy đoán khối lượng/thể tích phổ biến. Ví dụ "mua ức gà 50 nghìn" không cho biết số gram: standardQuantity=0, standardUnit="" để ứng dụng yêu cầu người dùng xác nhận.
    - Với hàng cân có dạng "0.500 x 99.000 = 49.500": quantity=1, unit="Phần", standardQuantity=500, standardUnit="G", purchasePrice=49500, lineTotal=49500.
    - purchasePrice của từng item là đơn giá GHI TRÊN BILL, KHÔNG trừ voucher tổng. Cho phép sum(items × qty) > amount nếu có voucher tổng bị trừ ở dòng cuối.
    - TUYỆT ĐỐI CHỈ trả về JSON thuần, KHÔNG bọc kết quả trong thẻ markdown \`\`\`json.
    - JSON BẮT BUỘC PHẢI HỢP LỆ (Dấu ngoặc kép bao quanh TẤT CẢ các keys và chuỗi string).
    - Nếu câu nói/văn bản chứa nhiều giao dịch RỜI RẠC, KHÁC NHAU VỀ MỤC ĐÍCH HOẶC THỜI GIAN (ví dụ: "Ăn sáng 50k, và đi siêu thị mua rau 20k"), hãy tách chúng ra thành một MẢNG (Array) các object giao dịch.
    - QUAN TRỌNG: Nếu có nhiều khoản chi lẻ tẻ nhưng CÙNG MỤC ĐÍCH hoặc THUỘC VỀ VIỆC MUA SẮM VẬT TƯ/THỰC PHẨM (ví dụ: mua trứng, mua rau, thịt) dù chúng được kể XEN KẼ với các khoản chi khác, HÃY GOM TẤT CẢ CHÚNG LẠI thành MỘT giao dịch duy nhất chứa nhiều items.
    - Ví dụ: "Ăn sáng 10k, mua trứng 15k, uống trà sữa 15k, mua rau 5k" -> Phải trả về mảng 3 giao dịch: [ {Ăn sáng: 10k}, {Đi chợ (trứng 15k + rau 5k): tổng 20k, items: [trứng, rau]}, {Trà sữa: 15k} ].
    - KẾT QUẢ CUỐI CÙNG LUÔN LUÔN LÀ MỘT MẢNG JSON, ví dụ: [ { giao dịch 1 }, { giao dịch 2 } ] (ngay cả khi chỉ có 1 giao dịch thì cũng bọc trong mảng [ {...} ]).`;
    }

    let promptParts = [];

    if (base64Image) {
        // OCR hóa đơn từ ảnh Base64
        promptParts.push({ text: 'Hãy đọc ảnh hóa đơn đính kèm và bóc tách dữ liệu.' });

        const hasHeader = base64Image.includes(',');
        const mimeType = hasHeader ? base64Image.split(';')[0].split(':')[1] : 'image/jpeg';
        const cleanBase64 = hasHeader ? base64Image.split(',')[1] : base64Image;

        promptParts.push({ inlineData: { data: cleanBase64, mimeType } });
    } else if (inputSource === 'OCR_TEXT') {
        promptParts.push({ text: `Đây là TOÀN BỘ văn bản OCR của một hóa đơn. Hãy đọc từ đầu đến cuối, giữ đủ mọi dòng hàng và cấu trúc hóa dữ liệu:\n${cleanRawText}` });
    } else {
        // Xử lý ghi chú nhanh hoặc giọng nói (STT từ Flutter)
        promptParts.push({ text: `Phân tích câu ghi chép chi tiêu sau: "${cleanRawText}"` });
    }

    let responseText = "";
    let aiMetadata = null;
    let cacheHit = false;
    let cacheBypassed = false;
    let cacheKey = null;
    try {
        cacheKey = createReceiptCacheKey({
            userId: req.user?.userId,
            rawText: cleanRawText,
            base64Image,
            promptVersion: 'receipt-v5-legacy-image-json'
        });
        const cached = await getOrCreateReceiptRequest(
            cacheKey,
            () => geminiService.generateStructuredReceipt({
                systemInstruction,
                promptParts,
                requestId,
                inputMode
            }),
            { bypassCache: forceRefresh === true }
        );
        responseText = cached.value.text;
        aiMetadata = cached.value.metadata;
        cacheHit = cached.cacheHit;
        cacheBypassed = cached.cacheBypassed;
        console.info('[Receipt request]', {
            requestId,
            inputMode,
            cacheHit,
            cacheBypassed,
            ocrCharacterCount: cleanRawText.length,
            ocrLineCount: lineCount,
            imageBytes,
            durationMs: Date.now() - startedAt
        });
    } catch (error) {
        console.error('[Receipt request failed]', {
            requestId,
            inputMode,
            durationMs: Date.now() - startedAt,
            code: error.code || 'AI_UNAVAILABLE',
            message: error.message
        });
        return res.status(error.statusCode || 503).json({
            success: false,
            code: error.code || 'AI_UNAVAILABLE',
            message: error.message
        });
    }

    // Dọn dẹp thẻ markdown nếu AI vẫn cố tình sinh ra
    responseText = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
    
    let ocrResultData;
    try {
        ocrResultData = JSON.parse(responseText);
    } catch (e) {
        if (cacheKey) deleteReceiptRequestCache(cacheKey);
        console.error('Lỗi parse JSON từ AI:', responseText);
        return res.status(502).json({
            success: false,
            code: 'AI_INVALID_JSON',
            message: 'AI gặp khó khăn khi phân tích hóa đơn này. Vui lòng chụp rõ hơn hoặc quét lại!'
        });
    }

    // Nếu là utility, trả thẳng raw AI output cho Frontend tự tạo bản nháp thay vì dùng logic đi chợ
    if (type === 'utility') {
        if (ocrResultData.isReadable === false) {
            return res.status(422).json({
                success: false,
                code: 'RECEIPT_UNREADABLE',
                message: ocrResultData.reason || 'Không thể đọc được ảnh hóa đơn, vui lòng chụp rõ hơn.'
            });
        }
        return res.status(200).json({
            success: true,
            message: 'AI bóc tách hóa đơn tiện ích thành công!',
            data: ocrResultData 
        });
    }

    let normalizedTransactions = normalizeTransactionList(ocrResultData);

    // báo lỗi nếu ảnh mờ
    if (normalizedTransactions[0]?.isReadable === false) {
        if (cacheKey) deleteReceiptRequestCache(cacheKey);
        return res.status(422).json({
            success: false,
            code: 'RECEIPT_UNREADABLE',
            message: normalizedTransactions[0].reason || 'Không thể đọc được ảnh hóa đơn, vui lòng chụp rõ hơn.',
            warnings: normalizedTransactions[0].warnings
        });
    }

    const extractionValidation = validateExtractedReceiptTransactions(normalizedTransactions, { inputMode });
    if (!extractionValidation.valid) {
        if (cacheKey) deleteReceiptRequestCache(cacheKey);
        console.warn('[Receipt rejected]', {
            requestId,
            inputMode,
            code: extractionValidation.code,
            transactionCount: normalizedTransactions.length,
            amounts: normalizedTransactions.map(transaction => transaction.amount),
            itemCounts: normalizedTransactions.map(transaction =>
                Array.isArray(transaction.items) ? transaction.items.length : 0
            )
        });
        return res.status(422).json({
            success: false,
            code: extractionValidation.code,
            message: extractionValidation.message
        });
    }
    normalizedTransactions = extractionValidation.data;

    const itemCount = normalizedTransactions.reduce((sum, transaction) =>
        sum + (Array.isArray(transaction.items) ? transaction.items.length : 0), 0);
    console.info('[Receipt normalized]', {
        requestId,
        inputMode,
        cacheHit,
        cacheBypassed,
        transactionCount: normalizedTransactions.length,
        itemCount,
        warningCodes: [...new Set(normalizedTransactions.flatMap(transaction =>
            (transaction.warnings || []).map(warning => warning.code)
        ))]
    });

    normalizedTransactions = normalizedTransactions.map(t => ({
        ...t,
        aiLatencyMs: aiMetadata?.durationMs || null,
        aiItemCount: Array.isArray(t.items) ? t.items.length : 0
    }));

    const response = {
        success: true,
        message: 'AI bóc tách dữ liệu thành công!',
        data: normalizedTransactions
    };
    if (process.env.NODE_ENV !== 'production' || process.env.AI_USAGE_IN_RESPONSE === 'true') {
        response.aiUsage = { ...aiMetadata, requestId, cacheHit, cacheBypassed, itemCount };
    }
    return res.status(200).json(response);
});

// Lưu giao dịch và đồng bộ vào kho (MongoDB Session)
exports.addTransaction = asyncHandler(async (req, res) => {
    const { userId } = req.body;
    const idempotencyKey = String(req.get('Idempotency-Key') || req.body.idempotencyKey || '').trim();

    if (!idempotencyKey || idempotencyKey.length > 120) {
        return res.status(400).json({
            success: false,
            message: 'Idempotency-Key là bắt buộc và không được dài quá 120 ký tự.'
        });
    }

    // check quyền sở hữu
    if (req.user.userId.toString() !== userId?.toString()) {
        return res.status(403).json({
            success: false,
            message: 'Bạn không thể lưu giao dịch cho tài khoản khác!'
        });
    }

    const previousTransaction = await Transaction.findOne({ userId, idempotencyKey });
    if (previousTransaction) {
        return res.status(200).json({
            success: true,
            replayed: true,
            message: 'Giao dịch này đã được lưu trước đó.',
            data: previousTransaction,
            gamificationRewards: previousTransaction.gamificationRewards?.wisBonus > 0
                ? previousTransaction.gamificationRewards
                : null
        });
    }

    // Không tin lại payload sau bước preview: chuẩn hóa và validate lần cuối
    // trước khi dữ liệu ảnh hưởng sổ chi tiêu và tồn kho.
    const normalizedDraft = normalizeTransactionDraft(req.body);
    if (hasBlockingWarnings(normalizedDraft)) {
        return res.status(422).json({
            success: false,
            message: 'Hóa đơn còn dữ liệu bắt buộc chưa hợp lệ. Vui lòng kiểm tra lại.',
            warnings: normalizedDraft.warnings
        });
    }

    const {
        transactionType, amount, discount,
        note, date, category, paymentMethod, merchantName, items
    } = normalizedDraft;

    // ngày thực tế trên hóa đơn
    const finalDate = date ? new Date(date) : new Date();

    // Chuẩn bị mảng Items để bơm sang kho (chỉ khi là giao dịch đi chợ MARKET)
    const itemsToInject = (category === 'MARKET' && Array.isArray(items) && items.length > 0)
        ? items.map(item => ({
            userId,
            transactionId: null,         // Sẽ được gán sau khi có _id của transaction
            rawName: item.rawName,
            itemName: item.itemName,
            brand: item.brand || 'No name',
            category: item.category || 'OTHER',
            subCategory: item.subCategory || '',
            quantity: item.quantity,
            originalQuantity: item.originalQuantity ?? item.quantity,
            unit: item.unit,
            standardQuantity: item.standardQuantity,
            standardUnit: item.standardUnit,
            isSingleUse: item.standardUnit === 'PIECE',
            purchasePrice: Math.round(item.purchasePrice),
            baseUnitPrice: calculateBaseUnitPrice(item),
            storageLocation: item.storageLocation,
            expiryDate: item.expiryDate,
            expirySource: item.expirySource,
            expiryRuleCode: item.expiryRuleCode,
            usageStatus: 'ACTIVE'
        }))
        : [];

    // ATOMIC TRANSACTION (MongoDB Session)
    const session = await mongoose.startSession();
    let newTransaction;
    let gamificationRewards = null;
    let pendingGamificationPush = null;
    try {
        session.startTransaction();

        const aiLatencyMs = typeof req.body.aiLatencyMs === 'number' && req.body.aiLatencyMs >= 0 ? Math.round(req.body.aiLatencyMs) : null;
        const aiItemCount = typeof req.body.aiItemCount === 'number' && req.body.aiItemCount >= 0 ? Math.round(req.body.aiItemCount) : null;
        const aiEditedFieldCount = typeof req.body.aiEditedFieldCount === 'number' && req.body.aiEditedFieldCount >= 0 ? Math.round(req.body.aiEditedFieldCount) : null;

        // Bước 1: Tạo bản ghi giao dịch tài chính vào Sổ thu chi
        [newTransaction] = await Transaction.create([{
            userId,
            transactionType,
            amount: Math.round(amount),       // Khử lỗi float của JS
            discount: Math.round(discount || 0),
            note,
            date: finalDate,
            category,
            paymentMethod,
            merchantName,
            idempotencyKey,
            aiLatencyMs,
            aiItemCount,
            aiEditedFieldCount,
            items  // Lưu giỏ hàng nhúng (embedded) vào Transaction để tra cứu nhanh
        }], { session });

        // Bước 2: Bơm các Items sang bảng kho (nếu là giao dịch MARKET)
        if (itemsToInject.length > 0) {
            const itemsWithTxId = itemsToInject.map(item => ({
                ...item,
                transactionId: newTransaction._id // Gắn ID nguồn để Cascade Delete sau này
            }));
            await Item.insertMany(itemsWithTxId, { session });

            // So sánh giá mua thông minh (Gamification)
            let totalSavedAmount = 0;
            let bonusWisToGive = 0;
            const gamificationMessages = [];

            for (const item of itemsWithTxId) {
                if (item.baseUnitPrice > 0 && item.standardUnit) {
                    const lastPurchase = await Item.findOne({
                        userId,
                        itemName: item.itemName,
                        standardUnit: item.standardUnit,
                        transactionId: { $ne: newTransaction._id }
                    }).sort({ createdAt: -1 }).session(session);

                    if (lastPurchase && lastPurchase.baseUnitPrice > item.baseUnitPrice) {
                        const priceDiff = lastPurchase.baseUnitPrice - item.baseUnitPrice;
                        const savedAmount = priceDiff * (item.standardQuantity || item.quantity);
                        if (savedAmount > 0) {
                            totalSavedAmount += savedAmount;
                            bonusWisToGive += 1;
                            gamificationMessages.push(`Mua ${item.itemName} rẻ hơn, tiết kiệm ${Math.round(savedAmount)}đ.`);
                        }
                    }
                }
            }

            if (bonusWisToGive > 0) {
                await User.findByIdAndUpdate(userId, {
                    $inc: { 'rpgStats.bonusWis': bonusWisToGive }
                }, { session });
                gamificationRewards = {
                    savedAmount: Math.round(totalSavedAmount),
                    wisBonus: bonusWisToGive,
                    message: gamificationMessages.join(' ') + ` (+${bonusWisToGive} WIS)`
                };
                newTransaction.gamificationRewards = gamificationRewards;
                await newTransaction.save({ session });
                
                // Tạo thông báo cho user
                const Notification = require('../models/notification.model');
                await Notification.create([{
                    userId,
                    title: '🎉 Mua sắm thông minh!',
                    message: gamificationRewards.message,
                    type: 'GAMIFICATION'
                }], { session });
                
                // Lưu vào Nhật ký sinh tồn
                const RpgLog = require('../models/rpgLog.model');
                await RpgLog.create([{
                    userId,
                    type: 'TRANSACTION',
                    title: gamificationRewards.message,
                    wisChange: bonusWisToGive,
                    metadata: { transactionId: newTransaction._id }
                }], { session });

                // Chuẩn bị push nhưng chỉ gửi sau khi MongoDB commit thành công.
                const userDoc = await User.findById(userId).session(session);
                const validTokens = (userDoc?.fcmTokens || [])
                    .filter(token => typeof token === 'string' && token.trim().length > 0);
                if (validTokens.length > 0) {
                    pendingGamificationPush = {
                        notification: {
                            title: '🎉 Mua sắm thông minh!',
                            body: gamificationRewards.message
                        },
                        tokens: validTokens
                    };
                }
            }
        }

        await session.commitTransaction();
    } catch (err) {
        if (session.inTransaction()) await session.abortTransaction();
        if (err.code === 11000) {
            const existingTransaction = await Transaction.findOne({ userId, idempotencyKey });
            if (existingTransaction) {
                return res.status(200).json({
                    success: true,
                    replayed: true,
                    message: 'Giao dịch này đã được lưu trước đó.',
                    data: existingTransaction,
                    gamificationRewards: existingTransaction.gamificationRewards?.wisBonus > 0
                        ? existingTransaction.gamificationRewards
                        : null
                });
            }
        }
        throw err; // Chuyển lỗi về errorHandler tập trung xử lý
    } finally {
        session.endSession(); // Luôn đóng session dù thành công hay thất bại
    }

    if (pendingGamificationPush) {
        const { admin } = require('../config/firebase.config');
        if (admin.apps && admin.apps.length > 0) {
            try {
                const response = await admin.messaging().sendEachForMulticast(pendingGamificationPush);
                console.log(`[Firebase] Đã gửi ${response.successCount} push notification Gamification cho user ${userId}`);
            } catch (fcmError) {
                console.error('[Firebase] Lỗi khi gửi FCM Gamification:', fcmError.message);
            }
        }
    }

    let gamificationState = null;
    try {
        gamificationState = await rpgService.calculateUserStats(userId);
        if (Number(gamificationState?.def || 0) >= 100) {
            await questService.triggerAchievement(userId, 'MAX_DEF_ACHIEVED', 1);
        }
    } catch (error) {
        console.error('[RPG] Không thể tính lại chỉ số sau giao dịch:', error.message);
    }
    await questService.triggerDailyQuest(userId, 'CREATE_TRANSACTION', 1);
    if (category === 'MARKET') {
        await questService.triggerDailyQuest(userId, 'CREATE_MARKET_TRANSACTION', 1);
    }
    
    // Nếu giao dịch được thêm từ việc quét hóa đơn
    if (req.body.inputSource === 'image' || req.body.inputSource === 'ocr_text') {
        await questService.triggerDailyQuest(userId, 'SCAN_RECEIPT', 1);
    }

    console.log(`[API] ${req.method} ${req.originalUrl} - Add transaction success (User: ${userId}, Tx: ${newTransaction._id})`);
    return res.status(201).json({
        success: true,
        message: 'Lưu giao dịch và đồng bộ kho đồ thành công!',
        data: newTransaction,
        gamificationRewards,
        gamificationState
    });
});

// Lấy lịch sử thu chi
exports.getHistory = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { mode, page = 1, limit = 20, period } = req.query; // ?mode=compact&period=YYYY-MM

    const periodFilter = parseHistoryPeriod(period);
    if (periodFilter === undefined) {
        return res.status(400).json({
            success: false,
            error: {
                code: 'INVALID_PERIOD',
                message: 'Tháng không hợp lệ. Dùng định dạng YYYY-MM.',
                retryable: false,
                details: {}
            }
        });
    }

    const projection = mode === 'compact' ? { items: 0 } : {};

    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const skip = (pageNum - 1) * limitNum;

    const filter = { userId, ...(periodFilter ? { date: periodFilter } : {}) };
    const history = await Transaction.find(filter, projection)
        .sort({ date: -1 })
        .skip(skip)
        .limit(limitNum);
        
    const total = await Transaction.countDocuments(filter);
    const hasMore = skip + history.length < total;

    console.log(`[API] ${req.method} ${req.originalUrl} - Get history success (User: ${userId})`);
    return res.status(200).json({ 
        success: true, 
        count: history.length, 
        total,
        page: pageNum,
        period: period || null,
        hasMore,
        data: history 
    });
});

// Lấy chi tiết giao dịch
exports.getTransactionById = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const tx = await Transaction.findById(id);
    if (!tx) {
        return res.status(404).json({ success: false, message: 'Không tìm thấy giao dịch!' });
    }

    // Kiểm tra quyền sở hữu
    if (req.user.userId.toString() !== tx.userId.toString()) {
        return res.status(403).json({ success: false, message: 'Bạn không có quyền xem giao dịch này!' });
    }

    console.log(`[API] ${req.method} ${req.originalUrl} - Get detail success (User: ${req.user.userId}, Tx: ${id})`);
    return res.status(200).json({ success: true, data: tx });
});

// Xóa giao dịch (Cascade xóa item kho)
exports.deleteTransaction = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const session = await mongoose.startSession();
    let tx;
    try {
        await session.withTransaction(async () => {
            tx = await Transaction.findById(id).session(session);
            if (!tx) {
                const error = new Error('Không tìm thấy giao dịch cần xóa!');
                error.statusCode = 404;
                throw error;
            }
            if (req.user.userId.toString() !== tx.userId.toString()) {
                const error = new Error('Bạn không có quyền xóa giao dịch này!');
                error.statusCode = 403;
                throw error;
            }

            await Item.deleteMany({ transactionId: id, userId: tx.userId }).session(session);
            await MeterReading.updateMany(
                { transactionId: id, userId: tx.userId },
                {
                    $set: {
                        paidAmount: null,
                        differenceAmount: null,
                        differencePercent: null,
                        hasLargeDifference: false,
                        paidAt: null,
                        transactionDate: null,
                        transactionId: null,
                        paymentIdempotencyKey: null
                    }
                },
                { session }
            );
            await Transaction.deleteOne({ _id: id, userId: tx.userId }).session(session);

            const wisBonus = Number(tx.gamificationRewards?.wisBonus || 0);
            if (wisBonus > 0) {
                await User.updateOne(
                    { _id: tx.userId },
                    [{
                        $set: {
                            'rpgStats.bonusWis': {
                                $max: [0, { $subtract: [{ $ifNull: ['$rpgStats.bonusWis', 0] }, wisBonus] }]
                            }
                        }
                    }],
                    { session }
                );
            }

        });
    } finally {
        await session.endSession();
    }

    try {
        await rpgService.calculateUserStats(req.user.userId);
    } catch (error) {
        console.error('[RPG] Không thể tính lại chỉ số sau khi xóa giao dịch:', error.message);
    }

    console.log(`[API] ${req.method} ${req.originalUrl} - Delete transaction success (User: ${req.user.userId}, Tx: ${id})`);
    return res.status(200).json({
        success: true,
        message: 'Đã xóa giao dịch và giải phóng các vật phẩm liên quan khỏi kho!'
    });
});

const financeInsightCache = new Map();
const survivalInsightCache = new Map();

exports.getFinanceInsight = asyncHandler(async (req, res) => {
    const userId = req.user.userId;
    const period = String(req.query.period || moment().tz('Asia/Ho_Chi_Minh').format('YYYY-MM'));
    const dateFilter = parseHistoryPeriod(period);
    if (dateFilter === undefined || dateFilter === null) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_PERIOD', message: 'Tháng không hợp lệ', retryable: false, details: {} } });
    }
    const monthStart = moment(dateFilter.$gte).tz('Asia/Ho_Chi_Minh');
    const previousStart = monthStart.clone().subtract(1, 'month');
    const previousEnd = monthStart.clone();
    const user = await User.findById(userId).lean();
    if (!user) return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng.' });
    const [current, previous, atRiskItems] = await Promise.all([
        Transaction.aggregate([
            { $match: { userId: new mongoose.Types.ObjectId(userId), transactionType: 'EXPENSE', date: dateFilter } },
            { $group: { _id: '$category', amount: { $sum: '$amount' }, count: { $sum: 1 } } }
        ]),
        Transaction.aggregate([
            { $match: { userId: new mongoose.Types.ObjectId(userId), transactionType: 'EXPENSE', date: { $gte: previousStart.toDate(), $lt: previousEnd.toDate() } } },
            { $group: { _id: '$category', amount: { $sum: '$amount' } } }
        ]),
        Item.find({ userId, usageStatus: 'ACTIVE', expiryDate: { $gte: monthStart.toDate(), $lte: moment().tz('Asia/Ho_Chi_Minh').add(3, 'days').endOf('day').toDate() } })
            .select('purchasePrice quantity originalQuantity').lean()
    ]);
    const categoryBreakdown = current.map(item => ({ category: item._id || 'OTHERS', amount: Math.round(item.amount), count: item.count }));
    const previousCategoryBreakdown = Object.fromEntries(previous.map(item => [item._id || 'OTHERS', Math.round(item.amount)]));
    const spent = categoryBreakdown.reduce((sum, item) => sum + item.amount, 0);
    const inventoryAtRiskValue = atRiskItems.reduce((sum, item) => sum + (Number(item.purchasePrice) || 0) * Math.max(0, Number(item.quantity) || 0) / Math.max(1, Number(item.originalQuantity) || 1), 0);
    const now = moment().tz('Asia/Ho_Chi_Minh');
    const isCurrentMonth = now.format('YYYY-MM') === period;
    const snapshot = financeInsightService.createSnapshot({
        period, budget: user.monthlyBudget, essentialBudget: user.essentialBudget, spent,
        daysElapsed: isCurrentMonth ? now.date() : monthStart.daysInMonth(),
        daysRemaining: isCurrentMonth ? monthStart.daysInMonth() - now.date() : 0,
        categoryBreakdown, previousCategoryBreakdown, inventoryAtRiskValue,
        rpgStats: user.rpgStats || {}, transactionCount: current.reduce((sum, item) => sum + item.count, 0)
    });
    const cacheKey = `${userId}:${period}:${financeInsightService.hashSnapshot(snapshot)}`;
    const cached = financeInsightCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() && req.query.refresh !== 'true') {
        return res.status(200).json({ success: true, data: { snapshot, insight: cached.insight, fallbackUsed: cached.fallbackUsed, cached: true } });
    }
    let insight = financeInsightService.fallbackInsight(snapshot);
    let fallbackUsed = true;
    try {
        const cards = snapshot.factCodes.map(code => ({ factCode: code, safeAdvice: financeInsightService.KNOWLEDGE_CARDS[code] })).slice(0, 5);
        const ai = await geminiService.generateStructuredFinanceInsight({
            requestId: req.id || 'finance-insight',
            systemInstruction: 'Bạn là trợ lý tài chính sinh tồn hỗ trợ, chỉ diễn giải fact được cấp. Trả JSON thuần theo schema, không đưa lời khuyên y tế, đầu tư hoặc vay nợ.',
            prompt: `SNAPSHOT=${JSON.stringify(snapshot)}\nKNOWLEDGE_CARDS=${JSON.stringify(cards)}\nTrả {tone,headline,summary,highlights:[{factCode,message,evidenceNumbers}],actions:[{actionCode,title,reason,estimatedImpact}]}.`
        });
        const validated = financeInsightService.validateInsight(JSON.parse(ai.text), snapshot);
        if (validated) { insight = validated; fallbackUsed = false; }
    } catch (error) {
        console.warn('[Finance insight] fallback:', error.code || error.message);
    }
    financeInsightCache.set(cacheKey, { insight, fallbackUsed, expiresAt: Date.now() + 5 * 60 * 1000 });
    return res.status(200).json({ success: true, data: { snapshot, insight, fallbackUsed, cached: false } });
});

exports.getAdviceInsight = asyncHandler(async (req, res) => {
    const userId = req.user.userId;
    const user = await User.findById(userId).lean();
    if (!user) return res.status(404).json({ success: false, message: 'Khong tim thay nguoi dung' });
    
    const rpgSvc = require('../services/rpg.service');
    const rpgStats = await rpgSvc.calculateUserStats(userId);
    
    const Item = require('../models/item.model');
    const activeItems = await Item.find({ userId, usageStatus: 'ACTIVE' }).limit(20).lean();
    const itemsList = activeItems.map(i => `- ${i.itemName} (Còn ${i.quantity} ${i.unit})`).join('\n');
    
    const promptText = `
Tài chính hiện tại:
- HP: ${rpgStats.hp}%
- MANA: ${rpgStats.mana} VND
- DEF: ${rpgStats.def}%
- WIS: ${rpgStats.wis}%
- Ngân sách tháng (Flexible): ${Math.max(0, (user.monthlyBudget || 0) - (user.fixedBudget || 0))} VND

Thực phẩm trong tủ:
${itemsList || 'Trống'}

Hãy đưa ra 1 lời khuyên sắc bén, hài hước và mang tính chiến thuật (Mách nước) khoảng 2-3 câu để giúp tôi sống sót qua tháng này.
YÊU CẦU QUAN TRỌNG:
1. KHÔNG được nhắc lại các con số HP, MANA, DEF, WIS (người dùng đã nhìn thấy trên màn hình).
2. Tập trung chỉ ra MỐI LIÊN HỆ giữa túi tiền hiện tại và đồ ăn trong tủ, từ đó gợi ý một HÀNH ĐỘNG CỤ THỂ ngay hôm nay (ví dụ: cấm ăn hàng, nấu món gì, hay xõa đi).
3. Câu văn tự nhiên, ngắn gọn, giống một người bạn đang "mách nước" chứ không phải báo cáo tài chính.
`;

    const systemInstruction = 'Bạn là NPC Cố vấn Sinh tồn cực kỳ thông minh, hài hước, và có chút cà khịa. Đưa ra lời khuyên ngắn gọn, dễ hiểu dựa trên ngân sách và tủ lạnh của người dùng. Trả về text thuần.';
    const advice = await geminiService.generateGeneralAdvice(systemInstruction, promptText);
    
    return res.status(200).json({ success: true, advice });
});

exports.getSurvivalInsight = asyncHandler(async (req, res) => {
    const userId = req.user.userId;
    const rpgStats = await rpgService.calculateUserStats(userId);
    if (!rpgStats) return res.status(404).json({ success: false, message: 'Không tìm thấy dữ liệu sinh tồn.' });
    const snapshot = survivalInsightService.createSnapshot(rpgStats);
    const cacheKey = `${userId}:${survivalInsightService.hashSnapshot(snapshot)}`;
    const cached = survivalInsightCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() && req.query.refresh !== 'true') {
        return res.status(200).json({ success: true, data: { snapshot, insight: cached.insight, fallbackUsed: cached.fallbackUsed, cached: true } });
    }
    let insight = survivalInsightService.fallbackInsight(snapshot);
    let fallbackUsed = true;
    try {
        const cards = snapshot.stats.map(item => ({ stat: item.stat, factCode: item.factCode, safeAdvice: survivalInsightService.KNOWLEDGE_CARDS[item.factCode] }));
        const ai = await geminiService.generateStructuredSurvivalInsight({
            requestId: req.id || 'survival-insight',
            systemInstruction: 'Bạn là NPC Sinh tồn trong game, hướng dẫn người chơi quản lý máu (HP) và mana (tiền ăn chơi). Giọng văn sắc bén, hài hước, nhập vai sinh tồn. Chỉ diễn giải fact được cấp, không thay đổi chỉ số. Không khuyên ăn thực phẩm quá hạn, vay mượn hay đầu tư.',
            prompt: `SNAPSHOT=${JSON.stringify(snapshot)}\nKNOWLEDGE_CARDS=${JSON.stringify(cards)}\nTrả JSON thuần {headline,summary,statMessages:[{stat,factCode,message}]}; đủ HP, MANA, DEF, WIS. Diễn giải sắc bén, hài hước, phân tích mối quan hệ giữa thực phẩm trong kho và tiền tự do; giải thích rõ vì sao HP hay MANA lại giảm. Bám sát value/evidence.`
        });
        const validated = survivalInsightService.validateInsight(JSON.parse(ai.text), snapshot);
        if (validated) { insight = validated; fallbackUsed = false; }
    } catch (error) {
        console.warn('[Survival insight] fallback:', error.code || error.message);
    }
    survivalInsightCache.set(cacheKey, { insight, fallbackUsed, expiresAt: Date.now() + 5 * 60 * 1000 });
    return res.status(200).json({ success: true, data: { snapshot, insight, fallbackUsed, cached: false } });
});

const { getCycleDates } = require('../services/rpg.service');

exports.getStatistics = asyncHandler(async (req, res) => {
    const userId = req.user.userId;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    
    // Always recalculate RPG stats to ensure latest data
    const rpgSvc = require('../services/rpg.service');
    const newStats = await rpgSvc.calculateUserStats(userId);
    if (newStats) user.rpgStats = newStats;

    const cycleStartDay = user.cycleStartDay || 1;
    const { startDate, endDate, now } = getCycleDates(cycleStartDay);

    // Tính toán số ngày chu kỳ (dùng moment để xử lý timezone an toàn)
    const startM = moment(startDate).tz('Asia/Ho_Chi_Minh');
    const endM = moment(endDate).tz('Asia/Ho_Chi_Minh');
    const nowM = moment(now).tz('Asia/Ho_Chi_Minh');
    
    // endM đang trỏ đến 23:59:59 của ngày cuối chu kỳ. startM trỏ đến 00:00:00 của ngày đầu.
    const totalDays = Math.ceil(endM.diff(startM, 'days', true));
    let daysPassed = Math.ceil(nowM.diff(startM, 'days', true));
    if (daysPassed < 1) daysPassed = 1;
    if (daysPassed > totalDays) daysPassed = totalDays;

    // Lấy tổng chi tiêu trong chu kỳ (spent)
    const transactions = await Transaction.find({
        userId,
        date: { $gte: startDate, $lte: endDate },
        transactionType: 'EXPENSE'
    });
    
    const FIXED_EXPENSE_CATEGORIES = new Set(['HOUSING', 'ACADEMICS']);
    let spent = 0;
    let fixedExpense = 0;
    transactions.forEach(t => {
        spent += t.amount;
        if (FIXED_EXPENSE_CATEGORIES.has(t.category)) {
            fixedExpense += t.amount;
        }
    });

    // Lấy giá trị wasted trong chu kỳ
    const wastedItems = await Item.find({
        userId,
        usageStatus: 'WASTED',
        updatedAt: { $gte: startDate, $lte: endDate }
    });

    let wasted = 0;
    wastedItems.forEach(item => {
        if (item.originalQuantity > 0) {
            const ratio = item.quantity / item.originalQuantity;
            wasted += (item.purchasePrice * ratio);
        }
    });

    // Lấy inventory counts
    const activeItemsCount = await Item.countDocuments({ userId, usageStatus: 'ACTIVE' });
    
    // Count expired items amongst active ones
    const activeItems = await Item.find({ userId, usageStatus: 'ACTIVE' });
    let expiredItemsCount = 0;
    activeItems.forEach(item => {
        if (item.expiryDate) {
            const expiry = moment(item.expiryDate).tz('Asia/Ho_Chi_Minh').startOf('day');
            const today = moment().tz('Asia/Ho_Chi_Minh').startOf('day');
            if (expiry.isBefore(today)) {
                expiredItemsCount++;
            }
        }
    });

    const fixedBudget = user.fixedBudget || 0;
    // Ngân sách linh hoạt = Ngân sách tổng - Tiền nhà cố định
    const flexibleTotal = Math.max(0, (user.monthlyBudget || 0) - fixedBudget);
    // Tiền đã chi linh hoạt = Tổng chi - Tiền đã chi cho cố định
    const flexibleSpent = Math.max(0, spent - fixedExpense);
    const remaining = flexibleTotal - flexibleSpent;

    return res.status(200).json({
        success: true,
        data: {
            cycle: { 
                startDate: startM.format('YYYY-MM-DD'), 
                endDate: endM.format('YYYY-MM-DD'), 
                daysPassed, 
                totalDays 
            },
            budget: { 
                total: flexibleTotal, 
                spent: flexibleSpent, 
                wasted: Math.round(wasted), 
                remaining 
            },
            rpgStats: { 
                hp: user.rpgStats.hp || 0, 
                maxHp: user.rpgStats.maxHp || 100, 
                mana: user.rpgStats.mana || 0, 
                maxMana: user.rpgStats.maxMana || 100, 
                def: user.rpgStats.def || 0, 
                wis: user.rpgStats.wis || 0 
            },
            inventory: { 
                activeItems: activeItemsCount, 
                expiredItems: expiredItemsCount 
            }
        }
    });
});

// Thống kê chi tiêu theo tháng - GET /api/transactions/stats/monthly?limit=6
exports.getMonthlyStats = asyncHandler(async (req, res) => {
    const userId = req.user.userId;
    const limit = Math.min(parseInt(req.query.limit) || 6, 24);

    // Lấy N+1 tháng để tính % thay đổi cho tháng cũ nhất
    const now = moment().tz('Asia/Ho_Chi_Minh');
    const startOfQuery = now.clone().subtract(limit, 'months').startOf('month').toDate();

    const monthlyData = await Transaction.aggregate([
        {
            $match: {
                userId: new mongoose.Types.ObjectId(userId),
                transactionType: 'EXPENSE',
                date: { $gte: startOfQuery }
            }
        },
        {
            $group: {
                _id: {
                    year: { $year: { date: '$date', timezone: 'Asia/Ho_Chi_Minh' } },
                    month: { $month: { date: '$date', timezone: 'Asia/Ho_Chi_Minh' } },
                    category: '$category'
                },
                amount: { $sum: '$amount' },
                count: { $sum: 1 }
            }
        },
        {
            $group: {
                _id: { year: '$_id.year', month: '$_id.month' },
                totalExpense: { $sum: '$amount' },
                count: { $sum: '$count' },
                categoryBreakdown: {
                    $push: {
                        category: '$_id.category',
                        amount: '$amount',
                        count: '$count'
                    }
                }
            }
        },
        { $sort: { '_id.year': 1, '_id.month': 1 } }
    ]);

    // Tính % thay đổi so với tháng trước
    const result = monthlyData.map((item, index) => {
        const prev = index > 0 ? monthlyData[index - 1] : null;
        let changePercent = null;
        if (prev && prev.totalExpense > 0) {
            changePercent = ((item.totalExpense - prev.totalExpense) / prev.totalExpense) * 100;
        }
        return {
            year: item._id.year,
            month: item._id.month,
            label: `T${item._id.month}/${item._id.year}`,
            totalExpense: Math.round(item.totalExpense),
            count: item.count,
            categoryBreakdown: item.categoryBreakdown
                .map(category => ({
                    category: category.category || 'OTHERS',
                    amount: Math.round(category.amount),
                    count: category.count,
                    percent: item.totalExpense > 0
                        ? Math.round((category.amount / item.totalExpense) * 1000) / 10
                        : 0
                }))
                .sort((a, b) => b.amount - a.amount),
            changePercent: changePercent !== null ? Math.round(changePercent * 10) / 10 : null
        };
    });

    // Chỉ trả về limit tháng gần nhất (bỏ tháng đầu nếu chỉ dùng để tính delta)
    const trimmed = result.slice(-limit);

    return res.status(200).json({
        success: true,
        data: trimmed
    });
});
