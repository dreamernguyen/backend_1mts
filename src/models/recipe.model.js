const mongoose = require('mongoose');

const STANDARD_UNITS = ['G', 'KG', 'ML', 'L', 'PIECE'];
const DISH_ROLES = ['MAIN', 'SIDE', 'DRINK', 'DESSERT', 'SNACK'];
const LEGACY_COMPONENT_BY_DISH_ROLE = {
    MAIN: 'MAIN_COURSE',
    SIDE: 'SIDE_DISH',
    DRINK: 'DRINK',
    DESSERT: 'DESSERT',
    SNACK: 'SIDE_DISH'
};
const DISH_ROLE_BY_LEGACY_COMPONENT = {
    MAIN_COURSE: 'MAIN',
    SIDE_DISH: 'SIDE',
    SOUP: 'SIDE',
    DESSERT: 'DESSERT',
    DRINK: 'DRINK'
};

const substitutionSchema = new mongoose.Schema({
    canonicalName: { type: String, required: true, trim: true },
    amountFactor: { type: Number, min: 0.01, default: 1 },
    note: { type: String, trim: true, default: '' }
}, { _id: false });

const ingredientSchema = new mongoose.Schema({
    name: { type: String, trim: true, default: '' },
    required: { type: Boolean, default: null },
    // Đọc tương thích dữ liệu cũ trong thời gian import bộ recipe schema gọn.
    itemName: { type: String, default: '' },
    rawName: { type: String, trim: true, default: '' },
    canonicalName: { type: String, trim: true, default: '' },
    amount: { type: Number, required: true, min: 0 },
    unit: { type: String, required: true, enum: ['G', 'KG', 'ML', 'L', 'PIECE', 'NONE'] },
    displayQuantity: { type: String, default: '' },
    isCore: { type: Boolean, default: null },
    scalingMode: {
        type: String,
        enum: ['PROPORTIONAL', 'WHOLE_UNIT', 'FIXED_MINIMUM', 'NON_SCALABLE'],
        default: 'PROPORTIONAL'
    },
    wholeUnitStep: { type: Number, min: 0.01, default: null },
    fixedMinimumAmount: { type: Number, min: 0, default: null },
    allowedSubstitutions: { type: [substitutionSchema], default: [] }
}, { _id: false });

const stepSchema = new mongoose.Schema({
    order: { type: Number, required: true },
    instruction: { type: String, required: true }
}, { _id: false });

const recipeSchema = new mongoose.Schema(
    {
        recipeId: { type: String, required: true, unique: true, trim: true },
        title: {
            type: String,
            required: [true, 'Tên công thức nấu ăn là bắt buộc!'],
            trim: true
        },
        aliases: [{ type: String, trim: true }],
        description: { type: String, trim: true },
        sourceUrl: { type: String, trim: true },
        imageUrl: { type: String, trim: true },
        mealType: {
            type: String,
            enum: ['BREAKFAST', 'LUNCH', 'DINNER', 'SNACK'],
            default: 'LUNCH'
        },
        mealTypes: [{
            type: String,
            enum: ['BREAKFAST', 'LUNCH', 'DINNER', 'SNACK']
        }],
        difficulty: {
            type: String,
            enum: ['EASY', 'MEDIUM', 'HARD'],
            default: 'MEDIUM'
        },
        prepTime: { type: Number, default: 15 },
        cookTime: { type: Number, default: 15 },
        servings: { type: Number, default: 1 },
        baseServings: { type: Number, min: 0.25, default: null },
        minCookServings: { type: Number, min: 0.25, default: 1 },
        servingStep: { type: Number, min: 0.25, default: 1 },
        allowScaleDown: { type: Boolean, default: true },
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
        dishRole: {
            type: String,
            enum: DISH_ROLES,
            default: 'MAIN'
        },
        dishType: {
            type: String,
            enum: ['MAIN', 'SIDE', 'SOUP', 'DRINK', 'DESSERT', 'SNACK'],
            default: 'MAIN'
        },
        cookingTimeMinutes: { type: Number, min: 0, default: null },
        // Mixed chỉ để đọc đồng thời steps dạng object cũ và string mới.
        steps: [{ type: mongoose.Schema.Types.Mixed }],
        ingredients: [ingredientSchema],
        searchText: { type: String, trim: true, default: '' },
        embeddingModel: { type: String, trim: true, default: null },
        embeddingVersion: { type: String, trim: true, default: null },
        source: {
            type: String,
            enum: ['SYSTEM', 'AI'],
            default: 'SYSTEM'
        },
        status: {
            type: String,
            enum: ['DRAFT', 'ACTIVE', 'ARCHIVED', 'TEST'],
            default: 'ACTIVE'
        },
        dataVersion: { type: Number, min: 1, default: 1 },
        testTag: { type: String, trim: true, default: null },
        
        // Trường lưu trữ Vector nhúng cho MongoDB Atlas Vector Search
        embeddingVector: {
            type: [Number],
            select: false, // Mặc định không query trường này ra để giảm tải băng thông
            validate: {
                validator: vector => !vector?.length || vector.length === 768,
                message: 'embeddingVector phải có đúng 768 chiều.'
            }
        }
    },
    {
        timestamps: true
    }
);

