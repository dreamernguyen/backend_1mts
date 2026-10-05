const router = require('express').Router();
const { verifyToken } = require('../middleware/auth.middleware');
const telemetry = require('../services/ai-metrics-telemetry');
const bursts = new Map();
function allowBurst(userId, now = Date.now(), count = 1) {
    // Bound memory, expire inactive users. In-process protection, not a distributed limiter.
    for (const [key, value] of bursts) if (now - value.since >= 60000) bursts.delete(key);
    const key = String(userId);
    const entry = bursts.get(key) || { since: now, count: 0 };
    if (!bursts.has(key) && bursts.size >= 1000) return false;
    entry.count += count;
    bursts.set(key, entry);
    return entry.count <= 120;
}
router.use(verifyToken);
router.post('/ai-metrics/events/batch', (req, res) => {
    try {
        const events = req.body?.events;
        if (!Array.isArray(events) || !events.length || events.length > 20 || Buffer.byteLength(JSON.stringify(req.body)) > 256 * 1024) {
            return res.status(400).json({ success: false, message: 'Batch metrics chỉ nhận 1–20 sự kiện, tối đa 256 KB' });
        }
        // Validate the complete batch before scheduling anything.
        const payloads = events.map(event => telemetry.validateClientEvent(event, req.user.userId));
        if (!allowBurst(req.user.userId, Date.now(), payloads.length)) return res.status(429).json({ success: false, message: 'Quá nhiều sự kiện metrics, vui lòng thử lại sau' });
        if (!telemetry.enqueueBatch(payloads)) return res.status(503).json({ success: false, message: 'Hàng đợi metrics đang bận' });
        return res.status(202).json({ success: true, accepted: true, acceptedEventIds: payloads.map(payload => payload.eventId), durable: false });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
});
router.post('/ai-metrics/events', (req, res) => {
    try {
        if (!allowBurst(req.user.userId)) return res.status(429).json({ success: false, message: 'Quá nhiều sự kiện metrics, vui lòng thử lại sau' });
        const payload = telemetry.validateClientEvent(req.body, req.user.userId);
        if (!telemetry.enqueue(payload)) return res.status(503).json({ success: false, message: 'Hàng đợi metrics đang bận' });
        // Accepted is not a durability acknowledgement; telemetry remains non-blocking.
        return res.status(202).json({ success: true, accepted: true });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
});
module.exports = router;
