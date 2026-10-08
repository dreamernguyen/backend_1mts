const crypto = require('node:crypto');
const mongoose = require('mongoose');
const moment = require('moment-timezone');
const finance = require('./finance.service');
const rpg = require('./rpg.service');
const VERSION = 'guest-v1';
const demoId = (userId, kind, key) => new mongoose.Types.ObjectId(crypto.createHash('sha256')
    .update(`${userId}:${VERSION}:${kind}:${key}`).digest('hex').slice(0,24));

function buildDemoJournal(userId, data, instant = new Date()) {
    const user = data.userFields, txs = data.transactions;
    const balance = finance.balanceFromTransactions(user, txs);
    const cycle = finance.cycleDates(user.cycleStartDay, instant);
    const unpaid = user.finance.fixedCycles.flatMap(c=>finance.fixedState(c.plans,txs,c.key))
        .reduce((sum,cost)=>sum+cost.remaining,0);
    const stock = data.items.filter(item=>item.usageStatus==='ACTIVE'&&item.quantity>0);
    const days = item=>moment(item.expiryDate).tz(finance.TZ).startOf('day')
        .diff(moment(instant).tz(finance.TZ).startOf('day'),'days');
    const value = list=>list.reduce((sum,item)=>sum+rpg.inventoryValue(item,instant),0);
    const expired = stock.filter(item=>item.expiryDate&&days(item)<0);
    const soon = stock.filter(item=>item.expiryDate&&days(item)>=0&&days(item)<=3);
    const stats = data.stats || rpg.calculateRpgState({cashBalance:balance.cash,balanceInitialized:true,
        unpaidFixedCosts:unpaid,essentialBudget:user.essentialBudget,savingsFund:balance.savings,
        daysRemaining:cycle.daysRemaining,totalCycleDays:cycle.totalDays,
        inventoryValue:value(stock),expiredInventoryValue:value(expired),soonExpiringInventoryValue:value(soon),
        bonusWis:user.rpgStats?.bonusWis||0,calculatedAt:instant});
    const money = n=>Math.round(n).toLocaleString('vi-VN')+' đ';
    const titles = { hp:'Kho thực phẩm hỗ trợ ngân sách ăn uống', mana:'Cân đối tiền chi tiêu đến cuối kỳ',
        def:'Giữ riêng quỹ dự phòng', wis:'Theo dõi sử dụng thực phẩm và hạn dùng' };
    const summaries = {
        hp:`Kho còn ${money(value(stock))} thực phẩm ghi nhận · HP ${stats.hp}/100`,
        mana:`Còn ${money(stats.mana)} linh hoạt cho ${cycle.daysRemaining} ngày; ${money(unpaid)} dành cho khoản cố định.`,
        def:`Quỹ dự phòng ${money(balance.savings)} · DEF ${stats.def}/100. Cất riêng, đừng nhập chung tiền đi chợ nha!`,
        wis:`WIS ${stats.wis}/100 · Kiểm tra ${expired.length+soon.length} lô sắp/đã quá hạn; hỏng thì bỏ, đừng đổi tiền thực phẩm thành tiền thuốc nha!`
    };
    const logs = ['hp','mana','def','wis'].map(stat=>({
        _id:demoId(userId,'log',stat),userId,type:'OTHER',title:titles[stat],
        xpChange:0,hpChange:0,manaChange:0,defChange:0,wisChange:0,createdAt:instant,
        metadata:{demo:true,demoVersion:VERSION,demoEventKey:stat,formulaVersion:stats.formulaVersion,
            statCode:stat.toUpperCase(),statValue:stats[stat],
            demoSummary:summaries[stat]}
    }));
    const lastRent = [...txs].filter(tx=>tx.fixedPayment?.code==='RENT').sort((a,b)=>b.date-a.date)[0];
    const lastMarket = [...txs].filter(tx=>tx.category==='MARKET').sort((a,b)=>b.date-a.date)[0];
    for(const [key,tx,label] of [['rent',lastRent,'Đã thanh toán tiền trọ kỳ trước'],['market',lastMarket,'Đi chợ mua nhiều nguyên liệu']]){
        if(tx)logs.push({_id:demoId(userId,'log',key),userId,type:'TRANSACTION',title:label,
            createdAt:tx.date,metadata:{demo:true,demoEventKey:key,transactionId:tx._id,
                demoSummary:tx.items?.length ? `${money(tx.amount)} · ${tx.items.length} dòng hàng: ${[...new Set(tx.items.map(item=>item.itemName))].join(', ')}` : money(tx.amount)}});
    }
    logs.push({_id:demoId(userId,'log','expiry'),userId,type:'OTHER',title:'Kiểm tra thực phẩm sắp và đã quá hạn',createdAt:instant,
        metadata:{demo:true,demoEventKey:'expiry',demoSummary:`${expired.length+soon.length} lô cần kiểm tra: ${[...new Set([...expired,...soon].map(item=>item.itemName))].slice(0,3).join(', ')}. Kiểm tra hạn trên bao bì và bảo quản; không chắc còn an toàn thì bỏ nha chủ nhân.`}});
    const notices = [
        ['cash','SYSTEM','Cappy nhắc giữ ví',`Có ${money(balance.cash)} tiền mặt nhưng ${money(unpaid)} đã có nhiệm vụ lo khoản cố định. Còn ${money(stats.mana)} linh hoạt cho ${cycle.daysRemaining} ngày, giỏ hàng chill một nhịp nha chủ nhân!`],
        ['expiry','EXPIRY_WARNING','Tủ lạnh không phải bảo tàng',`Có ${expired.length+soon.length} lô sắp/đã quá hạn ghi nhận. Kiểm tra bao bì và bảo quản trước khi dùng; hỏng hoặc không chắc thì bỏ, đừng tiếc rồi tốn tiền thuốc nha.`],
        ['def','GAMIFICATION','Quỹ dự phòng có nhiệm vụ riêng',`${money(balance.savings)} quỹ dự phòng được giữ riêng; chủ nhân đừng nhầm với tiền shopping nha!`],
        ['cook','SYSTEM','Nấu ăn tại nhà thuii',`Tủ đang có ${[...new Set(stock.map(item=>item.itemName))].slice(0,3).join(', ')}. Qua tab Nấu ăn kiểm tra nguyên liệu rồi trổ tài, healthy và balance cả bữa ăn lẫn ví nhé!`]
    ];
    for(const type of ['POWER','WATER']){
        const latest=[...(data.readings||[])].filter(row=>row.meterType===type).sort((a,b)=>b.readingDate-a.readingDate)[0];
        if(latest && !latest.transactionId)notices.push([type,'SYSTEM',`Tiền ${type==='POWER'?'điện':'nước'} tháng này chưa thanh toán`,
            `Đã dùng ${latest.usage} ${latest.unit==='KWH'?'kWh':'m³'}, dự kiến ${money(latest.estimatedCost)}. Xem công-tơ và xác nhận tiền thực trả trước khi lưu giao dịch nha.`]);
    }
    const notifications = notices.map(([key,type,title,message],i)=>({_id:demoId(userId,'notification',key),userId,
        title,message,type,isRead:i===2||i===3,createdAt:instant}));
    return {logs,notifications};
}
module.exports={buildDemoJournal};