recipeSchema.pre('validate', function syncLegacyAndCanonicalFields() {
    if (['AI_GENERATED', 'AI_ADAPTED'].includes(this.source)) this.source = 'AI';
    if (['CURATED', 'IMPORTED', 'LEGACY'].includes(this.source)) this.source = 'SYSTEM';
    this.baseServings = this.baseServings || this.servings || 1;
    this.servings = this.baseServings;
    this.mealTypes = this.mealTypes?.length ? this.mealTypes : [this.mealType || 'LUNCH'];
    this.mealType = this.mealType || this.mealTypes[0];
    this.dishRole = this.dishRole || DISH_ROLE_BY_LEGACY_COMPONENT[this.mealComponentType] || 'MAIN';
    this.mealComponentType = this.mealComponentType || LEGACY_COMPONENT_BY_DISH_ROLE[this.dishRole] || 'MAIN_COURSE';
    this.cookingTimeMinutes = this.cookingTimeMinutes ?? ((this.prepTime || 0) + (this.cookTime || 0));

    for (const ingredient of this.ingredients || []) {
        ingredient.name = ingredient.name || ingredient.canonicalName || ingredient.itemName;
        ingredient.canonicalName = ingredient.canonicalName || ingredient.name || ingredient.itemName;
        ingredient.itemName = ingredient.itemName || ingredient.name || ingredient.canonicalName;
        ingredient.rawName = ingredient.rawName || ingredient.itemName;
        ingredient.required = ingredient.required ?? ingredient.isCore;
        ingredient.isCore = ingredient.isCore ?? ingredient.required;
        if (ingredient.scalingMode === 'WHOLE_UNIT' && !ingredient.wholeUnitStep) {
            ingredient.wholeUnitStep = 1;
        }
        if (STANDARD_UNITS.includes(String(ingredient.unit).toUpperCase())) {
            ingredient.unit = String(ingredient.unit).toUpperCase();
        }
    }

    if (!this.searchText) {
        this.searchText = [
            this.title,
            ...(this.aliases || []),
            ...(this.ingredients || []).map(item => item.name || item.canonicalName || item.itemName),
            ...(this.tags || []),
            this.dishRole,
            ...(this.mealTypes || []),
            this.description
        ].filter(Boolean).join(' ');
    }
});

// Đánh chỉ mục Text Search dự phòng cho các trường hợp không dùng Vector Search
recipeSchema.index({ title: 'text', tags: 'text' });

const Recipe = mongoose.model('Recipe', recipeSchema);
module.exports = Recipe;
