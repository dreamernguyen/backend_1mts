const crypto = require('crypto');

const STAT_ORDER = ['HP', 'MANA', 'DEF', 'WIS'];

const KNOWLEDGE_CARDS = {
    HP_UNCONFIGURED: 'Chưa đủ cấu hình ngân sách thiết yếu để đánh giá nguồn lực sinh tồn.',
    HP_VIRTUAL_HIGH: 'Cảnh báo máu ảo: HP đầy nhưng tủ lạnh trống. Hãy chuyển hóa MANA thành lương thực dự trữ thay vì ăn ngoài!',
    HP_CRITICAL_DEF_AVAILABLE: 'BÁO ĐỘNG ĐỎ! Sinh mệnh cạn kiệt, nhưng bạn vẫn còn Quỹ dự phòng. Hãy cân nhắc "Phá giáp" để duy trì sự sống!',
    HP_LOW: 'HP đang ở mức nguy hiểm. Hãy thắt lưng buộc bụng và tập trung vào nhu cầu sinh tồn tối thiểu.',
    HP_STABLE: 'Nguồn lực thiết yếu hiện đủ cho kế hoạch trong kỳ, hãy tiếp tục theo dõi chi tiêu.',
    MANA_UNCONFIGURED: 'Chưa có ngân sách linh hoạt để ước tính Mana.',
    MANA_EMPTY_HP_DRAINING: 'Bình MANA đã cạn! Mọi khoản chi tiêu không thiết yếu lúc này sẽ rút trực tiếp máu (HP) của bạn.',
    MANA_LOW: 'Năng lượng linh hoạt đang rất thấp, hãy hạn chế ăn ngoài và giải trí.',
    MANA_STABLE: 'Nguồn lực chi tiêu linh hoạt đang ở mức dồi dào, bạn có thể tự thưởng cho mình.',
    DEF_UNCONFIGURED: 'Chưa có ngân sách thiết yếu để quy đổi mức quỹ dự phòng.',
    DEF_LOW: 'Quỹ dự phòng (Giáp) còn mỏng, chưa đủ sức chống chịu rủi ro lớn.',
    DEF_STABLE: 'Giáp dự phòng đang rất vững chắc.',
    WIS_WASTE: 'Có lãng phí thực phẩm được ghi nhận. Dùng đồ quá hạn sẽ bị trừ điểm Trí tuệ.',
    WIS_STABLE: 'Bạn đang quản lý tài nguyên tốt, không có khoản phạt lãng phí.',
    INSUFFICIENT_DATA: 'Dữ liệu chưa đầy đủ, nhận định chỉ mang tính định hướng.'
};

const hashSnapshot = snapshot => crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');

const factForStat = (stat, value, status, breakdown, rpgStats) => {
    if (status && status.startsWith('UNCONFIGURED')) return `${stat}_UNCONFIGURED`;
    
    if (stat === 'HP') {
        const required = (breakdown || []).find(item => item.code === 'REQUIRED_SURVIVAL_FUNDS')?.value || 0;
        const inventory = (breakdown || []).find(item => item.code === 'USABLE_INVENTORY_VALUE')?.value || 0;
        
        if (value >= 90 && required > 0 && (inventory / required) < 0.1) {
            return 'HP_VIRTUAL_HIGH';
        }
        
        const defValue = Number(rpgStats?.def) || 0;
        if (value < 30 && defValue > 50) {
            return 'HP_CRITICAL_DEF_AVAILABLE';
        }
        
        return Number(value) < 50 ? 'HP_LOW' : 'HP_STABLE';
    }
    
    if (stat === 'MANA') {
        const hpValue = Number(rpgStats?.hp) || 0;
        const requiredHoldCash = (breakdown || []).find(item => item.code === 'REQUIRED_HOLD_CASH')?.value || 0;
        
        if (value <= 0 && hpValue < 90) {
            return 'MANA_EMPTY_HP_DRAINING';
        }
        if (value <= 100) {
            return Number(value) < 50 ? 'MANA_LOW' : 'MANA_STABLE';
        }
        const isManaLow = requiredHoldCash > 0 ? value < (requiredHoldCash * 0.2) : value < 500000;
        return isManaLow ? 'MANA_LOW' : 'MANA_STABLE';
    }

    if (stat === 'WIS') {
        const penalty = (breakdown || []).find(item => item.code === 'WASTE_PENALTY')?.value || 0;
        return penalty > 0 ? 'WIS_WASTE' : 'WIS_STABLE';
    }
    
    return Number(value) < 50 ? `${stat}_LOW` : `${stat}_STABLE`;
};

