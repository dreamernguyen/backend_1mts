const { GoogleGenerativeAI, TaskType } = require('@google/generative-ai');
const { AI_PORTION_RULES } = require('../config/recipe-portion.rules');

// Khởi tạo SDK Google Generative AI bằng API Key lấy từ cấu hình môi trường (.env)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

const formatAiError = (error, defaultPrefix) => {
    const msg = error.message || String(error);
    if (msg.includes('429') || msg.includes('quota') || msg.toLowerCase().includes('too many requests')) {
        return "Gói dùng Free nên AI hạn chế request vui lòng thử lại sau";
    }
    return defaultPrefix + msg;
};

// Danh sách các model AI được ưu tiên sử dụng theo thứ tự.
// Nếu model đầu tiên (gemini-3.5-flash-lite) gặp lỗi 429 hoặc quá tải,
// hệ thống sẽ tự động chuyển sang dùng model tiếp theo (gemini-3.1-flash-lite).
const FALLBACK_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];

/**
 * Hàm trung tâm (Core Wrapper) xử lý mọi luồng gọi AI trong ứng dụng.
 * Tích hợp sẵn cơ chế:
 * - Model Fallback: Tự động đổi sang model dự phòng nếu model chính lỗi.
 * - Retry cơ bản: Nếu tất cả các model dự phòng đều lỗi, tự động chờ (delay) và thử lại.
 * - Timeout: Ngắt kết nối nếu AI xử lý quá thời gian cho phép (tránh treo hệ thống).
 * - Metadata Tracking: Thu thập lượng Token tiêu thụ (prompt, response) để phục vụ báo cáo đo lường AI.
 */
const executeWithFallback = async ({
    systemInstruction,
    promptParts,
    generationConfig,
    timeoutMs,
    retries = 0,
    delayMs = 1000,
    requestId = 'unknown',
    contextName = 'AI Service'
}) => {
    let lastError = null;
    let currentDelay = delayMs;
    
    for (let r = 0; r <= retries; r++) {
        const startedAt = Date.now();
        for (const modelName of FALLBACK_MODELS) {
            try {
                const model = genAI.getGenerativeModel({ model: modelName, systemInstruction });
                const request = model.generateContent({
                    contents: [{ role: 'user', parts: promptParts }],
                    ...(generationConfig && { generationConfig })
                });

                let result;
                if (timeoutMs) {
                    result = await Promise.race([
                        request,
                        new Promise((_, reject) => setTimeout(() => {
                            const error = new Error(`Quá thời gian chờ ${timeoutMs}ms`);
                            error.code = 'AI_TIMEOUT';
                            reject(error);
                        }, timeoutMs))
                    ]);
                } else {
                    result = await request;
                }
                
                const response = result.response;
                const finishReason = response.candidates?.[0]?.finishReason ?? null;
                if (finishReason === 'MAX_TOKENS') {
                    const truncatedError = new Error('Gemini dừng với finishReason=MAX_TOKENS trước khi hoàn tất.');
                    truncatedError.code = 'GEMINI_FINISH_MAX_TOKENS';
                    truncatedError.statusCode = 502;
                    throw truncatedError;
                }

                return {
                    text: response.text(),
                    metadata: {
                        requestId, 
                        model: modelName,
                        durationMs: Date.now() - startedAt,
                        finishReason,
                        ...readUsageMetadata(response)
                    },
                    response
                };
            } catch (error) {
                lastError = error.statusCode ? error : wrapGeminiApiError(error);
                console.warn(`[${contextName}] Model ${modelName} lỗi: ${lastError.message}`);
            }
        }
        
        if (r < retries) {
            console.warn(`[${contextName}] Tất cả model đều lỗi, chờ ${currentDelay}ms rồi thử lại (Lần ${r + 1}/${retries})...`);
            await new Promise(resolve => setTimeout(resolve, currentDelay));
            currentDelay *= 2;
        }
    }
    throw lastError || wrapGeminiApiError(new Error(`[${contextName}] Thất bại sau khi thử tất cả model.`));
};

// Cấu hình yêu cầu Gemini trả về JSON thuần túy (không dùng schema cứng để tránh lỗi MAX_TOKENS sớnm)
const buildReceiptGenerationConfig = () => ({
    responseMimeType: 'application/json'
});

