'use strict';

// Few-shot chỉ định dạng đầu ra và nguyên tắc bám context. Ví dụ không phải
// nguồn dữ liệu để AI suy diễn thêm nguyên liệu hay số lượng cho người dùng.
const RECIPE_RAG_PROMPT_VERSION = 'recipe-rag-v1-fewshot';

const RECIPE_RAG_FEW_SHOT_EXAMPLES = Object.freeze([
    {
        userIntent: 'Món nhanh từ thịt gà và rau, ưu tiên đồ sắp hết hạn.',
        expected: {
            mode: 'ADAPT_EXISTING',
            baseRecipeIds: ['CT_101'],
            reasoning: 'Điều chỉnh công thức CT_101 để ưu tiên rau có hạn dùng gần nhất trong inventory.',
            recipe: {
                title: 'Gà xào rau',
                description: 'Món xào nhanh dựa trên công thức tham chiếu.',
                dishType: 'MAIN',
                cookingTimeMinutes: 20,
                baseServings: 1,
                ingredients: [
                    { name: 'ức gà', amount: 150, unit: 'G', required: true },
                    { name: 'cải thìa', amount: 120, unit: 'G', required: true }
                ],
                steps: ['Sơ chế nguyên liệu.', 'Xào gà chín tới rồi cho rau vào.']
            }
        }
    },
    {
        userIntent: 'Muốn nấu món từ kho hiện tại nhưng thiếu nguyên liệu chính.',
        expected: {
            mode: 'NEED_SHOPPING',
            baseRecipeIds: ['CT_205'],
            reasoning: 'Công thức tham chiếu cần một nguyên liệu bắt buộc không có trong inventory; không tạo công thức giả định là đủ.',
            recipe: null
        }
    }
]);

module.exports = {
    RECIPE_RAG_PROMPT_VERSION,
    RECIPE_RAG_FEW_SHOT_EXAMPLES
};
