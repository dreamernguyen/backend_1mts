# AiMetrics v2: công tơ và form các chức năng AI

Không thay model nghiệp vụ. V1 được giữ để bill/recipe/insight hiện tại không đổi hành vi. Form v2 đã có meter/receipt/recipe/insight; các feature khác cần tích hợp evaluator riêng, chưa tự động có điểm accuracy.

## Sự kiện và nguồn sự thật

### Batch và số lần OCR thật

`POST /api/ai-metrics/events/batch` nhận `{events:[...]}` (1–20 events, tổng JSON <=256 KiB, từng event <=16 KiB). Toàn batch được validate rồi giữ chỗ hàng đợi trước khi nhận, không nhận từng phần. Trả `202 {success:true,accepted:true,acceptedEventIds:[...],durable:false}`: accepted chỉ là hàng đợi RAM, không xác nhận đã ghi MongoDB. Retry giữ nguyên eventId, upsert idempotent. Burst quota tính số event, không số HTTP request.

`ATTEMPT_STARTED` được phát ngay trước mỗi lời gọi ML Kit native, với attemptId riêng, stage ORIGINAL/CROP. Đếm distinct attemptId của event này để có số gọi thực, kể cả bị hủy sau khi đã gọi nhưng không có kết quả. LOCAL_SELECTION chỉ là tổng hợp candidate, không phải một lời gọi native và không được phát ATTEMPT_STARTED. OPERATION_CANCELLED không xóa started attempts.

Trong một backend process, write và reconcile được nối tuần tự theo `(userId,operationId)`; giữa các operation vẫn song song. Confirmation tới trước attempt sẽ được đối soát khi attempt ghi xong. Cơ chế này không phải distributed lock giữa nhiều instance; unique event index vẫn chống ghi trùng giữa instance. Log còn có thể mất khi restart trước ghi.

### Độ giống đề xuất và công nhập liệu (evaluator meter-2.2)

Đây là phép so **đề xuất chuẩn hóa trước sửa** với **giá trị người dùng lưu**, không phải CER OCR:

- `proposalCharacterEvaluable`: có hai chuỗi hợp lệ, nhất quán với giá trị số nếu có.
- `proposalEditDistance`: Levenshtein trên chuỗi chuẩn hóa; `proposalLength`, `finalLength` là hai mẫu số được lưu.
- `proposalSimilarityPct = 100*(1-distance/max(proposalLength,finalLength))`.
- `ksrPct = 100*(1-distance/finalLength)`: proxy công sửa so với gõ từ đầu, có thể âm; không cắt ngưỡng để làm đẹp điểm.
- `ksrReasonCode=EDIT_DISTANCE_PROXY`, `ksrReferenceSource=USER_CONFIRMED`: không phải số phím thực hoặc thời gian tiết kiệm đo được.
- Khi attempt đã kết thúc rõ ràng **không có đề xuất** (readingValue=null, readingText=null/rỗng), người dùng nhập số cuối: KSR=0, reason `NO_PROPOSAL_MANUAL_ENTRY`.
- Missing attempt/pair không được coi như đề xuất rỗng, KSR vẫn N/A cho tới ghép được. Raw CER vẫn cần nhãn ảnh vật lý riêng như phần dưới.
- Nhập tay không có selectedAttemptId chỉ KSR=0 khi caller xác nhận rõ `noProposal=true`, inputSource=MANUAL và không có chuỗi/giá trị dự đoán. Nhóm này pairingStatus=MANUAL, source `MANUAL_CONFIRMED_NO_PROPOSAL`, tách khỏi nhóm thiếu attempt. Không suy luận từ log bị mất.

```javascript
// Trung bình theo lượt và proxy gộp theo độ dài, cùng số lượng cặp đủ dữ liệu.
db.aimetrics.aggregate([
  {$match:{...filter,eventType:'USER_CONFIRMED',evaluatorVersion:'meter-2.2','dataQuality.pairingStatus':'PAIRED','evaluation.proposalCharacterEvaluable':true}},
  {$group:{_id:'$meterType',samples:{$sum:1},meanSimilarityPct:{$avg:'$evaluation.proposalSimilarityPct'},meanKsrPct:{$avg:'$evaluation.ksrPct'},edits:{$sum:'$evaluation.proposalEditDistance'},finalCharacters:{$sum:'$evaluation.finalLength'}}},
  {$set:{aggregateKsrPct:{$multiply:[100,{$subtract:[1,{$divide:['$edits','$finalCharacters']}]}]}}}
]);
```
Chạy sau khi khai báo `filter` ở phần truy vấn bên dưới. Không gộp cặp thiếu vào mẫu số.

