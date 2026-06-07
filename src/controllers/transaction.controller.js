const mongoose = require('mongoose');
const Transaction = require('../models/transaction.model');
const Item = require('../models/item.model');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { asyncHandler } = require('../middleware/errorHandler.middleware');

// Khởi tạo Google AI SDK qua API Key bảo mật trong .env
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Sẽ dùng cơ chế fallback 3.5 -> 2.5 thay vì fix cứng 1 model

// Bóc tách hóa đơn bằng AI (OCR/NLP)
exports.parseDocument = asyncHandler(async (req, res) => {
    const { base64Image, rawText } = req.body;

    if (!base64Image && (!rawText || rawText.trim() === '')) {
        return res.status(400).json({
            success: false,
            message: 'Vui lòng truyền lên base64Image (ảnh hóa đơn) hoặc rawText (câu ghi chú nhanh).'
        });
    }

    // system prompt cho AI
    const systemInstruction = `
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
                "itemName": "Tên NGUYÊN LIỆU NẤU ĂN CỐT LÕI (VD: 'Ức gà', 'Đùi gà', 'Ba rọi heo', 'Sườn non', 'Sữa tươi'). TUYỆT ĐỐI CẮT BỎ các tính từ mô tả (tươi, ngon, sạch, hữu cơ, đông lạnh), trạng thái sơ chế (phi lê, có da, lột da, rút xương, cắt lát). Không chứa định lượng/đơn vị.",
                "rawName": "Giữ NGUYÊN BẢN 100% chữ cái trên hóa đơn (VD: 'Ức gà phi lê có da tươi CP 500g'). Tuyệt đối không tự bịa hay rút gọn.",
                "brand": "Thương hiệu nếu có, không có thì là 'No name'",
                "subCategory": "BẮT BUỘC trả về ĐÚNG 1 trong các MÃ CODE sau (Tuyệt đối không dùng tiếng Việt): PORK | BEEF | CHICKEN | DUCK | GOOSE | PROCESSED_MEAT | OTHER_MEAT | FISH | SHRIMP | SQUID_OCTOPUS | CRAB_SHELLFISH | OTHER_SEAFOOD | LEAFY_VEG | ROOT_VEG | MUSHROOM | HERB_SPICE_VEG | OTHER_VEG | CITRUS | TROPICAL | TEMPERATE | OTHER_FRUIT | MILK | WATER | SODA_JUICE | COFFEE_TEA | ALCOHOL | NOODLE_PASTA | RICE_GRAIN | BASIC_SPICE | SAUCE | OTHER. Rất quan trọng để phân loại tủ đồ.",
                "quantity": Số lượng mua (Number),
                "originalQuantity": Số lượng ban đầu - luôn bằng với quantity tại thời điểm mua (Number),
                "unit": "Đơn vị hiển thị (BẮT BUỘC CHỈ DÙNG: 'g', 'kg', 'ml', 'L', 'Trái/Quả', 'Cái', 'Phần', 'Khay', 'Vỉ', 'Lon', 'Chai', 'Gói', 'Bó'). Ưu tiên dùng 'Trái/Quả' thay vì 'cái/phần' nếu là trứng/trái cây.",
                "standardQuantity": Định lượng quy đổi toán học (VD: khay 500g -> 500, chai 1L -> 1000, 1 bó rau -> 1, 1 quả trứng -> 1),
                "standardUnit": "Đơn vị quy chuẩn BẮT BUỘC LÀ: G | KG | ML | L | PIECE",
                "isSingleUse": "Boolean (true/false) - true nếu là đồ dùng 1 lần hết luôn (lon coca, quả trứng, gói mì); false nếu là đồ dùng nhiều lần/chia nhỏ (chai sữa 1L, khay thịt 500g, chai nước mắm)",
                "purchasePrice": Đơn giá 1 đơn vị (unit) THEO GIÁ IN TRÊN HÓA ĐƠN - KHÔNG phân bổ voucher tổng vào từng món. Ví dụ: bill ghi "Ức gà CP x2 gói = 89.000đ" -> purchasePrice = 89000 (cho mỗi gói). Nếu không thấy đơn giá từng món riêng lẻ trên bill -> trả về 0 (Number),
                "category": "BẮT BUỘC LÀ 1 TRONG: MEAT | SEAFOOD | VEGETABLE | EGG | DRY_FOOD | DRINK | SPICE | COSMETIC | SUPPLEMENT | OTHER"
            }
        ]
    }

    QUY TẮC CHỐNG ẢO GIÁC BẮT BUỘC:
    - Mảng "items" CHỈ có phần tử khi category = "MARKET", các loại khác để mảng rỗng [].
    - amount = Tổng tiền THỰC TẾ THANH TOÁN (đã trừ discount trên bill - lấy số tiền cuối cùng user phải trả).
    - purchasePrice của từng item là đơn giá GHI TRÊN BILL, KHÔNG trừ voucher tổng. Cho phép sum(items × qty) > amount nếu có voucher tổng bị trừ ở dòng cuối.
    - TUYỆT ĐỐI CHỈ trả về JSON thuần, KHÔNG bọc kết quả trong thẻ markdown \`\`\`json.
    - JSON BẮT BUỘC PHẢI HỢP LỆ (Dấu ngoặc kép bao quanh TẤT CẢ các keys và chuỗi string).
    - Nếu câu nói/văn bản chứa nhiều giao dịch RỜI RẠC, KHÁC NHAU VỀ MỤC ĐÍCH HOẶC THỜI GIAN (ví dụ: "Ăn sáng 50k, và đi siêu thị mua rau 20k"), hãy tách chúng ra thành một MẢNG (Array) các object giao dịch.
    - QUAN TRỌNG: Nếu có nhiều khoản chi lẻ tẻ nhưng CÙNG MỤC ĐÍCH hoặc THUỘC VỀ VIỆC MUA SẮM VẬT TƯ/THỰC PHẨM (ví dụ: mua trứng, mua rau, thịt) dù chúng được kể XEN KẼ với các khoản chi khác, HÃY GOM TẤT CẢ CHÚNG LẠI thành MỘT giao dịch duy nhất chứa nhiều items.
    - Ví dụ: "Ăn sáng 10k, mua trứng 15k, uống trà sữa 15k, mua rau 5k" -> Phải trả về mảng 3 giao dịch: [ {Ăn sáng: 10k}, {Đi chợ (trứng 15k + rau 5k): tổng 20k, items: [trứng, rau]}, {Trà sữa: 15k} ].
    - KẾT QUẢ CUỐI CÙNG LUÔN LUÔN LÀ MỘT MẢNG JSON, ví dụ: [ { giao dịch 1 }, { giao dịch 2 } ] (ngay cả khi chỉ có 1 giao dịch thì cũng bọc trong mảng [ {...} ]).`;

    let promptParts = [];

    if (base64Image) {
        // OCR hóa đơn từ ảnh Base64
        promptParts.push({ text: 'Hãy đọc ảnh hóa đơn đính kèm và bóc tách dữ liệu.' });

        const hasHeader = base64Image.includes(',');
        const mimeType = hasHeader ? base64Image.split(';')[0].split(':')[1] : 'image/jpeg';
        const cleanBase64 = hasHeader ? base64Image.split(',')[1] : base64Image;

        promptParts.push({ inlineData: { data: cleanBase64, mimeType } });
    } else {
        // Xử lý ghi chú nhanh hoặc giọng nói (STT từ Flutter)
        promptParts.push({ text: `Phân tích câu ghi chép chi tiêu sau: "${rawText.trim()}"` });
    }

    let result = null;
    let responseText = "";
    let lastError = null;
    
    // Yêu cầu của User: Thử 3.5 trước, nếu không được thì hạ xuống 2.5
    const fallbackModels = ['gemini-3.5-flash', 'gemini-2.5-flash'];
    
    for (const modelName of fallbackModels) {
        try {
            const model = genAI.getGenerativeModel({ model: modelName, systemInstruction });
            result = await model.generateContent({
                contents: [{ role: 'user', parts: promptParts }],
                generationConfig: { responseMimeType: 'application/json' } // Ép AI trả về JSON thuần
            });
            responseText = result.response.text();
            console.log(`Bóc tách hóa đơn thành công bằng model: ${modelName}`);
            break; // Thành công thì thoát vòng lặp
        } catch (error) {
            console.error(`[AI Fallback] Lỗi khi dùng model ${modelName}:`, error.message);
            lastError = error;
        }
    }

    // Nếu hết thời gian hoặc cả 3.5 lẫn 2.5 đều xịt
    if (!result) {
        return res.status(500).json({
            success: false,
            message: 'Hệ thống AI hiện đang quá tải hoặc không khả dụng. Vui lòng thử lại sau!',
            error: lastError ? lastError.message : 'Unknown AI error'
        });
    }

    // Dọn dẹp thẻ markdown nếu AI vẫn cố tình sinh ra
    responseText = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
    
    let ocrResultData;
    try {
        ocrResultData = JSON.parse(responseText);
    } catch (e) {
        // Sử dụng vm module để parse các object JS không chuẩn (như thiếu ngoặc kép, thừa phẩy)
        try {
            const vm = require('vm');
            ocrResultData = vm.runInNewContext('(' + responseText + ')');
        } catch (e2) {
            console.error('Lỗi parse JSON từ AI:', responseText);
            return res.status(400).json({
                success: false,
                message: 'AI gặp khó khăn khi phân tích hóa đơn này. Vui lòng chụp rõ hơn hoặc quét lại!'
            });
        }
    }

    // bọc array nếu AI trả về object đơn
    if (!Array.isArray(ocrResultData)) {
        ocrResultData = [ocrResultData];
    }

    if (ocrResultData.length === 0) {
        throw new Error('AI trả về dữ liệu rỗng!');
    }

    // báo lỗi nếu ảnh mờ
    if (ocrResultData[0].isReadable === false) {
        return res.status(400).json({
            success: false,
            message: ocrResultData[0].reason || 'Không thể đọc được ảnh hóa đơn, vui lòng chụp rõ hơn.'
        });
    }

    console.log(`[API] ${req.method} ${req.originalUrl} - Parse transaction success (Method: ${base64Image ? 'OCR' : 'NLP'})`);

    return res.status(200).json({
        success: true,
        message: 'AI bóc tách dữ liệu thành công!',
        data: ocrResultData
    });
});

