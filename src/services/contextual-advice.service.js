const crypto = require('node:crypto');
const { daysBetweenVietnamDates } = require('./vietnam-date.service');
const ACTIONS = ['OPEN_COOKING', 'REVIEW_TRANSACTIONS', 'CHECK_INVENTORY', 'REVIEW_BUDGET'];
const cache = new Map(), jobs = new Map();
function budgetGuide(stats) {
 const factor = (group, code) => Number(stats?.statBreakdown?.[group]?.find(i => i.code === code)?.value) || 0;
 const days = factor('hp', 'DAYS_REMAINING');
 const daily = factor('hp', 'DAILY_ESSENTIAL_NEED');
 const free = factor('mana', 'FREE_CASH');
 const hold = factor('mana', 'REQUIRED_HOLD_CASH');
 const mana = Math.max(0, Number(stats?.mana) || 0);
 const tomorrowNeed = daily * Math.max(1, days - 1);
 const tomorrowHold = Math.max(0, tomorrowNeed - Math.min(factor('hp', 'TOTAL_INVENTORY_VALUE'), tomorrowNeed));
 return { cashBalance: factor('hp', 'TOTAL_REMAINING_CASH'), unpaidFixedCosts: factor('hp', 'UNPAID_FIXED_COSTS'),
   totalInventoryEstimatedValue: factor('hp', 'TOTAL_INVENTORY_VALUE'), expiredInventoryEstimatedValue: factor('hp', 'EXPIRED_INVENTORY_VALUE'),
   inventoryContribution: factor('hp', 'USABLE_INVENTORY_VALUE'), requiredFoodFunds: factor('hp', 'REQUIRED_SURVIVAL_FUNDS'),
   savingsFund: factor('def', 'SAVINGS_FUND'), shortfall: factor('mana', 'SHORTFALL'),
   freeCashAfterFixed: free, foodCashToHold: hold, flexibleCash: mana,
   daysRemaining: days, foodReferencePerDay: daily,
   flexibleReferencePerDay: days > 0 ? Math.floor(mana / days) : null,
   transportReserve: null,
   possibleManaReleaseTomorrow: days > 1 ? Math.max(0, Math.max(0, free - tomorrowHold) - mana) : 0,
   scenarioCondition: 'Mô phỏng sang ngày: tiền mặt, giá trị kho, khoản cố định và cấu hình không đổi. Nấu ăn làm giảm kho; không coi đây là khoản tiết kiệm chắc chắn hoặc thưởng Mana.',
   allocationNote: 'Chưa có ngân sách xăng xe riêng. Nếu đề xuất chia quỹ, phải ghi là phương án dự trù, không phải thiết lập hay số tiền đã giữ.' };
}
function snapshot(stats, transactions, items, settings, now = new Date()) {
 const breakdown = stats?.statBreakdown || {};
 const { calculatedAt, ...factors } = breakdown;
 const recent = transactions.map(t => ({ id: String(t._id), date: t.date, description: t.description || t.note || '', category: t.category, amount: t.amount, transactionType: t.transactionType }));
 const inventory = items.map(i => ({ id: String(i._id), name: i.itemName, quantity: i.standardQuantity ?? i.quantity, unit: i.standardUnit || i.unit, storageLocation: i.storageLocation, expiryDate: i.expiryDate, expirySource: i.expirySource, estimatedValue: require('./rpg.service').inventoryValue(i, now), daysRemaining: i.expiryDate ? daysBetweenVietnamDates(now, i.expiryDate) : null }));
 const riskGroup = list => ({ estimatedValue: list.reduce((sum, i) => sum + i.estimatedValue, 0), count: list.length, examples: [...list].sort((a,b) => b.estimatedValue - a.estimatedValue).slice(0,3).map(i => ({ id:i.id, name:i.name, quantity:i.quantity, unit:i.unit, estimatedValue:i.estimatedValue, storageLocation:i.storageLocation })) });
 const inventoryRisk = {
   expired: riskGroup(inventory.filter(i => i.estimatedValue > 0 && i.daysRemaining !== null && i.daysRemaining < 0)),
   expiringSoon: riskGroup(inventory.filter(i => i.estimatedValue > 0 && i.daysRemaining !== null && i.daysRemaining >= 0 && i.daysRemaining <= 3)),
   note: 'Sắp hết hạn là hạn ghi nhận trong 0–3 ngày; quá hạn là ngày ghi nhận đã qua. Giá trị có nguy cơ hao hụt, không phải giá trị đã mất. Có thể cộng hai nhóm để nhắc tổng giá trị sắp/quá hạn, phải dùng đúng nhãn gộp.'
 };
 const byCategory = {};
 for (const t of recent) if (t.transactionType === 'EXPENSE') byCategory[t.category || 'OTHERS'] = (byCategory[t.category || 'OTHERS'] || 0) + Number(t.amount || 0);
 return { day: new Date(now.getTime() + 7 * 3600000).toISOString().slice(0,10), stats: { hp: stats?.hp, mana: stats?.mana, def: stats?.def, wis: stats?.wis, factors }, settings, survivalExplanation: breakdown.explanation || require('./survival-explanation.service').build(stats), budgetGuide: budgetGuide(stats), transactionWindow: 'Tối đa 15 giao dịch mới nhất trong 7 ngày; tổng mẫu không đại diện toàn bộ chi tiêu 7 ngày', recentTransactions: recent, sampleExpenseByCategory: byCategory, inventoryRisk, inventory };
}
function validate(value, context) {
 if (!value || typeof value !== 'object') return null;
 for (const [key, max] of Object.entries({ headline: 120, analysis: 2400, advice: 1400 })) if (typeof value[key] !== 'string' || value[key].length > max || value[key].trim().length < 3) return null;
 // This field is rebuilt from verified stock below, so its model length cannot
 // invalidate otherwise usable commentary. Still require the structured field.
 if (typeof value.inventoryReminder !== 'string') return null;
 const ids = new Set([...context.recentTransactions, ...context.inventory].map(i => i.id));
 if (!Array.isArray(value.evidenceIds) || value.evidenceIds.some(id => !ids.has(id)) || !ACTIONS.includes(value.actionCode)) return null;
 const result = Object.fromEntries(['headline','analysis','advice','inventoryReminder','evidenceIds','actionCode'].map(k=>[k,typeof value[k] === 'string' ? value[k].replace(/\bFREE_CASH\b/gi,'tiền sau khoản cố định').replace(/\bMANA_VND\b/gi,'quỹ linh hoạt').replace(/\bREQUIRED_HOLD_CASH\b/gi,'tiền giữ thêm cho ăn') : value[k]]));
 for (const key of ['headline', 'analysis', 'advice']) {
   for (const item of [...context.recentTransactions, ...context.inventory]) {
     if (/^[a-f0-9]{24}$/i.test(item.id)) result[key] = result[key].split(item.id).join(item.description || item.name || 'khoản đã ghi nhận');
   }
   if (/\b[a-f0-9]{24}\b/i.test(result[key])) return null;
 }
 // Counts, quantities and example values come from the same snapshot as RPG.
 // Let the model write the commentary, not re-invent inventory facts.
 result.inventoryReminder = inventoryReminder(context);
 result.evidenceIds = [...new Set(value.evidenceIds)].slice(0, 8);
 return result;
}
function inventoryReminder(context) {
 const risk = context.inventoryRisk;
 const count = Number(risk?.expired?.count || 0) + Number(risk?.expiringSoon?.count || 0);
 const total = Number(risk?.expired?.estimatedValue || 0) + Number(risk?.expiringSoon?.estimatedValue || 0);
 if (!count || total <= 0) return '';
 const money = value => {
   const thousands = Math.round(value / 1000);
   if (thousands >= 1000) {
     const tenths = Math.round(thousands / 100);
     return `${Math.floor(tenths / 10)} triệu${tenths % 10 ? ' ' + tenths % 10 : ''}`;
   }
   return thousands > 0 ? `${thousands}k` : `${Math.round(value)} đ`;
 };
 const riskItems = context.inventory?.filter(i => i.estimatedValue > 0 && i.daysRemaining !== null && i.daysRemaining <= 3);
 const candidates = riskItems?.length ? riskItems : [...(risk?.expired?.examples || []), ...(risk?.expiringSoon?.examples || [])];
 const seenNames = new Set();
 const examples = [...candidates].sort((a, b) => b.estimatedValue - a.estimatedValue)
   .filter(item => {
     const name = String(item.name || '').normalize('NFC').trim().toLocaleLowerCase('vi-VN');
     if (!name || seenNames.has(name)) return false;
     seenNames.add(name);
     return true;
   }).slice(0, 2);
 const quantity = item => {
   const q = Number(item.quantity), u = item.unit;
   if (!Number.isFinite(q) || q <= 0) return '';
   const units = { G: 'g', KG: 'kg', ML: 'ml', L: 'lít', PIECE: 'cái' };
   if (!units[u]) return '';
   const n = u === 'G' && q >= 1000 ? q / 1000 : u === 'ML' && q >= 1000 ? q / 1000 : q;
   const label = u === 'G' && q >= 1000 ? 'kg' : u === 'ML' && q >= 1000 ? 'lít' : units[u];
   return ` còn ${n.toLocaleString('vi-VN', { maximumFractionDigits: 2 })} ${label}`;
 };
 const detail = examples.length ? ' Ví dụ: ' + examples.map(i => `${i.name}${quantity(i)}, khoảng ${money(i.estimatedValue)}`).join('; ') + '.' : '';
 const quips = ['Tủ lạnh không phải bảo tàng thực phẩm đâu chủ nhân ơi!', 'Đồ ê hề mà bỏ quên thì chiếc ví khóc trước đó chủ nhân!', 'Đừng để đồ ăn chuyển hộ khẩu sang thùng rác nha chủ nhân!'];
 return `Có ${count} lô thực phẩm sắp/đã quá hạn ghi nhận, tổng giá trị khoảng ${money(total)}.${detail} ${quips[count % quips.length]} Kiểm tra hạn trên bao bì và lịch sử bảo quản; xác nhận còn dùng được thì ưu tiên nấu, hỏng hoặc không chắc thì đừng dùng, tiếc đồ rồi tốn tiền thuốc là lỗ kép đó nha.`;
}
function fallback(context) {
 const g = context.budgetGuide;
 const money = n => Math.round(Number(n || 0)).toLocaleString('vi-VN') + ' đ';
 const expenses = context.recentTransactions.filter(t=>t.transactionType==='EXPENSE' && Number(t.amount)>0);
 const top = [...expenses].sort((a,b)=>Number(b.amount)-Number(a.amount))[0];
 const total = expenses.reduce((sum,t)=>sum+Number(t.amount),0);
 const f=(group,code)=>Number(context.stats?.factors?.[group]?.find(x=>x.code===code)?.value)||0;
 const txText = top ? `Trong mẫu ${expenses.length} khoản chi gần đây, tổng chi là ${money(total)}; lớn nhất là “${top.description || 'khoản chưa có ghi chú'}” (${money(top.amount)}). ` : 'Chưa có giao dịch chi gần đây để đánh giá thói quen. ';
 const cashText = `Chủ nhân thấy ${money(g.cashBalance)} tiền mặt thì khoan mở giỏ hàng nha: ${money(g.unpaidFixedCosts)} đã có nhiệm vụ lo khoản cố định rồi. Cappy tính quỹ chi tiêu linh hoạt còn ${money(g.flexibleCash)} cho CẢ ${g.daysRemaining} ngày${g.flexibleReferencePerDay !== null ? ', tầm ' + money(g.flexibleReferencePerDay) + ' mỗi ngày' : ''}. Ví mỏng thế này, kèo trà sữa phải xếp hàng sau tiền đi lại nha! `;
 const foodText = `Kho ghi nhận ${money(g.totalInventoryEstimatedValue)}, so với nhu cầu ăn ${money(g.requiredFoodFunds)} cho ${g.daysRemaining} ngày. ${g.foodCashToHold>0 ? 'Cần giữ thêm '+money(g.foodCashToHold)+' tiền ăn.' : 'Theo giá trị quy đổi hiện tại, chưa cần giữ thêm tiền ăn; điều này phụ thuộc đồ trong kho thực sự dùng được.'}`;
 const wisText = f('wis','WASTE_PENALTY')>0 ? ` WIS ${context.stats.wis}/100, gồm ${f('wis','WASTE_PENALTY')} điểm trừ do thực phẩm đã vứt trong kỳ.` : '';
 const defText = ` Quỹ dự phòng ${money(g.savingsFund)} được giữ riêng, không cộng vào tiền linh hoạt.`;
 const risk = context.inventoryRisk;
 const riskValue = Number(risk?.expired?.estimatedValue||0)+Number(risk?.expiringSoon?.estimatedValue||0);
 const names = [...(risk?.expired?.examples||[]),...(risk?.expiringSoon?.examples||[])].slice(0,2);
 const reminder = inventoryReminder(context);
 const pressure = g.shortfall>0 ? `Đang thiếu ${money(g.shortfall)} so với định mức; hoãn chi tùy chọn, rà lại khoản cần thiết và cân nhắc quỹ dự phòng hoặc hỗ trợ phù hợp.` : g.foodCashToHold===0 && g.totalInventoryEstimatedValue>0 ? `Ưu tiên nấu từ đồ đã kiểm tra còn dùng được, giữ ${money(g.flexibleCash)} cho đi lại và phát sinh trong ${g.daysRemaining} ngày. Tủ lạnh chống lưng cho tiền ăn, chứ chưa trả hộ tiền xăng đâu chủ nhân ơi.` : `Giữ ${money(g.foodCashToHold)} cho ăn trước; cân đối phần linh hoạt ${money(g.flexibleCash)} trong ${g.daysRemaining} ngày, hoãn món chưa cần nếu quỹ hẹp.`;
 return {headline:'Giỏ hàng chill một nhịp, cho ví thở đã chủ nhân!',analysis:txText+cashText+'\n\n'+foodText+defText+wisText,advice:`1. ${pressure} Giữ phần thiết yếu trước, đừng để giỏ hàng chữa lành còn chiếc ví đi cấp cứu nha!\n\n2. Ưu tiên nấu tại nhà từ đồ còn dùng được; kho có gì thì xoay món đó. Healthy và balance cả bữa ăn lẫn ví, chứ tủ lạnh không đổ xăng hộ mình đâu.`,inventoryReminder:reminder,evidenceIds:[...(top?[top.id]:[]),...names.map(i=>i.id)].filter(id=>context.inventory.some(i=>i.id===id)||context.recentTransactions.some(i=>i.id===id)),actionCode: riskValue>0?'CHECK_INVENTORY':g.shortfall>0?'REVIEW_BUDGET':'REVIEW_TRANSACTIONS'};
}

