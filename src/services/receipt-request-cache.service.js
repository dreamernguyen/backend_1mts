const crypto = require('node:crypto');

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 50;
const entries = new Map();

const createReceiptCacheKey = ({ userId, rawText, base64Image, promptVersion = 'receipt-v2' }) => {
    const hash = crypto.createHash('sha256');
    hash.update(String(userId || 'anonymous'));
    hash.update('\u0000');
    hash.update(promptVersion);
    hash.update('\u0000');
    hash.update(rawText?.trim() || '');
    hash.update('\u0000');
    hash.update(base64Image || '');
    return hash.digest('hex');
};

const prune = (now, maxEntries) => {
    for (const [key, entry] of entries) {
        if (entry.expiresAt <= now) entries.delete(key);
    }
    while (entries.size >= maxEntries) {
        entries.delete(entries.keys().next().value);
    }
};

const getOrCreateReceiptRequest = async (key, factory, options = {}) => {
    const now = Date.now();
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    const bypassCache = options.bypassCache === true;

    // Người dùng chủ động bấm quét lại: không đọc kết quả cũ và cũng không
    // ghi kết quả mới vào cache, để mỗi lần sửa sai thực sự gọi lại AI.
    if (bypassCache) {
        entries.delete(key);
        return { value: await factory(), cacheHit: false, cacheBypassed: true };
    }

    prune(now, maxEntries);

    const cached = entries.get(key);
    if (cached && cached.expiresAt > now) {
        return { value: await cached.promise, cacheHit: true, cacheBypassed: false };
    }

    const promise = Promise.resolve().then(factory);
    entries.set(key, { promise, expiresAt: now + ttlMs });
    try {
        return { value: await promise, cacheHit: false, cacheBypassed: false };
    } catch (error) {
        entries.delete(key);
        throw error;
    }
};

const clearReceiptRequestCache = () => entries.clear();
const deleteReceiptRequestCache = key => entries.delete(key);

module.exports = {
    createReceiptCacheKey,
    getOrCreateReceiptRequest,
    deleteReceiptRequestCache,
    clearReceiptRequestCache
};
