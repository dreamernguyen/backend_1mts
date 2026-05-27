
// 1. Nhập SDK chính thức từ Google AI
const { GoogleGenerativeAI } = require('@google/generative-ai');

// 2. Khởi tạo thực thể cấu hình bằng API Key lấy từ file bảo mật .env
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Định nghĩa mô hình Gemini 2.5 Flash tối ưu hóa cho tác vụ bóc tách thời gian thực
const GEMINI_MODEL = "gemini-3.5-flash";

/**
 * API THỬ NGHIỆM: OCR HÓA ĐƠN HOẶC TEXT VÀ TRẢ KẾT QUẢ ĐỂ DOUBLE CHECK
 * POST: /api/receipt/process
 */
exports.processReceiptOCR = async (req, res) => {
    try {
        const { base64Image, rawText } = req.body;

        // Kiểm tra điều kiện đầu vào tối thiểu cho sandbox test
        if (!base64Image && !rawText) {
            return res.status(400).json({ 
                success: false, 
                message: "Vui lòng truyền lên base64Image (chuỗi ảnh) hoặc rawText (đoạn chữ) để thực hiện thử nghiệm!" 
            });
        }

        // 3. Khởi tạo System Instruction: Ép vai trò và định dạng JSON nghiêm ngặt cho AI
        const systemInstruction = `
        Bạn là hệ thống xử lý và bóc tách dữ liệu hóa đơn thông minh của ứng dụng "Một mình tôi sống" (1MTS).
        Nhiệm vụ của bạn là phân tích ảnh chụp hóa đơn (OCR) hoặc một câu ghi chép chi tiêu nhanh (NLP).
        Hãy xử lý dữ liệu và trả về kết quả dưới dạng một cấu trúc JSON duy nhất khớp 100% với định dạng sau:
        {
            "merchantName": "Tên siêu thị, cửa hàng hoặc loại hình hoạt động chi tiêu (Ví dụ: 'WinMart', 'Do Xang', 'An Sang Pho')",
            "totalAmount": Tổng số tiền thanh toán thực tế (Kiểu số - Number),
            "items": [
                {
                    "rawName": "Chỉ lấy tên mặt hàng và thương hiệu ghi trên hóa đơn loại bỏ các từ liên quan đến định lượng, hoặc cách đóng gói, sơ chế. Ngoại lệ là với đồ hộp đóng gói",
                    "itemName": "Tên nguyên liệu sạch, viết thường, không dấu phục vụ so khớp nấu ăn (Ví dụ: 'thit heo', 'trung ga', 'rau muong')",
                    "price": Giá tiền của mặt hàng đó (Kiểu số - Number),
                    "quantity": Số lượng định lượng sau khi quy đổi (Kiểu số - Number),
                    "originalQuantity": Định lượng hoặc dung tích ban đầu ghi trên bao bì (Kiểu số - Number),
                    "unit": "Đơn vị đo lường cơ bản (Ví dụ: 'g', 'ml', 'qua', 'cai')"
                    "category": "Phân loại thuộc một trong các nhóm sau: MEAT | SEAFOOD | VEGETABLE | FRUIT | DAIRY | EGG | DRINK | OTHERS",
                    "canAddToPantry": true nếu đây là thực phẩm cần bảo quản trong tủ lạnh, false nếu là đồ dùng ngay hoặc đồ gia dụng,
                    "expiryDays": Số ngày bảo quản tươi ngon dự kiến kể từ hôm nay (Thịt sống: 3, Rau quả: 5, Trứng: 14, còn lại để null)"
                }
            ]
        }
        Cảnh báo bảo mật: Tuyệt đối chỉ trả về chuỗi JSON thô, không bọc trong ký hiệu markdown (\`\`\`json), không giải thích gì thêm ngoài lề.`;

        // 4. Khởi tạo Model sử dụng cấu hình SDK chính chủ
        const model = genAI.getGenerativeModel({ 
            model: GEMINI_MODEL,
            systemInstruction: systemInstruction 
        });

        // 5. Đóng gói tham số truyền đi (Content Parts)
        let promptParts = [];
        
        if (base64Image) {
            // Định dạng đệm ảnh Base64 chuẩn quy định của SDK
            promptParts.push({ text: "Hãy đọc hiểu hình ảnh hóa đơn đính kèm này và bóc tách dữ liệu." });
            promptParts.push({
                inlineData: {
                    data: base64Image,
                    mimeType: "image/png" // Thiết lập mặc định là định dạng ảnh PNG
                }
            });
        } else {
            // Định dạng truyền văn bản NLP thô
            promptParts.push({ text: `Hãy phân tích cú pháp câu ghi chép chi tiêu sau: "${rawText}"` });
        }

        // 6. Thực hiện cuộc gọi bất đồng bộ lên máy chủ Google AI Studio thông qua SDK
        const result = await model.generateContent({
            contents: [{ role: "user", parts: promptParts }],
            // Kích hoạt tính năng ép khuôn cứng định dạng JSON đầu ra trên SDK
            generationConfig: { responseMimeType: "application/json" }
        });

        // 7. Giải mã chuỗi text kết quả thông qua hàm hỗ trợ an toàn `.text()` của SDK
        const aiResponseText = result.response.text();
        
        // Chuyển đổi chuỗi văn bản nhận được thành đối tượng Javascript Object
        const ocrResultData = JSON.parse(aiResponseText);

        lastOcrResult = {
            timestamp: new Date().toISOString(),
            inputMethod: base64Image ? "IMAGE (Base64)" : "TEXT (Ghi chép nhanh)",
            extractedData: ocrResultData
        };

        // 2. In trực tiếp kết quả đẹp đẽ ra màn hình Terminal Node.js (console.log)
        console.log(`\n======================================================`);
        console.log(`🔔 [1MTS TEST LAB] PHÁT HIỆN YÊU CẦU BÓC TÁCH MỚI!`);
        console.log(`⏱️ Thời gian: ${lastOcrResult.timestamp}`);
        console.log(`📡 Phương thức: ${lastOcrResult.inputMethod}`);
        console.log(`------------------------------------------------------`);
        console.log(JSON.stringify(ocrResultData, null, 4)); // In thụt lề 4 khoảng trắng cực kỳ dễ nhìn
        console.log(`======================================================\n`);



        // 8. Trả kết quả trực tiếp về cho Client để tiến hành hiển thị Double-Check
        return res.status(200).json({
            success: true,
            message: "SDK bóc tách dữ liệu thành công!",
            extractedData: ocrResultData
        });

    } catch (error) {
        console.error(`[Gemini SDK OCR Error]: ${error.message}`);
        return res.status(500).json({
            success: false,
            message: "Gặp lỗi trong quá trình xử lý bóc tách bằng Gemini SDK!",
            error: error.message
        });
    }
};