async function resolve(userId, context, generate, refresh = false) {
 const key = PIPELINE_VERSION + ':' + userId + ':' + crypto.createHash('sha256').update(JSON.stringify(context)).digest('hex');
 const cached=cache.get(key);
 if (!refresh && cached?.expires > Date.now()) return {...cached.result, cached:true, providerMs:0};
 if (jobs.has(key)) return {...await jobs.get(key), shared:true};
 const job=(async()=>{
  let result={insight:fallback(context),fallbackUsed:true,providerMs:0};
  const started=Date.now();
  try {
   const ai=await generate(context); result.providerMs=Date.now()-started;
   let parsed;
   try { parsed = JSON.parse(String(ai.text).trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'')); }
   catch (_) { throw Object.assign(new Error('Output không phải JSON hợp lệ.'),{code:'INSIGHT_INVALID_JSON'}); }
   const validated=validate(parsed,context);
   if (!validated) {
    const knownIds = new Set([...context.recentTransactions, ...context.inventory].map(i=>i.id));
    console.warn('[Capy Insight validation]', {
      fields: Object.keys(parsed || {}),
      lengths: Object.fromEntries(['headline','analysis','advice','inventoryReminder'].map(k=>[k, typeof parsed?.[k] === 'string' ? parsed[k].length : null])),
      invalidTextFields: Object.entries({headline:120,analysis:2400,advice:1400}).filter(([k,max])=>typeof parsed?.[k]!=='string'||parsed[k].trim().length<3||parsed[k].length>max).map(([k])=>k),
      evidenceCount: parsed?.evidenceIds?.length,
      unknownEvidenceCount: Array.isArray(parsed?.evidenceIds) ? parsed.evidenceIds.filter(id=>!knownIds.has(id)).length : null,
      invalidAction: !ACTIONS.includes(parsed?.actionCode), actionCode: parsed?.actionCode
    });
   }
   result={...result,aiModel:ai.metadata?.model, providerMetadata:ai.metadata, errorCode:validated ? null : 'INVALID_INSIGHT', insight:validated || result.insight,fallbackUsed:!validated};
  } catch(error) { result.providerMs=Date.now()-started; result.providerMetadata=error.metadata; result.errorCode=error.code || 'AI_UNAVAILABLE'; }
  for(const [id,value] of cache) if(value.expires<=Date.now()) cache.delete(id);
  if(cache.size>=100) cache.delete(cache.keys().next().value);
  cache.set(key,{result,expires:Date.now()+(result.fallbackUsed ? 10000 : 300000)}); return {...result,cached:false};
 })(); jobs.set(key,job); try{return await job;}finally{jobs.delete(key);}
}
const instruction = `Bạn là Cappy, trợ lý tài chính sinh tồn Gen Z. Xưng Cappy, gọi người dùng chủ nhân 1–2 lần. Nhận xét giao dịch thật trong hoàn cảnh ngân sách, tiền thực có và số ngày còn lại; không tính lại số do backend cung cấp. Giao dịch lớn cần thiết như học phí/sửa xe phải đồng cảm, không quy là tiêu hoang. Mẫu tối đa 15 giao dịch mới nhất trong 7 ngày không phải toàn bộ lịch sử; phân biệt tổng mẫu với tổng kỳ.
Giọng mắng yêu hài hước: 1–2 câu chêm đúng tình thế, ví cần thở, giỏ hàng chữa lành còn ví cấp cứu, tủ lạnh không thanh toán được tiền xăng; có thể chill, ê hề, tín hịu SOS, healthy và balance. Không nhồi trend, xúc phạm, bịa mua online/nhậu/trà sữa; chỉ nói các khoản vui chơi như lựa chọn tương lai. Học EXAMPLES nhưng không sao chép dữ kiện hoặc ID.
Tiền sinh hoạt thực có khác tiền chi tiêu linh hoạt: khoản cố định và tiền cần giữ thêm cho ăn đã có nhiệm vụ, không được coi là dư để mua sắm. Chỉ gọi tiền trọ/điện/nước nếu fixedCosts xác nhận đúng loại. Phân bổ tính toán không đồng nghĩa tiền đã chuyển/cất thật. Quỹ dự phòng riêng, DEF là tỷ lệ với ngân sách ăn, không gọi DEF thấp là an toàn. Tổng kho khác phần kho được tính bù nhu cầu ăn; kho không phải tiền mặt hay bảo đảm đủ bữa. WIS điểm nền + thưởng tích lũy - phạt; điểm cộng trong kỳ riêng; tiền thực phẩm đã vứt khác điểm phạt. Không nói điểm tăng/giảm khi thiếu giá trị trước.
Tiền trong lời nói rút gọn kèm khoảng/tầm/gần: 288.352 đ là gần 2 trăm 9, 22.180 đ/ngày tầm hơn 2 chục MỖI NGÀY, 2.741.015 đ khoảng 2 triệu 7. Linh hoạt xen kẽ 230k, 2 trăm 3, gần 2 “lít” (khoảng 200k) hoặc 2 “củ” (2 triệu). “Lít” là trăm nghìn, “củ” là triệu; luôn đặt slang trong ngoặc nháy, kèm cách đọc rõ nếu dễ nhầm, không dùng 2 “lít” để thay chính xác 230k. Slang tiền tối đa 1–2 lần; không đổi số ngày, không gán dự trù cao hơn khả năng. Không đặt ngân sách xăng riêng hay hứa tiết kiệm chắc chắn. Không tư vấn đầu tư/vay nợ.
Nhóm sắp/quá hạn có giá trị toàn nhóm, 2 món chỉ là ví dụ, không gán tổng nhóm cho hai món. Hạn ghi nhận có thể dự kiến; xem storageLocation/expirySource, nhắc kiểm tra bao bì và lịch sử bảo quản. Chỉ gợi ý chế biến khi xác nhận còn dùng được; không chắc/hỏng thì không dùng, đừng tiếc rồi tốn tiền thuốc. Quá hạn ACTIVE chưa tự bị phạt WIS; vứt thực phẩm có thể bị phạt theo công thức. Gợi ý món từ tên, không khẳng định đủ nguyên liệu.
Trả JSON {headline,analysis,advice,inventoryReminder,evidenceIds,actionCode}. Tổng khoảng 180–230 từ. analysis hai đoạn ngắn: giao dịch nổi bật liên hệ tiền/ngày, rồi nguồn ăn và chỉ số đáng chú ý. Bắt buộc nêu TỔNG tiền linh hoạt cho CẢ số ngày còn lại, sau đó mới nói mức tham chiếu mỗi ngày, không cần viết hoa các nhãn trong phản hồi. Với 288.352 đ cho 13 ngày: gần 2 trăm 9 cho cả 13 ngày, tầm hơn 2 chục mỗi ngày; tuyệt đối không viết 2 chục cho 13 ngày. Chọn 1–2 giao dịch thật có ghi chú, ngày/số tiền và liên hệ với khoản cố định cần giữ, quỹ linh hoạt; không nhận xét chung chung rằng chi rải đều. advice có 2–3 mục đánh số xuống dòng riêng, không ép mục thứ ba nếu lặp với Nhắc tủ đồ. Tập trung giữ khoản cố định, dùng tổng quỹ cho số ngày còn lại, hạn chế chi tùy chọn và hướng nấu ở nhà; có câu mắng yêu. Chỉ dẫn kiểm tra hạn/chất lượng, giá trị nhóm và WIS/tiền thuốc chỉ đặt trong inventoryReminder. analysis chỉ nói kho đang chống lưng tiền ăn và có nhiều món cần ưu tiên, không nêu số tiền nhóm sắp/quá hạn, tên món hay hướng dẫn kiểm tra. inventoryReminder dành riêng cho tổng giá trị nhóm sắp/quá hạn, số món và 1–2 ví dụ, sau đó cách kiểm tra và hướng xử lý. Diễn đạt tự nhiên: Có khoảng N món sắp/đã quá hạn ghi nhận, tổng giá trị khoảng X. Hai ví dụ tiêu biểu là A còn lượng Y trị giá Z, và B còn lượng Y trị giá Z. Không thêm câu đây là tổng toàn bộ chứ không phải hai món. Lấy lượng còn lại từ quantity/unit trong inventory hoặc inventoryRisk.examples; đơn vị G có thể chia 1000 để nói ký/kg, ML chia 1000 để nói lít; không tự bịa khối lượng hoặc gom lô. Nếu thiếu lượng/đơn vị thì bỏ lượng, chỉ nêu tên và giá trị. Dùng 1 câu mắng yêu ngay trong nhắc kho, như đồ ê hề mà bỏ quên là ví khóc đó chủ nhân, tủ lạnh không phải bảo tàng thực phẩm; sau đó nhắc kiểm tra bảo quản, xác nhận còn dùng được thì ưu tiên nấu, hỏng thì bỏ, đừng cố ăn rồi tốn tiền thuốc. WIS chỉ nhắc ngắn nếu phù hợp, không đọc như quy định. Không lặp cùng câu/cảnh báo trong analysis, advice và inventoryReminder. Không liệt kê hết chỉ số, không xuất tên biến. evidenceIds tối đa 8 ID khác nhau lấy nguyên văn từ CURRENT_CONTEXT, không dùng tên món hoặc ID của EXAMPLES; actionCode OPEN_COOKING/CHECK_INVENTORY/REVIEW_TRANSACTIONS/REVIEW_BUDGET.`;
function compactContext(context) {
 const g=context.budgetGuide;
 const money=n=>Math.round(Number(n||0)).toLocaleString('vi-VN')+' đ';
 return {...context,
   transactionWindow:'Tối đa 15 giao dịch mới nhất trong 7 ngày, gồm thu và chi; tổng mẫu không phải tổng 7 ngày hoặc tổng kỳ',
   moneyHorizon:{totalFlexibleCash:g.flexibleCash,daysRemaining:g.daysRemaining,referencePerDay:g.flexibleReferencePerDay,
    totalStatement:`Tổng tiền chi tiêu linh hoạt ${money(g.flexibleCash)} cho CẢ ${g.daysRemaining} ngày còn lại`,
    dailyStatement:g.flexibleReferencePerDay===null?'Chưa có tham chiếu mỗi ngày':`Tham chiếu ${money(g.flexibleReferencePerDay)} MỖI NGÀY, không phải tổng quỹ`,
    note:'Không hoán đổi totalFlexibleCash và referencePerDay khi diễn đạt slang.'}};
}

function buildPrompt(context) {
 const compact=compactContext(context);
 const examples=require('../config/insight-fewshot.examples').selectExamples(compact);
 return JSON.stringify({instructions:'EXAMPLES là giả định để học cách lập luận và giọng; chỉ CURRENT_CONTEXT là dữ kiện thật. Các dòng survivalExplanation cùng nguồn với UI, không tính lại.',EXAMPLES:examples,CURRENT_CONTEXT:compact});
}
const PIPELINE_VERSION='cappy_context_v8';
module.exports={buildPrompt,compactContext,PIPELINE_VERSION,budgetGuide,snapshot,validate,fallback,resolve,instruction};
