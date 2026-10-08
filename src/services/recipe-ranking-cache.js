const { createHash } = require('node:crypto');
const { startOfVietnamDay } = require('./vietnam-date.service');

// Shared ranking only: never used to authorize cooking or consume inventory.
function createRankingCache({ ttlMs = 60000, maxUsers = 100, clock = Date.now } = {}) {
    const entries = new Map();
    return {
        get(userId, inventory, catalog, build, refresh = false) {
            const now = clock();
            const signature = createHash('sha256').update(JSON.stringify(inventory)).digest('hex');
            const day = startOfVietnamDay(new Date(now)).getTime();
            const key = String(userId);
            const cached = entries.get(key);
            if (!refresh && cached && cached.expires > now && cached.day === day
                && cached.signature === signature && cached.catalog === catalog) {
                return { ranked: cached.ranked, cacheHit: true };
            }
            const ranked = build();
            for (const [id, entry] of entries) if (entry.expires <= now) entries.delete(id);
            entries.delete(key);
            if (entries.size >= maxUsers) entries.delete(entries.keys().next().value);
            entries.set(key, { ranked, signature, catalog, day, expires: now + ttlMs });
            return { ranked, cacheHit: false };
        }
    };
}
module.exports = { createRankingCache };
