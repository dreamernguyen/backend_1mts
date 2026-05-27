const mongoose = require('mongoose');

const recipeSchema = new mongoose.Schema(
    {
        title: {
            type: String,
            required: [true, 'Tên công thức nấu ăn là bắt buộc!'],
            trim: true,
            unique: true
        },
        description: {
            type: String,
            trim: true
        },
        // Mảng tên nguyên liệu chuẩn hóa dạng chữ thường để so khớp chuỗi (ví dụ: ["thịt heo", "cà chua"])
        ingredients: [
            {
                type: String,
                lowercase: true,
                trim: true
            }
        ],
        steps: [
            {
                type: String,
                trim: true
            }
        ],
        cookingTime: {
            type: Number, // Đơn vị: Phút
            default: 15
        },
        // Thông tin dinh dưỡng phục vụ bộ lọc cá nhân hóa của sinh viên
        nutrition: {
            calories: { type: Number, default: 0 }, // kcal
            protein: { type: Number, default: 0 },  // g
            carbs: { type: Number, default: 0 },    // g
            fat: { type: Number, default: 0 }       // g
        },
        // Ước lượng tổng chi phí thực tế để sinh viên cân đối ví tiền (Đơn vị: VNĐ)
        estimatedCost: {
            type: Number,
            default: 0
        },
        // Thẻ phân loại phục vụ tìm kiếm nhanh (ví dụ: "VEGAN" - Ăn chay, "DIET" - Giảm cân, "EASY" - Dễ làm)
        tags: [
            {
                type: String,
                uppercase: true,
                trim: true
            }
        ]
    },
    {
        timestamps: true
    }
);

// Đánh chỉ mục text trên mảng nguyên liệu và tiêu đề để tăng tốc độ so khớp chuỗi lên mức tối đa
recipeSchema.index({ ingredients: 1 });
recipeSchema.index({ tags: 1 });

const Recipe = mongoose.model('Recipe', recipeSchema);
module.exports = Recipe;