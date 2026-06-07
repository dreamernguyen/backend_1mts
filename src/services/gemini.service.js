const { GoogleGenerativeAI } = require('@google/generative-ai');

// Initialize Gemini API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

const formatAiError = (error, defaultPrefix) => {
    const msg = error.message || String(error);
    if (msg.includes('429') || msg.includes('quota') || msg.toLowerCase().includes('too many requests')) {
        return "Gói dùng Free nên AI hạn chế request vui lòng thử lại sau";
    }
    return defaultPrefix + msg;
};

// Thực hiện Retry với Exponential Backoff và Model Fallback (3.5 -> 2.5)
const withRetryAndFallback = async (prompt, retries = 3, delayMs = 1000) => {
    try {
        const model35 = genAI.getGenerativeModel({ model: "gemini-3.5-flash" });
        return await model35.generateContent(prompt);
    } catch (error35) {
        console.warn(`[AI Service] gemini-3.5-flash lỗi: ${error35.message}. Thử lại với gemini-2.5-flash...`);
        try {
            const model25 = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
            return await model25.generateContent(prompt);
        } catch (error25) {
            if (retries <= 1) throw error25;
            console.warn(`[AI Service] Cả 2 model đều lỗi, thử lại sau ${delayMs}ms... (Còn ${retries - 1} lần)`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
            return withRetryAndFallback(prompt, retries - 1, delayMs * 2);
        }
    }
};

// Tạo text embedding cho MongoDB Vector Search
exports.embedText = async (text) => {
    if (!process.env.GEMINI_API_KEY) {
        console.warn('GEMINI_API_KEY is not set. Returning dummy vector.');
        return new Array(768).fill(0.01);
    }
    try {
        const model = genAI.getGenerativeModel({ 
            model: "gemini-embedding-001" 
        });
        
        // Thêm cấu hình ép kích thước vector ngay trong lệnh gọi API thay vì dùng slice ở mảng trả về
        const result = await model.embedContent({
            content: { parts: [{ text }] },
            outputDimensionality: 768
        });
        
        return result.embedding.values;
    } catch (error) {
        console.error("Error embedding text:", error);
        throw error;
    }
};

// Phân tích nguyên liệu còn thiếu cho công thức nấu ăn
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
        const result = await withRetryAndFallback(prompt);
        const responseText = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(responseText);
    } catch (error) {
        console.error("Error analyzing missing ingredients:", error);
        throw new Error(formatAiError(error, "Lỗi khi gọi AI phân tích nguyên liệu: "));
    }
};

// Chọn hoặc sáng tạo công thức dọn tủ lạnh
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
        return await withRetry(async () => {
            const result = await model.generateContent(prompt);
            const responseText = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
            return JSON.parse(responseText);
        });
    } catch (error) {
        console.error("Error deciding fridge clearing recipe:", error);
        throw new Error(formatAiError(error, "Lỗi khi gọi AI đề xuất món ăn: "));
    }
};

// Tư vấn "Hôm nay ăn gì" dựa trên Báo cáo Tủ lạnh (Kiến trúc Hybrid)
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
    "mealType": "LUNCH",
    "difficulty": "MEDIUM",
    "prepTime": 10,
    "cookTime": 15,
    "servings": 1,
    "nutrition": { "calories": 400, "protein": 20, "carbs": 10, "fat": 10 },
    "ingredients": [
      {
        "itemName": "Tên",
        "amount": 100,
        "unit": "G",
        "displayQuantity": "100g",
        "isCore": true
      }
    ],
    "steps": [
      {
        "order": 1,
        "instruction": "Làm gì..."
      }
    ]
  }
}
Lưu ý: Nếu type="LEFTOVER_ONLY", "customRecipe" để là null. 
NẾU tạo customRecipe, ĐẢM BẢO trả về đủ các trường yêu cầu.
`;
        const result = await withRetryAndFallback(prompt);
        const responseText = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(responseText);
    } catch (error) {
        console.error("Error consulting chef AI:", error);
        throw new Error(formatAiError(error, "Lỗi khi tư vấn món ăn: "));
    }
};
