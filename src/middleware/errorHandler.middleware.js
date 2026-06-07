// Tự động bắt lỗi và chuyển đến errorHandler tập trung.
const asyncHandler = fn => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

// Xử lý lỗi tập trung, PHẢI đặt cuối cùng trong server.js.
const errorHandler = (err, req, res, next) => {
    // In stack trace ra terminal để tiện debug
    console.error(`[Server Error] ${err.stack || err.message}`);

    // Lỗi validation của Mongoose (VD: trường bắt buộc bị thiếu, enum sai giá trị)
    if (err.name === 'ValidationError') {
        const messages = Object.values(err.errors).map(e => e.message);
        return res.status(400).json({ success: false, message: messages.join(' | ') });
    }

    // Lỗi ID MongoDB không đúng định dạng ObjectId (VD: truyền "abc" thay vì ID 24 ký tự)
    if (err.name === 'CastError') {
        return res.status(400).json({
            success: false,
            message: `ID không hợp lệ: "${err.value}"`
        });
    }

    // Lỗi trùng lặp dữ liệu unique (VD: email đã tồn tại, providerId trùng)
    if (err.code === 11000) {
        const field = Object.keys(err.keyValue)[0];
        return res.status(409).json({
            success: false,
            message: `Giá trị trường "${field}" đã tồn tại trong hệ thống!`
        });
    }

    // Lỗi mặc định - Trả về statusCode nếu có, hoặc 500
    return res.status(err.statusCode || 500).json({
        success: false,
        message: err.message || 'Lỗi hệ thống không xác định! Vui lòng thử lại sau.'
    });
};

module.exports = { asyncHandler, errorHandler };