// Đọc thông tin Token tiêu thụ từ response Gemini (phục vụ đo lường AI)
const readUsageMetadata = response => ({
    promptTokenCount: response.usageMetadata?.promptTokenCount ?? null,
    candidatesTokenCount: response.usageMetadata?.candidatesTokenCount ?? null,
    totalTokenCount: response.usageMetadata?.totalTokenCount ?? null
});

// Chuẩn hóa lỗi từ Gemini API thành dạng lỗi nội bộ có statusCode để Express có thể xử lý
const wrapGeminiApiError = error => {
    const apiStatus = Number(error?.status);
    const hasHttpStatus = Number.isInteger(apiStatus) && apiStatus >= 400 && apiStatus <= 599;
    const wrapped = new Error(error?.message || 'Gemini API trả về lỗi không có message.');
    wrapped.code = error?.code || (hasHttpStatus ? `GEMINI_HTTP_${apiStatus}` : 'GEMINI_API_ERROR');
    wrapped.statusCode = hasHttpStatus ? apiStatus : 502;
    wrapped.apiStatus = hasHttpStatus ? apiStatus : null;
    wrapped.apiStatusText = error?.statusText || null;
    wrapped.errorDetails = error?.errorDetails || null;
    wrapped.cause = error;
    return wrapped;
};

exports.buildReceiptGenerationConfig = buildReceiptGenerationConfig;

// Tính năng 1: Gửi ảnh và trích xuất dữ liệu Hóa đơn / Chỉ số công tơ điện nước.
// Được thiết kế chuyên biệt để gọi OCR, chỉ trả về JSON, không áp dụng logic timeout quá gắt.
exports.generateStructuredReceipt = async ({
    systemInstruction,
    promptParts,
    requestId = 'unknown',
    inputMode = 'unknown'
}) => {
    try {
        const result = await executeWithFallback({
            systemInstruction,
            promptParts,
            generationConfig: buildReceiptGenerationConfig(),
            requestId,
            contextName: 'Receipt AI'
        });
        console.info('[Receipt AI]', { inputMode, ...result.metadata });
        return { text: result.text, metadata: { inputMode, ...result.metadata } };
    } catch (error) {
        console.warn('[Receipt AI error]', { requestId, inputMode, code: error.code, message: error.message });
        throw error;
    }
};

// Tính năng 2: Đưa ra lời khuyên tài chính (Ví dụ: Đánh giá chi tiêu trong tháng).
// Chỉ phân tích số liệu (snapshot) do Backend tính sẵn truyền vào prompt.
// Có áp dụng Timeout (8 giây) để nếu AI chậm, người dùng không phải đợi màn hình loading quá lâu.
exports.generateStructuredFinanceInsight = async ({ systemInstruction, prompt, requestId = 'unknown' }) => {
    if (!process.env.GEMINI_API_KEY) {
        const error = new Error('Gemini chưa được cấu hình.');
        error.code = 'GEMINI_NOT_CONFIGURED';
        throw error;
    }
    const result = await executeWithFallback({
        systemInstruction,
        promptParts: [{ text: prompt }],
        generationConfig: buildReceiptGenerationConfig(),
        timeoutMs: 8000,
        requestId,
        contextName: 'Finance AI'
    });
    return { text: result.text, metadata: result.metadata };
};

// Tính năng 3: Phân tích chỉ số Sinh tồn (RPG Stats - HP, Mana, DEF, WIS).
// Tương tự tính năng tài chính, chỉ dùng AI để giải thích số liệu chứ không để AI tự tính điểm.
exports.generateStructuredSurvivalInsight = exports.generateStructuredFinanceInsight;

exports.generateGeneralAdvice = async (systemInstruction, promptText) => {
    try {
        const result = await executeWithFallback({
            systemInstruction,
            promptParts: [{ text: promptText }],
            timeoutMs: 8000,
            contextName: 'General Advice'
        });
        return result.text;
    } catch (error) {
        console.error("Error generating general advice:", error);
        return formatAiError(error, "Xin lỗi, không thể đưa ra lời khuyên: ");
    }
};

const RECIPE_EMBEDDING_DIMENSIONS = 768;

