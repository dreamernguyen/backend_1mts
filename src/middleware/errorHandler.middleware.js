// Controller async không cần lặp try/catch chỉ để trả lỗi HTTP.
const asyncHandler = fn => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

// Đặt cuối server.js để Express nhận lỗi từ mọi route.
const errorHandler = (err, req, res, next) => {
    console.error(`[Server Error] ${err.stack || err.message}`);

    if (err.name === 'ValidationError') {
        const messages = Object.values(err.errors).map(e => e.message);
        return res.status(400).json({ success: false, message: messages.join(' | ') });
    }

    if (err.name === 'CastError') {
        return res.status(400).json({
            success: false,
            message: `ID không hợp lệ: "${err.value}"`
        });
    }

    if (err.code === 11000) {
        const field = Object.keys(err.keyValue)[0];
        return res.status(409).json({
            success: false,
            message: `Giá trị trường "${field}" đã tồn tại trong hệ thống!`
        });
    }

    return res.status(err.statusCode || 500).json({
        success: false,
        ...(err.appCode ? { code: err.appCode } : {}),
        message: err.message || 'Lỗi hệ thống không xác định! Vui lòng thử lại sau.'
    });
};

module.exports = { asyncHandler, errorHandler };