// Lưu giao dịch và đồng bộ vào kho (MongoDB Session)
exports.addTransaction = asyncHandler(async (req, res) => {
    const {
        userId, transactionType, amount, discount,
        note, date, category, paymentMethod, merchantName, items
    } = req.body;

    // check quyền sở hữu
    if (req.user.userId.toString() !== userId?.toString()) {
        return res.status(403).json({
            success: false,
            message: 'Bạn không thể lưu giao dịch cho tài khoản khác!'
        });
    }

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
            originalQuantity: item.originalQuantity ?? item.quantity, // FIX: Fallback nếu AI không trả về
            unit: item.unit,
            standardQuantity: item.standardQuantity,
            standardUnit: item.standardUnit,
            isSingleUse: item.isSingleUse ?? false, // Gán giá trị AI sinh ra, mặc định false
            purchasePrice: Math.round(item.purchasePrice),
            baseUnitPrice: item.purchasePrice > 0 ? Math.round(item.purchasePrice / ((item.quantity > 0 ? item.quantity : 1) * (item.standardQuantity > 0 ? item.standardQuantity : 1))) : 0,
            expiryDate: calculateExpiryDate(item.category, finalDate), // Dựa vào ngày mua hàng thực tế
            usageStatus: 'ACTIVE'
        }))
        : [];

    // --- ATOMIC TRANSACTION (MongoDB Session) ---
    const session = await mongoose.startSession();
    try {
        session.startTransaction();

        // Bước 1: Tạo bản ghi giao dịch tài chính vào Sổ thu chi
        // Lưu ý: Transaction.create([...]) với session phải truyền mảng
        const [newTransaction] = await Transaction.create([{
            userId,
            transactionType,
            amount: Math.round(amount),       // Khử lỗi float của JS
            discount: Math.round(discount || 0),
            note,
            date: finalDate,
            category,
            paymentMethod,
            merchantName,
            items  // Lưu giỏ hàng nhúng (embedded) vào Transaction để tra cứu nhanh
        }], { session });

        // Bước 2: Bơm các Items sang bảng kho (nếu là giao dịch MARKET)
        if (itemsToInject.length > 0) {
            const itemsWithTxId = itemsToInject.map(item => ({
                ...item,
                transactionId: newTransaction._id // Gắn ID nguồn để Cascade Delete sau này
            }));
            await Item.insertMany(itemsWithTxId, { session });
        }

        await session.commitTransaction();

        console.log(`[API] ${req.method} ${req.originalUrl} - Add transaction success (User: ${userId}, Tx: ${newTransaction._id})`);

        return res.status(201).json({
            success: true,
            message: 'Lưu giao dịch và đồng bộ kho đồ thành công!',
            data: newTransaction
        });
    } catch (err) {
        await session.abortTransaction(); // Rollback: Hủy toàn bộ nếu có lỗi
        throw err; // Chuyển lỗi về errorHandler tập trung xử lý
    } finally {
        session.endSession(); // Luôn đóng session dù thành công hay thất bại
    }
});

