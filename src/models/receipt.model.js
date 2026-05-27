
const mongoose = require('mongoose');

const receiptSchema = new mongoose.Schema(
    {
        // Khóa ngoại liên kết hóa đơn với chủ tài khoản sở hữu
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: [true, 'Hóa đơn bắt buộc phải thuộc về một User!']
        },
        // Tên nơi mua (Ví dụ: "Siêu thị Co.opmart", "Chợ Bách Hóa Xanh") do AI tự bóc tách
        merchantName: {
            type: String,
            trim: true,
            default: 'Cửa hàng bán lẻ'
        },
        // MẢNG NHÚNG (Embedded Array): Lưu trọn vẹn mọi mặt hàng thô trên bill gốc để quản lý chi tiêu
        items: [
            {
                rawName: { 
                    type: String, 
                    required: [true, 'Tên thô trên hóa đơn là bắt buộc!'], 
                    trim: true 
                },
                price: { 
                    type: Number, 
                    required: [true, 'Giá tiền mặt hàng là bắt buộc!'], 
                    min: [0, 'Giá tiền không được phép âm!'] 
                },
                quantity: { 
                    type: Number, 
                    default: 1,
                    min: [1, 'Số lượng mua tối thiểu là 1']
                }
            }
        ],
        // Tổng số tiền thực tế của hóa đơn (Bao gồm cả đồ ăn lẫn đồ gia dụng mua kèm)
        totalAmount: {
            type: Number,
            required: [true, 'Tổng tiền hóa đơn là bắt buộc để quản lý tài chính sinh hoạt!'],
            min: [0, 'Tổng tiền không được phép là số âm!']
        },
        // Trạng thái xử lý bóc tách của công cụ AI OCR
        ocrStatus: {
            type: String,
            required: true,
            enum: ['PROCESSING', 'COMPLETED', 'FAILED'],
            default: 'COMPLETED'
        }
    },
    {
        // Tự động ghi nhận ngày quét hóa đơn (createdAt) để làm biểu đồ chi tiêu
        timestamps: true 
    }
);

// Đánh chỉ mục Index giúp tìm kiếm lịch sử chi tiêu hóa đơn của một User theo thứ tự mới nhất cực nhanh
receiptSchema.index({ userId: 1, createdAt: -1 });

const Receipt = mongoose.model('Receipt', receiptSchema);
module.exports = Receipt;