function normalizeEmbedding(values, dimensions = RECIPE_EMBEDDING_DIMENSIONS) {
    if (!Array.isArray(values) || values.length < dimensions) {
        throw new Error(`Embedding phải có ít nhất ${dimensions} chiều.`);
    }
    const vector = values.slice(0, dimensions).map(Number);
    if (vector.some(value => !Number.isFinite(value))) {
        throw new Error('Embedding chứa giá trị không hợp lệ.');
    }
    const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (!Number.isFinite(magnitude) || magnitude === 0) {
        throw new Error('Embedding có độ lớn bằng 0.');
    }
    return vector.map(value => value / magnitude);
}

exports.embedText = async (text, {
    taskType = TaskType.RETRIEVAL_QUERY,
    title
} = {}) => {
    if (!process.env.GEMINI_API_KEY) {
        const error = new Error('Thiếu GEMINI_API_KEY; không thể tạo embedding thật.');
        error.code = 'RECIPE_EMBEDDING_NOT_CONFIGURED';
        throw error;
    }
    const input = String(text || '').trim();
    if (!input) throw new Error('Nội dung embedding không được để trống.');
    try {
        const model = genAI.getGenerativeModel({ model: 'gemini-embedding-001' });
        const result = await model.embedContent({
            content: { parts: [{ text: input }] },
            taskType,
            ...(title ? { title: String(title).trim() } : {})
        });
        return normalizeEmbedding(result.embedding.values);
    } catch (error) {
        console.error('Error embedding text:', error.message);
        throw error;
    }
};

exports.RECIPE_EMBEDDING_DIMENSIONS = RECIPE_EMBEDDING_DIMENSIONS;
exports.RECIPE_EMBEDDING_MODEL = 'gemini-embedding-001';
exports.normalizeEmbedding = normalizeEmbedding;

// Tính năng 4: So sánh Tủ lạnh và Công thức nấu ăn để tìm ra "Nguyên liệu còn thiếu".
// Phân loại thiếu nguyên liệu chính (core) và nguyên liệu phụ (extra).
exports.analyzeMissingIngredients = async (recipe, fridgeItems) => {
    try {
        const prompt = `
Bạn là một trợ lý thông minh phân tích nguyên liệu nấu ăn.
Tôi có một công thức nấu ăn và danh sách nguyên liệu tôi đang có trong tủ lạnh.
Hãy so sánh chúng và cho tôi biết tôi đang thiếu những gì.
Lưu ý: 
- NGUYÊN TẮC THAY THẾ: Nếu công thức yêu cầu nguyên liệu chung chung (VD: "thịt gà", "thịt heo"), bạn CÓ THỂ dùng các bộ phận cụ thể trong tủ lạnh để đáp ứng (VD: tủ có "đùi gà" thì được coi là có "thịt gà").
- CỰC KỲ KHẮT KHE BỘ PHẬN: Nếu công thức yêu cầu RÕ RÀNG một bộ phận đặc thù (VD: "cánh gà", "ức gà", "sườn non", "thịt ba rọi"), thì tủ lạnh PHẢI CÓ ĐÚNG bộ phận đó hoặc thứ tương đương. Nếu tủ lạnh chỉ có "đùi gà", "má đùi gà" hoặc "thịt heo xay", hãy coi nguyên liệu đó là CÒN THIẾU.
- Không gộp chung toàn bộ con vật nếu công thức yêu cầu cụ thể.
- Tủ lạnh có cung cấp thông tin "Phân loại (subCategory)", hãy dựa vào đó để hỗ trợ nhận diện, nhưng vẫn phải tuân thủ quy tắc khắt khe trên.
- Dựa vào trường 'isCore' của công thức. Thiếu đồ isCore = true thì để vào mảng 'missingCore'. Thiếu đồ isCore = false thì để vào mảng 'missingExtra'.

Công thức nấu ăn:
Tên món: ${recipe.title}
Nguyên liệu yêu cầu:
${JSON.stringify(recipe.ingredients, null, 2)}

Tủ lạnh hiện có:
${JSON.stringify(fridgeItems.map(i => i.itemName + ' (Loại: ' + i.subCategory + ', ' + i.quantity + ' ' + i.unit + ')'), null, 2)}

Hãy trả về CHỈ 1 object JSON hợp lệ với định dạng:
{
  "missingCore": [ { "itemName": "Tên nguyên liệu giống hệt trong công thức gốc", "amount": 100, "unit": "G", "displayQuantity": "Số lượng" } ],
  "missingExtra": [ { "itemName": "Tên nguyên liệu giống hệt trong công thức gốc", "amount": 100, "unit": "G", "displayQuantity": "Số lượng" } ]
}
`;
        const result = await executeWithFallback({
            promptParts: [{ text: prompt }],
            retries: 2,
            contextName: 'Missing Ingredients'
        });
        const responseText = result.text.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(responseText);
    } catch (error) {
        console.error("Error analyzing missing ingredients:", error);
        throw new Error(formatAiError(error, "Lỗi khi gọi AI phân tích nguyên liệu: "));
    }
};