- `operationId`: một lần chọn ảnh. `attemptId`: lần ML Kit/Gemini. `eventId`: retry phải giữ nguyên.
- Client: OPERATION_STARTED, ATTEMPT_COMPLETED (chỉ ML_KIT), RESULT_PRESENTED, OPERATION_CANCELLED.
- Server: ATTEMPT_COMPLETED Gemini, USER_CONFIRMED sau commit.
- POST `/api/ai-metrics/events`, Firebase Bearer; backend lấy user từ token. 202 chỉ nghĩa được nhận vào hàng đợi, không cam kết đã ghi bền vững.
- Mỗi payload <=16 KiB, tối đa 8 candidate, 12 reason/warning, ID <=160. Không ảnh/base64/prompt.
- Unique index `(userId,eventId)` chỉ áp dụng schemaVersion=2. Hai lần ghi cùng event chỉ tạo một document. Không xóa dữ liệu cũ.
- Hàng đợi tối đa 100 công việc, một retry sau 100ms. Có counter failed/dropped; không có outbox bền vững. Restart/mất mạng có thể mất log, phải công bố coverage.
- `AI_METRICS_ENABLED=false` tắt ghi v2. Endpoint giới hạn 120 sự kiện/phút/tài khoản trong process; không phải distributed limiter.
- Reconcile chỉ chạy khi attempt hoặc confirmation đến, ghép đúng selectedAttemptId, không lấy response mới nhất. MISSING_ATTEMPT nghĩa chưa ghép được; chưa chứng minh OCR sai. Khi attempt tới muộn sẽ đối soát lại.

## Cách tính

### Ba lớp dữ liệu (evaluator meter-2.1)

`payload.meter` giữ riêng:

1. `rawReadingText/rawReadingValue`: chuỗi/kết quả OCR gốc, ví dụ `0012345` và `12345`. Không ghi đè khi rule thêm dấu thập phân hoặc người dùng chọn chip.
2. `readingText/readingValue`: đề xuất chuẩn hóa, ví dụ `001234.5` và `1234.5`, đi kèm `normalizationReasons`. Đây là số pipeline đưa ra trước chỉnh sửa người dùng.
3. `referenceText/referenceValue`: giá trị người dùng thực sự lưu. Backend ghi sau commit.

Các `suggestions` tối đa 2 có source OCR/HISTORY; `selectedSuggestionSource` ghi OCR/HISTORY/MANUAL. Thao tác chọn gợi ý ghi RESULT_PRESENTED mới, cùng selectedAttemptId, không thay raw result hoặc biến lựa chọn người dùng thành OCR đúng. Reconcile sao chép raw và proposal từ attempt được chọn vào confirmation, thay vì tin snapshot client gửi khi lưu.

Ví dụ OCR đọc `0012345`, rule đề xuất `1234.5`, user chọn `123.45`: sai lệch pipeline = `|1234.5−123.45|`, không chấm lại proposal thành `123.45` để đạt 100%.

Với record có raw provenance, `evaluation.numericEvaluable/exactNumericMatch/absoluteError` đánh giá đề xuất chuẩn hóa so với số lưu. CER cũ không được tính từ đề xuất đã thêm dấu thập phân sang text người dùng. `rawCharacterEvaluable=false` khi thiếu nhãn vật lý; không coi thiếu nhãn là lỗi OCR. Chỉ tính `rawEditDistance/rawReferenceLength/rawCerPct` khi người kiểm tra độc lập đọc chuỗi trên ảnh, lưu `physicalReferenceText` và `physicalReferenceSource=IMAGE_REVIEW`. Endpoint client không nhận các trường nhãn vật lý này. Chưa có UI/endpoint gán nhãn ảnh trong phạm vi hiện tại.

Các record v2 cũ không có raw provenance giữ phép đo CER cũ để tương thích; khi so sánh báo cáo cần tách evaluatorVersion và không gộp CER v2.0 với rawCER v2.1.

`evaluation` trên USER_CONFIRMED đánh giá kết quả cuối. Trên ATTEMPT_COMPLETED đánh giá từng engine cùng nhãn xác nhận. Không cộng hai nhóm thành số lượt quét.
ML Kit có các pass ORIGINAL/CROP và LOCAL_SELECTION. Muốn đánh giá bộ đọc local cuối, lọc `stage=LOCAL_SELECTION`; không gộp các pass thành ba lượt người dùng. Dữ liệu confirmation do client gửi không được chấm cho tới khi ghép attempt.

- numericEvaluable chỉ khi cả hai giá trị hữu hạn, >=0. 0 hợp lệ.
- absoluteError=abs(dự đoán−xác nhận), exactNumericMatch=(error===0).
- CER=editDistance/referenceLength*100. Không có chuỗi gốc thì N/A, không chuyển số thành text để giả lập OCR.
- Chuẩn hóa chuỗi: bỏ unit/khoảng trắng, dấu phẩy thành chấm, bỏ 0 đệm đầu. Giữ dấu thập phân và 0 sau dấu thập phân. CER có thể >100%.
- `referenceSource=USER_CONFIRMED` là proxy, không nhãn độc lập. Muốn báo độ chính xác thật phải kiểm tra ảnh.

## Truy vấn mongosh (đổi user/ngày thành dữ liệu của bạn)

