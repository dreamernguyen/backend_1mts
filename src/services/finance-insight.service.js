const crypto = require('crypto');

const FACT_ACTIONS = {
    BUDGET_NOT_CONFIGURED: ['CONFIGURE_BUDGET'],
    OVER_BUDGET: ['REVIEW_NON_ESSENTIAL_SPENDING'],
    LOW_REMAINING_BUDGET: ['REVIEW_NON_ESSENTIAL_SPENDING'],
    FOOD_SPENDING_UP: ['PLAN_MEALS_FROM_INVENTORY'],
    HOUSING_SPENDING_UP: ['CHECK_METER_READING'],
    UTILITY_SPIKE: ['CHECK_METER_READING', 'COMPARE_USAGE'],
    EXPIRING_INVENTORY_VALUE_HIGH: ['USE_EXPIRING_FOOD'],
    HEALTHY_SAVING_BUFFER: ['KEEP_SAVING_BUFFER'],
    INSUFFICIENT_DATA: ['ADD_TRANSACTIONS']
};

const KNOWLEDGE_CARDS = {
    BUDGET_NOT_CONFIGURED: 'Chưa có ngân sách để tính mức chi an toàn; hãy cấu hình số tiền thiết yếu trước.',
    OVER_BUDGET: 'Chi tiêu đã vượt ngân sách kỳ này; ưu tiên các khoản thiết yếu và rà soát khoản linh hoạt.',
    LOW_REMAINING_BUDGET: 'Phần ngân sách còn lại đang thấp; chia nhỏ mức chi cho các ngày còn lại.',
    FOOD_SPENDING_UP: 'Chi cho ăn uống tăng so với kỳ trước; ưu tiên lên kế hoạch món từ đồ đang có.',
    HOUSING_SPENDING_UP: 'Khoản nhà ở/điện nước tăng; kiểm tra chỉ số công-tơ và hóa đơn.',
    UTILITY_SPIKE: 'Chi phí điện nước tăng đáng kể; so sánh mức dùng với kỳ trước trước khi kết luận.',
    EXPIRING_INVENTORY_VALUE_HIGH: 'Có thực phẩm sắp hết hạn; ưu tiên dùng hoặc chế biến trước, không dùng đồ quá hạn.',
    HEALTHY_SAVING_BUFFER: 'Quỹ dự phòng đang ở mức tốt; tiếp tục duy trì nhịp chi tiêu hiện tại.',
    INSUFFICIENT_DATA: 'Dữ liệu trong kỳ còn ít, nhận định chỉ mang tính định hướng.'
};

const hashSnapshot = snapshot => crypto.createHash('sha256')
    .update(JSON.stringify(snapshot)).digest('hex');

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const detectFacts = snapshot => {
    const facts = [];
    const add = (code, severity, evidence) => facts.push({
        code, severity, evidence, allowedActions: FACT_ACTIONS[code] || []
    });
    if (snapshot.budget <= 0 || snapshot.essentialBudget <= 0) add('BUDGET_NOT_CONFIGURED', 'INFO', {});
    if (snapshot.transactionCount === 0) add('INSUFFICIENT_DATA', 'INFO', { transactionCount: 0 });
    if (snapshot.budget > 0 && snapshot.spent > snapshot.budget) {
        add('OVER_BUDGET', 'DANGER', { spent: snapshot.spent, budget: snapshot.budget });
    } else if (snapshot.budget > 0 && snapshot.remaining / snapshot.budget <= 0.15) {
        add('LOW_REMAINING_BUDGET', 'WARNING', { remaining: snapshot.remaining, daysRemaining: snapshot.daysRemaining });
    }
    for (const category of snapshot.categoryBreakdown) {
        const previous = snapshot.previousCategoryBreakdown[category.category] || 0;
        if (previous <= 0 || category.amount < previous * 1.25) continue;
        const code = category.category === 'HOUSING' ? 'HOUSING_SPENDING_UP'
            : category.category === 'MARKET' || category.category === 'RESTAURANT' ? 'FOOD_SPENDING_UP'
                : null;
        if (code) add(code, 'WARNING', { current: category.amount, previous, changePercent: Math.round((category.amount / previous - 1) * 100) });
    }
    if (snapshot.inventoryAtRiskValue > 0) {
        add('EXPIRING_INVENTORY_VALUE_HIGH', 'WARNING', { value: snapshot.inventoryAtRiskValue });
    }
    if (Number(snapshot.rpgStats?.def || 0) >= 100) add('HEALTHY_SAVING_BUFFER', 'CELEBRATE', { def: snapshot.rpgStats.def });
    return facts.slice(0, 5);
};