// Tính năng 5: Đề xuất món ăn "Dọn tủ lạnh".
// Thuật toán: Dựa trên kho thực phẩm sắp hết hạn, chọn 1 món từ cơ sở dữ liệu.
// Nếu không tìm được món phù hợp, AI sẽ TỰ SÁNG TẠO 1 món hoàn toàn mới.
exports.decideFridgeClearingRecipe = async (topRecipes, fridgeItems) => {
    try {
        const prompt = `
Bạn là đầu bếp AI xuất sắc.
Nhiệm vụ của bạn là giúp người dùng "dọn tủ lạnh" bằng cách chọn 1 món ăn từ danh sách 15 món đề xuất dưới đây, HOẶC tự chế một món mới nếu 15 món kia đều bắt người dùng đi mua thêm đồ chính.

Tủ lạnh của user (Ưu tiên dùng đồ sắp hết hạn):
${JSON.stringify(fridgeItems.map(i => ({ name: i.itemName, qty: i.quantity + ' ' + i.unit, daysToExpiry: Math.ceil((new Date(i.expiryDate) - new Date()) / (1000 * 60 * 60 * 24)) })), null, 2)}

Top 15 công thức tham khảo:
${JSON.stringify(topRecipes.map(r => ({ recipeId: r.recipeId, title: r.title, ingredients: r.ingredients })), null, 2)}

Quy tắc:
1. Duyệt 15 công thức. Lọc ra công thức mà Tủ lạnh đáp ứng đủ 100% nguyên liệu isCore:true và đủ lượng cho ít nhất 1 người ăn.
2. Nếu có công thức thỏa mãn, chọn công thức tốt nhất (ưu tiên dùng nhiều đồ sắp hết hạn).
3. Nếu KHÔNG CÓ công thức nào thỏa mãn (tức là món nào cũng thiếu đồ isCore:true), BẠN HÃY TỰ SÁNG TẠO 1 công thức mới 100% chỉ dùng những đồ đang có trong tủ lạnh.
NẾU quyết định tạo công thức mới (customRecipe), trả về ĐẦY ĐỦ json theo định dạng RecipeModel (với recipeId tự sinh dạng CUSTOM_xxx).

Trở thành 1 JSON chuẩn xác như sau:
{
  "isFromDatabase": boolean, // true nếu bạn chọn 1 món từ 15 món cung cấp, false nếu bạn phải tự phát minh
  "recipeId": "ID của công thức",
  "reasoning": "Giải thích tại sao",
  "customRecipe": {
    "title": "Tên món tự chế",
    "mealType": "LUNCH",
    "difficulty": "MEDIUM",
    "prepTime": 15,
    "cookTime": 20,
    "servings": 2,
    "nutrition": { "calories": 500, "protein": 20, "carbs": 30, "fat": 15 },
    "ingredients": [
      {
        "itemName": "Tên món",
        "amount": 100,
        "unit": "G",
        "displayQuantity": "100g",
        "isCore": true
      }
    ],
    "steps": [
      {
        "order": 1,
        "instruction": "Làm gì đó..."
      }
    ]
  }
}
LƯU Ý QUAN TRỌNG: NẾU BẠN CHỌN TỪ DB (isFromDatabase=true), customRecipe để trống (null). NẾU TỰ CHẾ (isFromDatabase=false), ĐẢM BẢO customRecipe CÓ ĐỦ DỮ LIỆU ĐỂ LƯU VÀO DATABASE BÊN DƯỚI.
`;
        const result = await executeWithFallback({
            promptParts: [{ text: prompt }],
            retries: 2,
            contextName: 'Fridge Clearing'
        });
        const responseText = result.text.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(responseText);
    } catch (error) {
        console.error("Error deciding fridge clearing recipe:", error);
        throw new Error(formatAiError(error, "Lỗi khi gọi AI đề xuất món ăn: "));
    }
};

