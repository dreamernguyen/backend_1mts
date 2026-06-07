// models/transaction.model.js
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// Embedded Schema (Mảng lồng): Chi tiết món đồ trong giỏ hàng
const embeddedItemSchema = new Schema({
  // Tên vật phẩm sạch
  itemName: { 
    type: String, 
    required: [true, 'Tên thực phẩm chuẩn hóa là bắt buộc!'], 
    trim: true 
  },
  
  // Số lượng mua
  quantity: { 
    type: Number, 
    required: [true, 'Số lượng mua là bắt buộc!'], 
    min: [0, 'Số lượng không được nhỏ hơn 0!'],
    default: 1 
  },
  
  // Đơn vị gốc hiển thị
  unit: { 
    type: String, 
    required: [true, 'Đơn vị hiển thị gốc là bắt buộc!'], 
    trim: true 
  },
  
  // Định lượng chuẩn toán học
  standardQuantity: { 
    type: Number, 
    required: [true, 'Định lượng số toán học quy đổi là bắt buộc!'] 
  },
  
  // Đơn vị chuẩn toán học quốc tế
  standardUnit: { 
    type: String, 
    required: [true, 'Đơn vị quy chuẩn là bắt buộc!'],
    enum: {
      values: ['G', 'KG', 'ML', 'L', 'PIECE'],
      message: 'Đơn vị chuẩn hóa phải là: G, KG, ML, L, hoặc PIECE'
    }
  },
  
  // Đơn giá món hàng
  purchasePrice: { 
    type: Number, 
    required: [true, 'Đơn giá mặt hàng là bắt buộc!'], 
    min: [0, 'Giá tiền không được nhỏ hơn 0!'] 
  },
  
  // Phân loại danh mục
  category: {
    type: String,
    required: true,
    enum: ['MEAT', 'SEAFOOD', 'VEGETABLE', 'FRUIT', 'EGG', 'DRY_FOOD', 'DRINK', 'SPICE', 'COSMETIC', 'SUPPLEMENT', 'OTHER'],
    default: 'OTHER'
  }
});

// Main Transaction Schema: Quản lý giao dịch thu/chi
const transactionSchema = new Schema(
  {
    // Người dùng
    userId: { 
      type: Schema.Types.ObjectId, 
      ref: 'User', 
      required: [true, 'Id người dùng là bắt buộc!'], 
      index: true 
    },
    
    // Phân loại dòng tiền
    transactionType: { 
      type: String, 
      enum: ['EXPENSE', 'INCOME'], 
      required: true, 
      default: 'EXPENSE' 
    },
    
    // Tổng số tiền thực trả
    amount: { 
      type: Number, 
      required: [true, 'Tổng số tiền giao dịch là bắt buộc!'], 
      min: [0, 'Số tiền không được nhỏ hơn 0!'] 
    },

    // Tiền giảm giá/voucher
    discount: {
      type: Number,
      default: 0,
      min: [0, 'Số tiền giảm giá không được âm!']
    },

    // Ghi chú
    note: { 
      type: String, 
      required: [true, 'Ghi chú nội dung chi tiêu là bắt buộc!'], 
      trim: true 
    },
    
    // Ngày giao dịch (UTC)
    date: { 
      type: Date, 
      required: true, 
      default: Date.now 
    },
    
    // Phân loại ví
    category: {
      type: String,
      required: true,
      enum: [
        // --- CÁC KHOẢN CHI (EXPENSE) ---
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
        
        // --- CÁC KHOẢN THU (INCOME) ---
        'SALARY',        // Tiền lương đi làm, tiền dự án
        'ALLOWANCE',     // Tiền chu cấp từ gia đình
        'SCHOLARSHIP',   // Học bổng
        
        // --- DANH MỤC PHÁT SINH ---
        'OTHERS'         // Đám cưới, sinh nhật, chi phí phát sinh lặt vặt khác
      ],
      default: 'OTHERS'
    },
    
    // Phương thức thanh toán
    paymentMethod: { 
      type: String, 
      enum: ['CASH', 'MOMO', 'VNPAY', 'BANK_TRANSFER', 'CREDIT_CARD'], 
      default: 'CASH' 
    },

    // Tên nơi bán
    merchantName: { 
      type: String, 
      trim: true, 
      default: '' 
    },
    
    // Chi tiết mặt hàng (Market only)
    items: [embeddedItemSchema]
  },
  {
    // Tự động quản lý hai trường createdAt và updatedAt theo múi giờ UTC chuẩn hóa toàn cầu
    timestamps: true
  }
);

// Indexes
transactionSchema.index({ userId: 1, date: -1 });

module.exports = mongoose.model('Transaction', transactionSchema);

