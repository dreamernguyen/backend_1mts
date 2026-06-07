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
  if (
    !this.expiryDate ||
    ["COSMETIC", "SUPPLEMENT", "SPICE"].includes(this.category)
  ) {
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
  if (
    !this.expiryDate ||
    ["COSMETIC", "SUPPLEMENT", "SPICE"].includes(this.category)
  ) {
    return "STABLE";
  }

  const daysLeft = this.daysRemaining; // Tái sử dụng trường ảo bên trên

  if (daysLeft < 0) return "EXPIRED"; 
  if (daysLeft <= 2) return "WARNING"; 
  return "FRESH"; 
});

// Indexes
itemSchema.index({ userId: 1, usageStatus: 1, expiryDate: 1 });
itemSchema.index(
  { itemName: "text" },
  { diacriticSensitive: false, name: "itemName_text_index" },
);

const Item = mongoose.model("Item", itemSchema);
module.exports = Item;
