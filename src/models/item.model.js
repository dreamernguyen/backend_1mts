const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const itemSchema = new Schema(
  {
    // Liên kết hệ thống
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Mỗi vật phẩm bắt buộc phải thuộc về một User!"],
      index: true,
    },
    transactionId: {
      type: Schema.Types.ObjectId,
      ref: "Transaction",
      required: false,
      default: null,
    },

    // Phân tầng danh mục
    rawName: {
      type: String,
      trim: true,
      default: "",
    },
    itemName: {
      type: String,
      required: [true, "Tên vật phẩm chuẩn hóa là bắt buộc!"],
      trim: true,
      maxlength: [100, "Tên vật phẩm không được dài quá 100 ký tự"],
    },
    brand: {
      type: String,
      trim: true,
      default: "No name",
    },
    category: {
      type: String,
      required: true,
      enum: ["MEAT", "SEAFOOD", "VEGETABLE", "FRUIT", "EGG", "DRY_FOOD", "DRINK", "SPICE", "COSMETIC", "SUPPLEMENT", "OTHER"],
      default: "VEGETABLE",
    },
    subCategory: {
      type: String,
      trim: true,
      enum: [
        "PORK", "BEEF", "CHICKEN", "DUCK", "GOOSE", "PROCESSED_MEAT", "OTHER_MEAT",
        "FISH", "SHRIMP", "SQUID_OCTOPUS", "CRAB_SHELLFISH", "OTHER_SEAFOOD",
        "LEAFY_VEG", "ROOT_VEG", "MUSHROOM", "HERB_SPICE_VEG", "OTHER_VEG",
        "CITRUS", "TROPICAL", "TEMPERATE", "OTHER_FRUIT",
        "MILK", "WATER", "SODA_JUICE", "COFFEE_TEA", "ALCOHOL",
        "NOODLE_PASTA", "RICE_GRAIN", "BASIC_SPICE", "SAUCE",
        "OTHER", ""
      ],
      default: "OTHER", 
    },

    // Quản lý định lượng
    quantity: {
      type: Number,
      required: [true, "Số lượng hiện tại là bắt buộc!"],
      min: [0, "Số lượng không được nhỏ hơn 0!"],
      default: 1,
    },
    originalQuantity: {
      type: Number,
      required: [
        true,
        "Số lượng ban đầu là bắt buộc để tính toán tỷ lệ tiêu hao!",
      ],
      min: [0, "Số lượng ban đầu không được nhỏ hơn 0!"],
      default: 1,
    },
    unit: {
      type: String,
      required: [true, "Đơn vị hiển thị giao diện là bắt buộc!"],
      trim: true,
      default: "cái",
    },
    standardQuantity: {
      type: Number,
      required: [true, "Định lượng quy chuẩn toán học bắt buộc phải có!"],
      min: [0, "Định lượng chuẩn không được nhỏ hơn 0!"],
    },
    standardUnit: {
      type: String,
      required: [true, "Đơn vị quy chuẩn toán học là bắt buộc!"],
      enum: ["G", "KG", "ML", "L", "PIECE"], // Đơn vị chuẩn toán học quốc tế
      default: "PIECE",
    },

    // Trạng thái tiêu dùng
    isSingleUse: {
      type: Boolean,
      default: false,
    },
    isCookedMeal: {
      type: Boolean,
      default: false,
    },
    sourceRecipeId: {
      type: String,
      trim: true,
      default: null,
    },
    cookIdempotencyKey: {
      type: String,
      trim: true,
      maxlength: 120,
      default: null,
    },
    isFromSuggestion: {
      type: Boolean,
      default: false,
    },
    rescuedCount: {
      type: Number,
      min: 0,
      default: 0,
    },
    purchasePrice: {
      type: Number,
      required: [true, "Giá mua thực tế là bắt buộc để thống kê chi tiêu!"],
      min: [0, "Giá mua không được là số âm!"],
      default: 0,
    },
    baseUnitPrice: {
      type: Number,
      default: 0,
      min: 0,
    },
    expiryDate: {
      type: Date,
      required: false,
      default: null,
    },
    storageLocation: {
      type: String,
      enum: ["FRIDGE", "FREEZER", "PANTRY"],
      default: null,
    },
    expirySource: {
      type: String,
      enum: ["USER", "ESTIMATED_RULE", "LEGACY_UNKNOWN", "NOT_APPLICABLE"],
      default: "LEGACY_UNKNOWN",
    },
    expiryRuleCode: {
      type: String,
      trim: true,
      maxlength: [80, "Mã quy tắc hạn dùng không được dài quá 80 ký tự"],
      default: null,
    },
    usageStatus: {
      type: String,
      enum: ["ACTIVE", "CONSUMED", "WASTED"],
      default: "ACTIVE",
      index: true,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// Virtual fields

// Tính ngày còn hạn
itemSchema.virtual("daysRemaining").get(function () {
  if (!this.expiryDate || this.expirySource === "NOT_APPLICABLE") {
    return null;
  }
  const now = new Date();
  const expiry = new Date(this.expiryDate);
  now.setHours(0, 0, 0, 0);
  expiry.setHours(0, 0, 0, 0);
  return Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 3600 * 24));
});

// Phân loại trạng thái hạn dựa trên ngày còn lại
itemSchema.virtual("storageStatus").get(function () {
  if (!this.expiryDate || this.expirySource === "NOT_APPLICABLE") {
    return "STABLE";
  }

  const daysLeft = this.daysRemaining; // Tái sử dụng trường ảo bên trên

  if (daysLeft < 0) return "EXPIRED"; 
  if (daysLeft <= 2) return "WARNING"; 
  return "FRESH"; 
});

// Chỉ là trường dẫn xuất cho UI/API, không lưu thêm dữ liệu trùng lặp trong MongoDB.
itemSchema.virtual("expiryTracking").get(function () {
  return this.expirySource !== "NOT_APPLICABLE" && Boolean(this.expiryDate);
});

// Indexes
itemSchema.index({ userId: 1, usageStatus: 1, expiryDate: 1 });
itemSchema.index(
  { userId: 1, cookIdempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { cookIdempotencyKey: { $type: "string" } },
  },
);
itemSchema.index(
  { itemName: "text" },
  { diacriticSensitive: false, name: "itemName_text_index" },
);

const Item = mongoose.model("Item", itemSchema);
module.exports = Item;
