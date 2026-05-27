const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
    {
        email: {
            type: String,
            unique: true, 
            sparse: true, // Cho phép trường này trống (null) đối với tài khoản Khách
            lowercase: true,
            trim: true
        },
        displayName: {
            type: String,
            required: [true, 'Tên hiển thị là bắt buộc'],
            trim: true,
            default: 'Cư dân 1MTS'
        },
        avatar: {
            type: String,
            default: '' 
        },
        loginType: {
            type: String,
            required: [true, 'Phải xác định phương thức đăng nhập'],
            enum: ['google', 'guest'] // Sau này cập nhật các phương thức đăng nhập khác nếu cần
        },
        providerId: {
            type: String,
            required: [true, 'Mã định danh providerId là bắt buộc'],
            unique: true, 
            trim: true
        },
        monthlyBudget: {
            type: Number,
            default: 0
        },
        isActive: {
            type: Boolean,
            default: true
        }
    },
    {
        timestamps: true 
    }
);

// Tạo Index tối ưu hóa tốc độ tìm kiếm tài khoản khi đăng nhập nhanh
userSchema.index({ loginType: 1, providerId: 1 });

const User = mongoose.model('User', userSchema);
module.exports = User;