// Tính năng 6: Bếp trưởng AI (Tư vấn Bữa ăn Thông minh - Kiến trúc Hybrid).
// Kết hợp giữa quy tắc cứng (Rule-based) và AI Semantic.
// Bắt buộc AI tuân thủ các quy tắc tận dụng đồ ăn thừa và tránh lãng phí thực phẩm.
exports.consultHeadChefAI = async (report) => {
    try {
        const prompt = `
Bạn là Bếp trưởng sinh tồn chuyên nghiệp. Dưới đây là Báo cáo kho đồ ăn của người dùng:
- Đồ ăn chín đang cất tủ: [${report.cookedLeftovers.join(', ')}]
- Đồ tươi SẮP HỎNG cần cứu gấp: [${report.criticalRaw.join(', ')}]
- Đồ tươi còn tốt: [${report.goodRaw.join(', ')}]
- Gia vị sẵn có: [${report.spices.join(', ')}]

Dựa trên nguyên tắc ưu tiên dọn tủ, hãy ra quyết định chọn món. Luôn cố gắng giúp người dùng có một bữa ăn ngon nhất.
Luật lệ BẮT BUỘC:
0. Chỉ dùng nguyên liệu xuất hiện trong báo cáo. Tuyệt đối không đề xuất nấu hoặc ăn thực phẩm đã hết hạn.
1. NẾU CÓ Đồ ăn chín sắp hỏng: Bắt buộc khuyên người dùng hâm nóng ăn lại.
2. Nếu Đồ ăn chín là món MẶN, và đồ tươi có rau/thịt hợp lý: Khuyên nấu thêm món CANH/XÀO để ăn kèm (Phối hợp món). KHÔNG khuyên canh ăn với canh.
3. Nếu KHÔNG CÓ Đồ ăn chín: Ưu tiên dùng các "Đồ tươi SẮP HỎNG" để sáng tạo món ăn mới.
4. Món ăn tự sáng tạo phải cực kỳ chi tiết, dùng được nguyên liệu đang có. Bạn có thể châm chước nguyên liệu thiếu nếu là gia vị phụ.

Bạn PHẢI trả về CHỈ 1 object JSON hợp lệ với định dạng sau:
{
  "type": "LOAI_KICH_BAN", // CHỈ ĐƯỢC CHỌN 1 TRONG 3: "LEFTOVER_ONLY", "MIXED_MEAL", "NEW_RECIPE"
  "reasoning": "Giải thích tại sao bạn chọn quyết định này (Ví dụ: Bạn đang có thịt kho, nên nấu thêm canh chua...)",
  // CHỈ ĐIỀN "customRecipe" NẾU "type" LÀ "MIXED_MEAL" hoặc "NEW_RECIPE":
  "customRecipe": {
    "title": "Tên món nấu thêm (Canh / Xào / Mới hoàn toàn)",
    "description": "Mô tả ngắn",
    "dishType": "MAIN",
    "cookingTimeMinutes": 25,
    "baseServings": 2,
    "ingredients": [
      {
        "name": "Tên nguyên liệu chuẩn, không có thương hiệu",
        "amount": 300,
        "unit": "G",
        "required": true
      }
    ],
    "steps": ["Bước nấu ngắn gọn, tối đa hai câu"],
    "tags": []
  }
}
Lưu ý: Nếu type="LEFTOVER_ONLY", "customRecipe" để là null. 
NẾU tạo customRecipe, chỉ dùng unit G, KG, ML, L hoặc PIECE; tối đa 10 bước và phải có ít nhất một nguyên liệu required=true.
${AI_PORTION_RULES}
`;
        const result = await executeWithFallback({
            promptParts: [{ text: prompt }],
            retries: 2,
            contextName: 'Chef AI'
        });
        const responseText = result.text.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(responseText);
    } catch (error) {
        console.error("Error consulting chef AI:", error);
        throw new Error(formatAiError(error, "Lỗi khi tư vấn món ăn: "));
    }
};
