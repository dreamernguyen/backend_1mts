const mongoose = require('mongoose');

const ingredientSchema = new mongoose.Schema({
    itemName: { type: String, required: true },
    amount: { type: Number, required: true },
    unit: { type: String, required: true }, // G, ML, PIECE, NONE
    displayQuantity: { type: String, required: true },
    isCore: { type: Boolean, default: false }
}, { _id: false });

const stepSchema = new mongoose.Schema({
    order: { type: Number, required: true },
    instruction: { type: String, required: true }
}, { _id: false });

const recipeSchema = new mongoose.Schema(
    {
        recipeId: { type: String, unique: true }, // Mapped from "id" in JSON
        title: {
            type: String,
            required: [true, 'Tên công thức nấu ăn là bắt buộc!'],
            trim: true
        },
        description: { type: String, trim: true },
        sourceUrl: { type: String, trim: true },
        imageUrl: { type: String, trim: true },
        mealType: {
            type: String,
            enum: ['BREAKFAST', 'LUNCH', 'DINNER', 'SNACK'],
            default: 'LUNCH'
        },
        difficulty: {
            type: String,
            enum: ['EASY', 'MEDIUM', 'HARD'],
            default: 'MEDIUM'
        },
        prepTime: { type: Number, default: 15 },
        cookTime: { type: Number, default: 15 },
        servings: { type: Number, default: 1 },
        estimatedCost: { type: Number, default: 0 },
        nutrition: {
            calories: { type: Number, default: 0 },
            protein: { type: Number, default: 0 },
            carbs: { type: Number, default: 0 },
            fat: { type: Number, default: 0 }
        },
        tags: [{ type: String, uppercase: true, trim: true }],
        mealComponentType: {
            type: String,
            enum: ['MAIN_COURSE', 'SIDE_DISH', 'SOUP', 'DESSERT', 'DRINK'],
            default: 'MAIN_COURSE'
        },
        steps: [stepSchema],
        ingredients: [ingredientSchema],
        
        // Trường lưu trữ Vector nhúng cho MongoDB Atlas Vector Search
        embeddingVector: {
            type: [Number],
            select: false // Mặc định không query trường này ra để giảm tải băng thông
        }
    },
    {
        timestamps: true
    }
);

// Đánh chỉ mục Text Search dự phòng cho các trường hợp không dùng Vector Search
recipeSchema.index({ title: 'text', tags: 'text' });

const Recipe = mongoose.model('Recipe', recipeSchema);
module.exports = Recipe;