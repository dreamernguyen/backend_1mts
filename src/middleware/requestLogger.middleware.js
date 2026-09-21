const { randomUUID } = require('node:crypto');

const describeRequest = (method, path) => {
    if (path.startsWith('/api/auth/guest')) return { tag: 'User', action: 'Login với chế độ Guest' };
    if (path.startsWith('/api/auth/google')) return { tag: 'User', action: 'Login với Google' };
    if (path.startsWith('/api/transactions/parse')) return { tag: 'Receipt', action: 'Bóc tách hóa đơn' };
    if (method === 'POST' && /^\/api\/transactions\/?(?:\?|$)/.test(path)) {
        return { tag: 'Transaction', action: 'Thêm giao dịch' };
    }
    if (path.startsWith('/api/items/essential-items')) {
        if (method === 'GET' && path.includes('/detail')) return { tag: 'Item', action: 'Load chi tiết lô hàng' };
        if (method === 'GET') return { tag: 'Item', action: 'Load danh sách item' };
        return { tag: 'Item', action: 'Cập nhật kho item' };
    }
    if (path.startsWith('/api/recipes')) return { tag: 'Recipe', action: 'Xử lý công thức' };
    if (path.startsWith('/api/notifications')) return { tag: 'Notification', action: 'Xử lý thông báo' };
    if (path.startsWith('/api/user')) return { tag: 'User', action: 'Xử lý thông tin người dùng' };
    if (path === '/health') return { tag: 'Server', action: 'Health check' };
    return { tag: 'Request', action: 'Xử lý API' };
};

// Ghi log cho mọi request, kể cả preflight CORS, 401, 404 và lỗi trước controller.
const requestLogger = (req, res, next) => {
    const requestId = req.get('X-Scan-Request-Id')
        || req.get('X-Request-Id')
        || randomUUID();
    const startedAt = process.hrtime.bigint();
    const path = req.originalUrl || req.url;
    const description = describeRequest(req.method, path);
    let ended = false;

    req.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    console.info(
        `[${description.tag}] ${description.action} - Bắt đầu ${req.method} ${path} - requestId=${requestId}`
    );

    const writeEndLog = (event) => {
        if (ended) return;
        ended = true;
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        const status = res.statusCode || 0;
        const success = event !== 'ABORTED' && status >= 200 && status < 400;
        const result = event === 'ABORTED' ? 'đã hủy' : success ? 'thành công' : 'thất bại';
        console.info(
            `[${description.tag}] ${description.action} ${result} - ${req.method} ${path} - `
            + `status=${status} - ${durationMs.toFixed(1)}ms - requestId=${requestId}`
        );
    };

    res.once('finish', () => writeEndLog('FINISHED'));
    res.once('close', () => {
        if (!res.writableEnded) writeEndLog('ABORTED');
    });
    next();
};

module.exports = { requestLogger, describeRequest };