const createSnapshot = input => {
    const budget = Math.max(0, Number(input.budget) || 0);
    const spent = Math.max(0, Number(input.spent) || 0);
    const daysRemaining = Math.max(0, Number(input.daysRemaining) || 0);
    const remaining = budget - spent;
    const snapshot = {
        period: input.period,
        currency: 'VND',
        budget,
        essentialBudget: Math.max(0, Number(input.essentialBudget) || 0),
        spent,
        remaining,
        daysElapsed: Math.max(0, Number(input.daysElapsed) || 0),
        daysRemaining,
        // Chênh lệch kế hoạch không chứng minh người dùng có tiền để chi.
        safeSpendPerDay: null,
        plannedSpendPerDay: budget > 0 && daysRemaining > 0 ? Math.max(0, Math.floor(remaining / daysRemaining)) : null,
        categoryBreakdown: input.categoryBreakdown || [],
        previousCategoryBreakdown: input.previousCategoryBreakdown || {},
        inventoryAtRiskValue: Math.max(0, Number(input.inventoryAtRiskValue) || 0),
        rpgStats: input.rpgStats || {},
        transactionCount: Math.max(0, Number(input.transactionCount) || 0)
    };
    snapshot.facts = detectFacts(snapshot);
    snapshot.factCodes = snapshot.facts.map(fact => fact.code);
    return snapshot;
};

const fallbackInsight = snapshot => {
    const primary = snapshot.facts[0] || { code: 'INSUFFICIENT_DATA', severity: 'INFO', evidence: {}, allowedActions: ['ADD_TRANSACTIONS'] };
    const actionCode = primary.allowedActions[0] || 'ADD_TRANSACTIONS';
    const actionTitles = {
        CONFIGURE_BUDGET: 'Thiết lập ngân sách', REVIEW_NON_ESSENTIAL_SPENDING: 'Rà soát khoản linh hoạt',
        PLAN_MEALS_FROM_INVENTORY: 'Lên món từ đồ sẵn có', CHECK_METER_READING: 'Kiểm tra công-tơ',
        USE_EXPIRING_FOOD: 'Ưu tiên đồ sắp hết hạn', KEEP_SAVING_BUFFER: 'Duy trì quỹ dự phòng',
        ADD_TRANSACTIONS: 'Ghi thêm giao dịch'
    };
    return {
        tone: primary.severity === 'DANGER' ? 'CAUTION' : primary.severity === 'CELEBRATE' ? 'CELEBRATE' : 'SUPPORTIVE',
        headline: KNOWLEDGE_CARDS[primary.code],
        summary: `Nhận định dựa trên kế hoạch chi tiêu kỳ ${snapshot.period} (ngân sách còn lại không phải số dư thực có).`,
        highlights: snapshot.facts.slice(0, 2).map(fact => ({
            factCode: fact.code,
            message: KNOWLEDGE_CARDS[fact.code],
            evidenceNumbers: Object.values(fact.evidence).filter(Number.isFinite)
        })),
        actions: [{ actionCode, title: actionTitles[actionCode], reason: KNOWLEDGE_CARDS[primary.code], estimatedImpact: null }]
    };
};

const validateInsight = (candidate, snapshot) => {
    if (!candidate || typeof candidate !== 'object') return null;
    if (!['SUPPORTIVE', 'CAUTION', 'CELEBRATE', 'NEUTRAL'].includes(candidate.tone)) return null;
    if (typeof candidate.headline !== 'string' || candidate.headline.length < 3 || candidate.headline.length > 120) return null;
    if (typeof candidate.summary !== 'string' || candidate.summary.length > 500) return null;
    const allowedFacts = new Set(snapshot.factCodes);
    const allowedEvidenceNumbers = new Set([
        snapshot.budget, snapshot.essentialBudget, snapshot.spent, snapshot.remaining,
        snapshot.daysElapsed, snapshot.daysRemaining, snapshot.safeSpendPerDay,
        snapshot.inventoryAtRiskValue, snapshot.transactionCount,
        ...snapshot.facts.flatMap(fact => Object.values(fact.evidence).filter(Number.isFinite))
    ].filter(Number.isFinite));
    const highlights = Array.isArray(candidate.highlights) ? candidate.highlights.slice(0, 3) : [];
    const actions = Array.isArray(candidate.actions) ? candidate.actions.slice(0, 3) : [];
    if (highlights.some(item => !allowedFacts.has(item?.factCode)
        || typeof item.message !== 'string'
        || (item.evidenceNumbers !== undefined && (!Array.isArray(item.evidenceNumbers)
            || item.evidenceNumbers.some(value => !Number.isFinite(value) || !allowedEvidenceNumbers.has(value)))))) return null;
    const allowedActions = new Set(snapshot.facts.flatMap(fact => fact.allowedActions));
    if (actions.some(item => !allowedActions.has(item?.actionCode)
        || typeof item.title !== 'string' || typeof item.reason !== 'string'
        || (item.estimatedImpact !== undefined && item.estimatedImpact !== null
            && (!Number.isFinite(item.estimatedImpact) || !allowedEvidenceNumbers.has(item.estimatedImpact))))) return null;
    const forbidden = /(?:đầu tư|vay tiền|chẩn đoán|điều trị)/i;
    if (forbidden.test(`${candidate.headline} ${candidate.summary}`)) return null;
    return { tone: candidate.tone, headline: candidate.headline, summary: candidate.summary, highlights, actions };
};

module.exports = { KNOWLEDGE_CARDS, hashSnapshot, detectFacts, createSnapshot, fallbackInsight, validateInsight, clamp };
