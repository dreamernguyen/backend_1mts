const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// Snapshot item giữ lịch sử bill kể cả khi lô kho sau đó thay đổi.
const embeddedItemSchema = new Schema({
  rawName: { type: String, trim: true, default: '' },
  brand: { type: String, trim: true, default: 'No name' },
  itemName: { 
    type: String, 
    required: [true, 'Tên thực phẩm chuẩn hóa là bắt buộc!'], 
    trim: true 
  },
  
  quantity: { 
    type: Number, 
    required: [true, 'Số lượng mua là bắt buộc!'], 
    min: [0, 'Số lượng không được nhỏ hơn 0!'],
    default: 1 
  },
  
  unit: { 
    type: String, 
    required: [true, 'Đơn vị hiển thị gốc là bắt buộc!'], 
    trim: true 
  },
  
  standardQuantity: { 
    type: Number, 
    required: [true, 'Định lượng số toán học quy đổi là bắt buộc!'] 
  },
  
  standardUnit: { 
    type: String, 
    required: [true, 'Đơn vị quy chuẩn là bắt buộc!'],
    enum: {
      values: ['G', 'KG', 'ML', 'L', 'PIECE'],
      message: 'Đơn vị chuẩn hóa phải là: G, KG, ML, L, hoặc PIECE'
    }
  },
  
  purchasePrice: { 
    type: Number, 
    required: [true, 'Đơn giá mặt hàng là bắt buộc!'], 
    min: [0, 'Giá tiền không được nhỏ hơn 0!'] 
  },
  
  category: {
    type: String,
    required: true,
    enum: ['MEAT', 'SEAFOOD', 'VEGETABLE', 'FRUIT', 'EGG', 'DRY_FOOD', 'DRINK', 'SPICE', 'COSMETIC', 'SUPPLEMENT', 'OTHER'],
    default: 'OTHER'
  },
  subCategory: { type: String, trim: true, default: 'OTHER' },
  isSingleUse: { type: Boolean, default: false },
  storageLocation: {
    type: String,
    enum: ['FRIDGE', 'FREEZER', 'PANTRY'],
    default: null
  },
  expiryDate: { type: Date, default: null },
  expirySource: {
    type: String,
    enum: ['USER', 'ESTIMATED_RULE', 'LEGACY_UNKNOWN', 'NOT_APPLICABLE'],
    default: 'LEGACY_UNKNOWN'
  },
  expiryRuleCode: { type: String, trim: true, default: null }
});

// Transaction là nguồn lịch sử tiền; Item là lô tồn kho phát sinh từ MARKET.
const transactionSchema = new Schema(
  {
    userId: { 
      type: Schema.Types.ObjectId, 
      ref: 'User', 
      required: [true, 'Id người dùng là bắt buộc!'], 
      index: true 
    },
    
    transactionType: { 
      type: String, 
      enum: ['EXPENSE', 'INCOME'], 
      required: true, 
      default: 'EXPENSE' 
    },
    
    amount: { 
      type: Number, 
      required: [true, 'Tổng số tiền giao dịch là bắt buộc!'], 
      min: [0, 'Số tiền không được nhỏ hơn 0!'] 
    },

    discount: {
      type: Number,
      default: 0,
      min: [0, 'Số tiền giảm giá không được âm!']
    },

    note: { 
      type: String, 
      required: [true, 'Ghi chú nội dung chi tiêu là bắt buộc!'], 
      trim: true 
    },
    
    date: { 
      type: Date, 
      required: true, 
      default: Date.now 
    },
    
    category: {
      type: String,
      required: true,
      enum: [
        'HOUSING',       // Tiền nhà, điện, nước, internet
        'ACADEMICS',     // Học phí, giáo trình, dụng cụ học tập
        'RESTAURANT',    // Ăn uống hàng ngày, cà phê, trà sữa ngoài tiệm (Dùng hết liền)
        'MARKET',        // Đi chợ, nhu yếu phẩm, đồ tạp hóa (Có mảng items nạp kho)
        'CLOTHING',      // Quần áo, giày dép, phụ kiện
        'TRANSPORT',     // Xăng xe, vé xe, sửa xe, đặt xe công nghệ
        'HEALTHCARE',    // Thuốc men, khám bệnh, bảo hiểm
        'ENTERTAINMENT', // Xem phim, du lịch, tụ tập bạn bè
        'SAVINGS',       // Tích lũy, quỹ khẩn cấp phòng thân
        'APPLIANCES',    // Mua sắm đồ công nghệ, thiết bị gia dụng dùng lâu dài
        
        'SALARY',        // Tiền lương đi làm, tiền dự án
        'ALLOWANCE',     // Tiền chu cấp từ gia đình
        'SCHOLARSHIP',   // Học bổng
        
        'OTHERS'         // Đám cưới, sinh nhật, chi phí phát sinh lặt vặt khác
      ],
      default: 'OTHERS'
    },
    
    paymentMethod: { 
      type: String, 
      enum: ['CASH', 'MOMO', 'VNPAY', 'BANK_TRANSFER', 'CREDIT_CARD'], 
      default: 'CASH' 
    },

    merchantName: { 
      type: String, 
      trim: true, 
      default: '' 
    },
    // INTERNAL không phải thu nhập/chi tiêu; các delta chỉ do server ghi.
    financeKind: { type: String, enum: ['NORMAL', 'TRANSFER', 'ADJUSTMENT'], default: 'NORMAL' },
    cashDelta: { type: Number, default: 0 },
    savingsDelta: { type: Number, default: 0 },
    balanceTracked: { type: Boolean, default: false },
    fixedPayment: {
      code: { type: String, enum: ['RENT', 'POWER', 'WATER', 'OTHER'] },
      cycleKey: String,
      closes: { type: Boolean, default: false }
    },

    idempotencyKey: {
      type: String,
      trim: true,
      maxlength: 120,
      default: null
    },

    aiLatencyMs: { type: Number, min: 0, default: null },
    aiItemCount: { type: Number, min: 0, default: null },
    aiEditedFieldCount: { type: Number, min: 0, default: null },

    gamificationRewards: {
      savedAmount: { type: Number, default: 0, min: 0 },
      wisBonus: { type: Number, default: 0, min: 0 },
      message: { type: String, default: '' }
    },
    
    items: [embeddedItemSchema]
  },
  {
    timestamps: true
  }
);

// Chặn retry tạo trùng giao dịch nhưng vẫn cho giao dịch cũ không có key.
transactionSchema.index({ userId: 1, date: -1 });
transactionSchema.index(
  { userId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
);

module.exports = mongoose.model('Transaction', transactionSchema);

