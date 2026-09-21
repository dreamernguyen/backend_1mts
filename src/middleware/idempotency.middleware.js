const idempotencyLocks = new Map();

exports.idempotencyMiddleware = (req, res, next) => {
    const key = req.headers['idempotency-key'];
    if (!key) {
        return next();
    }

    const lockKey = `${req.user?.userId || 'anon'}:${key}`;
    
    if (idempotencyLocks.has(lockKey)) {
        const error = new Error('Yêu cầu đang được xử lý hoặc đã được xử lý (trùng lặp).');
        error.statusCode = 429;
        return next(error);
    }

    // Đặt lock trong 10 giây (hoặc cho đến khi xử lý xong nếu tự xóa)
    idempotencyLocks.set(lockKey, true);
    
    // Tự động xóa lock sau 10s để giải phóng bộ nhớ
    setTimeout(() => {
        idempotencyLocks.delete(lockKey);
    }, 10000);

    next();
};