const createSnapshot = rpgStats => {
    const breakdown = rpgStats?.statBreakdown || {};
    const stats = STAT_ORDER.map(stat => {
        const key = stat.toLowerCase();
        let value = Number(rpgStats?.[key]) || 0;
        // MANA là giá trị tuyệt đối (VND), không clamp. Các chỉ số khác % thì clamp 0-100.
        if (stat !== 'MANA') {
            value = Math.max(0, Math.min(100, value));
        }
        const status = breakdown?.status?.[key] || 'INSUFFICIENT_DATA';
        const factors = Array.isArray(breakdown?.[key]) ? breakdown[key] : [];
        const evidence = Object.fromEntries(factors
            .filter(item => item && typeof item.code === 'string' && Number.isFinite(Number(item.value)))
            .map(item => [item.code, Number(item.value)]));
        return { stat, value: Math.round(value), status, factCode: factForStat(stat, value, status, factors, rpgStats), evidence };
    });
    const snapshot = {
        formulaVersion: rpgStats?.formulaVersion || 'rpg_v3',
        calculatedAt: breakdown?.calculatedAt || null,
        dataCoverage: Number(rpgStats?.dataCoverage) || 0,
        stats
    };
    snapshot.factCodes = [...new Set([
        ...stats.map(item => item.factCode),
        ...(snapshot.dataCoverage < 1 ? ['INSUFFICIENT_DATA'] : [])
    ])];
    return snapshot;
};

const formatVnd = value => `${new Intl.NumberFormat('vi-VN').format(Math.max(0, Math.round(Number(value) || 0)))}đ`;

const fallbackMessageFor = item => {
    const evidence = item.evidence || {};
    switch (item.stat) {
        case 'HP': {
            if (item.factCode === 'HP_UNCONFIGURED') return KNOWLEDGE_CARDS.HP_UNCONFIGURED;
            const daily = Number(evidence.DAILY_ESSENTIAL_NEED) || 0;
            const days = Number(evidence.DAYS_REMAINING) || 0;
            const freeCash = Number(evidence.FREE_CASH) || 0;
            const inventory = Number(evidence.USABLE_INVENTORY_VALUE) || 0;
            const resource = freeCash + inventory;
            const pace = daily > 0 ? `Mức chi thiết yếu tham chiếu là ${formatVnd(daily)}/ngày` : 'Chưa có mức chi thiết yếu theo ngày';
            const detailText = `(Tiền mặt: ${formatVnd(freeCash)} + Lương thực: ${formatVnd(inventory)})`;
            return item.factCode === 'HP_LOW'
                ? `${pace}. Tổng nguồn lực ${formatVnd(resource)} ${detailText} cho ${days} ngày còn lại, nên ưu tiên khoản thiết yếu.`
                : `${pace}. Tổng nguồn lực ${formatVnd(resource)} ${detailText} hiện đủ để theo kế hoạch ${days} ngày còn lại.`;
        }
        case 'MANA': {
            if (item.factCode === 'MANA_UNCONFIGURED') return KNOWLEDGE_CARDS.MANA_UNCONFIGURED;
            const manaVnd = Number(evidence.MANA_VND ?? evidence.FLEXIBLE_REMAINING) || 0;
            const freeCash = Number(evidence.FREE_CASH ?? evidence.FLEXIBLE_BUDGET) || 0;
            return item.factCode === 'MANA_LOW'
                ? `Mana (Quỹ linh hoạt) của bạn hiện chỉ còn ${formatVnd(manaVnd)}; hãy cẩn trọng với các khoản chi không cần thiết.`
                : `Tiền mặt tự do hiện có là ${formatVnd(freeCash)}, trong đó Mana (Quỹ linh hoạt) dồi dào ở mức ${formatVnd(manaVnd)}! Hãy giữ vững phong độ.`;
        }
        case 'DEF': {
            if (item.factCode === 'DEF_UNCONFIGURED') return KNOWLEDGE_CARDS.DEF_UNCONFIGURED;
            const savings = Number(evidence.SAVINGS_FUND) || 0;
            const essential = Number(evidence.ESSENTIAL_BUDGET) || 0;
            return item.factCode === 'DEF_LOW'
                ? `Quỹ dự phòng ${formatVnd(savings)} còn thấp so với ngân sách thiết yếu ${formatVnd(essential)}; tích lũy dần khi phù hợp.`
                : `Quỹ dự phòng ${formatVnd(savings)} đang hỗ trợ tốt so với ngân sách thiết yếu ${formatVnd(essential)}.`;
        }
        case 'WIS': {
            const penalty = Number(evidence.WASTE_PENALTY) || 0;
            return item.factCode === 'WIS_WASTE'
                ? `WIS đang chịu ${penalty.toFixed(0)} điểm phạt từ thực phẩm bị lãng phí; ưu tiên dùng đồ còn hạn, tuyệt đối không dùng thực phẩm quá hạn.`
                : 'Bạn chưa có khoản phạt lãng phí đáng kể; tiếp tục kiểm tra hạn dùng để duy trì WIS.';
        }
        default:
            return KNOWLEDGE_CARDS.INSUFFICIENT_DATA;
    }
};

