const VIETNAM_TIME_ZONE = 'Asia/Ho_Chi_Minh';

const vietnamDateFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: VIETNAM_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
});

function vietnamDateParts(value) {
    if (value === undefined || value === null || value === '') return null;
    const parsed = value instanceof Date ? new Date(value) : new Date(String(value));
    if (Number.isNaN(parsed.getTime())) return null;
    const parts = vietnamDateFormatter.formatToParts(parsed);
    const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return { year: Number(byType.year), month: Number(byType.month), day: Number(byType.day) };
}

function vietnamDayBoundary(value, endOfDay = false) {
    const parts = vietnamDateParts(value);
    if (!parts) return null;
    // Việt Nam là UTC+7: 00:00/23:59:59.999 địa phương là 17:00/16:59:59.999 UTC.
    return new Date(Date.UTC(parts.year, parts.month - 1, parts.day - (endOfDay ? 0 : 1),
        endOfDay ? 16 : 17, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0));
}

function startOfVietnamDay(value) { return vietnamDayBoundary(value, false); }
function endOfVietnamDay(value) { return vietnamDayBoundary(value, true); }

function addVietnamDays(value, days) {
    const start = startOfVietnamDay(value);
    if (!start) return null;
    start.setUTCDate(start.getUTCDate() + Number(days || 0));
    return endOfVietnamDay(start);
}

function daysBetweenVietnamDates(from, to) {
    const fromStart = startOfVietnamDay(from);
    const toStart = startOfVietnamDay(to);
    if (!fromStart || !toStart) return null;
    return Math.round((toStart.getTime() - fromStart.getTime()) / 86400000);
}

module.exports = { VIETNAM_TIME_ZONE, startOfVietnamDay, endOfVietnamDay, addVietnamDays, daysBetweenVietnamDates };