```javascript
const filter = {
  userId: ObjectId('507f1f77bcf86cd799439011'),
  feature: 'METER_OCR', schemaVersion: 2,
  occurredAt: { $gte: ISODate('2026-10-01T00:00:00+07:00'), $lt: ISODate('2026-11-01T00:00:00+07:00') }
};
// Số lượt bắt đầu; fallback không tạo thêm lượt.
db.aimetrics.aggregate([
  {$match: {...filter, eventType:'OPERATION_STARTED'}},
  {$group:{_id:'$operationId'}}, {$count:'operations'}
]);
// Chỉ kết quả cuối, chỉ cặp đã ghép, tách điện/nước.
db.aimetrics.aggregate([
  {$match:{...filter,eventType:'USER_CONFIRMED','dataQuality.pairingStatus':'PAIRED','evaluation.numericEvaluable':true}},
  {$group:{_id:'$meterType',samples:{$sum:1},matches:{$sum:{$cond:['$evaluation.exactNumericMatch',1,0]}},mae:{$avg:'$evaluation.absoluteError'},maxError:{$max:'$evaluation.absoluteError'}}},
  {$set:{exactMatchPct:{$multiply:[100,{$divide:['$matches','$samples']}]}}}
]);
// CER gộp đúng theo số ký tự, không trung bình tỷ lệ từng ảnh.
db.aimetrics.aggregate([
  {$match:{...filter,eventType:'USER_CONFIRMED','dataQuality.pairingStatus':'PAIRED','evaluation.characterEvaluable':true}},
  {$group:{_id:'$meterType',samples:{$sum:1},edits:{$sum:'$evaluation.editDistance'},characters:{$sum:'$evaluation.referenceLength'}}},
  {$set:{cerPct:{$multiply:[100,{$divide:['$edits','$characters']}]}}}
]);
// OCR raw v2.1 chỉ khi đã có nhãn vật lý độc lập; thường N/A trước khi gán nhãn.
db.aimetrics.aggregate([
  {$match:{...filter,eventType:'USER_CONFIRMED',evaluatorVersion:{$in:['meter-2.1','meter-2.2']},'dataQuality.pairingStatus':'PAIRED','evaluation.rawCharacterEvaluable':true}},
  {$group:{_id:'$meterType',samples:{$sum:1},edits:{$sum:'$evaluation.rawEditDistance'},characters:{$sum:'$evaluation.rawReferenceLength'}}},
  {$set:{rawCerPct:{$multiply:[100,{$divide:['$edits','$characters']}]}}}
]);
// Chất lượng ghép cặp; PENDING không đưa vào accuracy đã kiểm chứng.
db.aimetrics.aggregate([
  {$match:{...filter,eventType:'USER_CONFIRMED'}},
  {$group:{_id:'$dataQuality.pairingStatus',count:{$sum:1}}}
]);
// Thời gian đến preview, tách nền tảng. P50/P95 chỉ dùng nếu Atlas/Mongo hỗ trợ $percentile.
db.aimetrics.aggregate([
  {$match:{...filter,eventType:'RESULT_PRESENTED','timings.timeToPreviewMs':{$type:'number'}}},
  {$group:{_id:'$platform',count:{$sum:1},averageMs:{$avg:'$timings.timeToPreviewMs'},maxMs:{$max:'$timings.timeToPreviewMs'}}}
]);
// Coverage và số lượt gọi AI: gom theo operation, không đếm pass như lượt quét.
db.aimetrics.aggregate([
  {$match:filter},
  {$group:{_id:'$operationId',started:{$max:{$cond:[{$eq:['$eventType','OPERATION_STARTED']},1,0]}},confirmed:{$max:{$cond:[{$eq:['$eventType','USER_CONFIRMED']},1,0]}},paired:{$max:{$cond:[{$and:[{$eq:['$eventType','USER_CONFIRMED']},{$eq:['$dataQuality.pairingStatus','PAIRED']}]},1,0]}},aiUsed:{$max:{$cond:[{$and:[{$eq:['$eventType','ATTEMPT_COMPLETED']},{$eq:['$engine','GEMINI']}]},1,0]}}}},
  {$group:{_id:null,observedOperations:{$sum:1},started:{$sum:'$started'},confirmed:{$sum:'$confirmed'},paired:{$sum:'$paired'},aiOperations:{$sum:'$aiUsed'}}}
]);
// Tỷ lệ xác nhận không sửa số (proxy STP công tơ, không phải accuracy độc lập).
db.aimetrics.aggregate([
  {$match:{...filter,eventType:'USER_CONFIRMED','dataQuality.pairingStatus':'PAIRED','evaluation.numericEvaluable':true}},
  {$group:{_id:'$operationId',unchanged:{$max:{$cond:['$evaluation.exactNumericMatch',1,0]}}}},
  {$group:{_id:null,evaluableOperations:{$sum:1},unchanged:{$sum:'$unchanged'}}},
  {$set:{unchangedPct:{$multiply:[100,{$divide:['$unchanged','$evaluableOperations']}]}}}
]);
```

Không chạy các truy vấn này tự động. Collection thực tế kiểm tra bằng `show collections`; Mongoose mặc định tạo `aimetrics`.
