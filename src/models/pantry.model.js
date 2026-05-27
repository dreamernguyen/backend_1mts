const mongoose = require('mongoose');

const pantryItemSchema = new mongoose.Schema(
    {
        // Khóa ngoại liên kết thực phẩm với người dùng sở hữu
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: [true, 'Mỗi vật phẩm trong kho bắt buộc phải thuộc về một User!']
        },
        // Khóa ngoại liên kết ngược về Hóa đơn gốc (Tùy chọn - Nullable)
        // Nhập bằng AI quét hóa đơn sẽ có mã ID này, nếu nhập tay thủ công trường này sẽ trống (null)
        receiptId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Receipt',
            required: false 
        },
        // Tên thô bóc từ hóa đơn (Ví dụ: "Sua tuoi TH True Milk thanh trung 1L")
        rawName: {
            type: String,
            trim: true,
            default: ''
        },
        // Tên chuẩn hóa sau màng lọc AI dùng để nấu ăn (Ví dụ: "Sữa tươi không đường")
        itemName: {
            type: String,
            required: [true, 'Tên nguyên liệu lưu kho không được bỏ trống!'],
            trim: true,
            maxlength: [100, 'Tên nguyên liệu không được dài quá 100 ký tự']
        },
        // Nhóm phân loại bao quát toàn bộ thế giới bếp núc
        category: {
            type: String,
            required: [true, 'Phân loại nhóm nguyên liệu là bắt buộc!'],
            enum: {
                values: ['MEAT', 'SEAFOOD', 'VEGETABLE', 'FRUIT', 'DAIRY', 'EGG', 'DRINK', 'OTHERS'],
                message: 'Nhóm nguyên liệu phải thuộc: MEAT, SEAFOOD, VEGETABLE, FRUIT, DAIRY, EGG, DRINK hoặc OTHERS'
            },
            default: 'OTHERS'
        },
        // Số lượng/Trọng lượng hiện tại trong kho (Sẽ trừ dần khi nấu ăn, ví dụ: 1000ml -> 700ml)
        quantity: {
            type: Number,
            required: [true, 'Số lượng/trọng lượng hiện tại là bắt buộc!'],
            min: [0, 'Số lượng hiện tại không được phép nhỏ hơn 0!'],
            default: 1
        },
        // Sức chứa/Dung tích ban đầu lúc mua (Ví dụ: 1000ml hoặc 10 quả) - Dùng để tính toán lượng hao hụt
        originalQuantity: {
            type: Number,
            required: [true, 'Dung tích ban đầu là bắt buộc để hỗ trợ thuật toán tính tỷ lệ tiêu dùng!'],
            min: [0, 'Dung tích ban đầu không được nhỏ hơn 0!'],
            default: 1
        },
        unit: {
            type: String,
            required: [true, 'Đơn vị đo lường là bắt buộc!'],
            trim: true,
            default: 'cái' // ml, g, quả, hộp, cái...
        },
        // Cờ đánh dấu nhu yếu phẩm tiêu dùng 1 lần hết luôn (Hộp sữa nhỏ 220ml, quả trứng -> true)
        // Giúp Client Flutter tối ưu UX, ấn 1 nút là trừ thẳng về 0, không cần bắt user gõ lượng tiêu hao
        isSingleUse: {
            type: Boolean,
            default: false
        },
        // Đơn giá mua thực tế bóc tách từ hóa đơn - Phục vụ trực tiếp cho thống kê chi tiêu sinh hoạt phí
        purchasePrice: {
            type: Number,
            required: [true, 'Giá mua thực tế là bắt buộc!'],
            min: [0, 'Giá mua không được phép là số âm!'],
            default: 0
        },
        expiryDate: {
            type: Date,
            required: [true, 'Hạn sử dụng là bắt buộc để hệ thống đưa ra cảnh báo sinh tồn!']
        }
    },
    {
        timestamps: true, // Tự động ghi nhận ngày nhập kho (createdAt) và ngày cập nhật (updatedAt)
        toJSON: { virtuals: true }, // Bắt buộc cấu hình này để chuyển trường ảo storageStatus sang client
        toObject: { virtuals: true }
    }
);

 //Tự động so sánh thời gian thực tế để trả ra trạng thái: FRESH, WARNING, EXPIRED
 
pantryItemSchema.virtual('storageStatus').get(function () {
    const now = new Date();
    const expiry = new Date(this.expiryDate);
    const timeDiff = expiry.getTime() - now.getTime();
    const daysLeft = timeDiff / (1000 * 3600 * 24);

    if (daysLeft < 0) return 'EXPIRED';
    if (daysLeft <= 1) return 'WARNING';
    return 'FRESH';
});

// Tạo Compound Index tối ưu hóa triệt để tốc độ truy vấn sắp xếp thực phẩm sắp hết hạn
pantryItemSchema.index({ userId: 1, expiryDate: 1 });

const PantryItem = mongoose.model('PantryItem', pantryItemSchema);
module.exports = PantryItem;