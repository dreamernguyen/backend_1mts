const mongoose = require('mongoose');

// Kiểm tra các trường bắt buộc trong req.body một cách linh hoạt.
const requireBody = (...fields) => (req, res, next) => {
    // Lọc ra các trường bị thiếu (undefined, null, hoặc chuỗi rỗng)
    const missing = fields.filter(f => {
        const val = req.body[f];
        return val === undefined || val === null || val === '';
    });

    if (missing.length > 0) {
        return res.status(400).json({
            success: false,
            message: `Thiếu thông tin bắt buộc: [${missing.join(', ')}]`
        });
    }
    next();
};

// Kiểm tra tham số req.params có phải MongoDB ObjectId hợp lệ không.
const validateObjectId = (...paramNames) => (req, res, next) => {
    for (const name of paramNames) {
        const val = req.params[name];
        if (val && !mongoose.Types.ObjectId.isValid(val)) {
            return res.status(400).json({
                success: false,
                message: `Tham số "${name}" không phải là ID MongoDB hợp lệ!`
            });
        }
    }
    next();
};

module.exports = { requireBody, validateObjectId };