// Lấy lịch sử thu chi
exports.getHistory = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { mode, page = 1, limit = 20 } = req.query; // ?mode=compact

    const projection = mode === 'compact' ? { items: 0 } : {};

    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const skip = (pageNum - 1) * limitNum;

    const history = await Transaction.find({ userId }, projection)
        .sort({ date: -1 })
        .skip(skip)
        .limit(limitNum);
        
    const total = await Transaction.countDocuments({ userId });
    const hasMore = skip + history.length < total;

    console.log(`[API] ${req.method} ${req.originalUrl} - Get history success (User: ${userId})`);
    return res.status(200).json({ 
        success: true, 
        count: history.length, 
        total,
        page: pageNum,
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

    const tx = await Transaction.findById(id);
    if (!tx) {
        return res.status(404).json({ success: false, message: 'Không tìm thấy giao dịch cần xóa!' });
    }

    // Kiểm tra quyền sở hữu: Chỉ chủ giao dịch mới được xóa
    if (req.user.userId.toString() !== tx.userId.toString()) {
        return res.status(403).json({
            success: false,
            message: 'Bạn không có quyền xóa giao dịch này!'
        });
    }

    // Cascade Delete: Xóa giao dịch + toàn bộ vật phẩm kho sinh ra từ giao dịch này
    await tx.deleteOne();
    await Item.deleteMany({ transactionId: id });

    console.log(`[API] ${req.method} ${req.originalUrl} - Delete transaction success (User: ${req.user.userId}, Tx: ${id})`);
    return res.status(200).json({
        success: true,
        message: 'Đã xóa giao dịch và giải phóng các vật phẩm liên quan khỏi kho!'
    });
});

// Tự động tính ngày hết hạn theo danh mục và ngày mua thực tế.
function calculateExpiryDate(category, purchaseDate) {
    const base = new Date(purchaseDate);
    base.setHours(23, 59, 59, 999); // Ép về cuối ngày để tính đủ số ngày sinh tồn

    switch (category) {
        case 'MEAT':
        case 'SEAFOOD':
            return new Date(base.setDate(base.getDate() + 3));   // Thịt/Hải sản tươi: 3 ngày
        case 'VEGETABLE':
        case 'EGG':
            return new Date(base.setDate(base.getDate() + 7));   // Rau/Trứng: 7 ngày
        case 'DRINK':
        case 'DRY_FOOD':
            return new Date(base.setDate(base.getDate() + 30));  // Đóng gói/Đồ hộp: 30 ngày
        default:
            return null; // Mỹ phẩm, gia vị, đồ gia dụng - không quản lý hạn
    }
}