const fallbackInsight = snapshot => ({
    headline: 'Giải mã Sinh Tồn',
    summary: snapshot.dataCoverage < 1
        ? 'Một số chỉ số chưa đủ dữ liệu; hãy kiểm tra cấu hình ngân sách và giao dịch.'
        : 'Các chỉ số được tính từ ngân sách, giao dịch, quỹ dự phòng và kho thực phẩm còn dùng được.',
    statMessages: snapshot.stats.map(item => ({
        stat: item.stat,
        factCode: item.factCode,
        message: fallbackMessageFor(item)
    }))
});

const validateInsight = (candidate, snapshot) => {
    if (!candidate || typeof candidate !== 'object') return null;
    if (typeof candidate.headline !== 'string' || candidate.headline.length < 3 || candidate.headline.length > 100) return null;
    if (typeof candidate.summary !== 'string' || candidate.summary.length > 300) return null;
    if (!Array.isArray(candidate.statMessages) || candidate.statMessages.length !== STAT_ORDER.length) return null;
    const allowedFacts = new Set(snapshot.factCodes);
    const seenStats = new Set();
    for (const item of candidate.statMessages) {
        if (!STAT_ORDER.includes(item?.stat) || seenStats.has(item.stat)
            || !allowedFacts.has(item.factCode) || typeof item.message !== 'string'
            || item.message.length < 3 || item.message.length > 280) return null;
        const expected = snapshot.stats.find(stat => stat.stat === item.stat)?.factCode;
        if (item.factCode !== expected) return null;
        seenStats.add(item.stat);
    }
    const content = `${candidate.headline} ${candidate.summary} ${candidate.statMessages.map(item => item.message).join(' ')}`
        .replace(/không\s+(?:ăn|dùng)\s+(?:thực phẩm\s+)?quá hạn/gi, '');
    const forbidden = /(?:ăn|dùng)\s+(?:thực phẩm\s+)?quá hạn|đầu tư|vay tiền|chẩn đoán|điều trị/i;
    if (forbidden.test(content)) return null;
    return {
        headline: candidate.headline,
        summary: candidate.summary,
        statMessages: candidate.statMessages.map(item => ({ stat: item.stat, factCode: item.factCode, message: item.message }))
    };
};

module.exports = { STAT_ORDER, KNOWLEDGE_CARDS, hashSnapshot, createSnapshot, fallbackInsight, validateInsight, fallbackMessageFor };
