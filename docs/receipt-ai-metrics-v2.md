# Đo hóa đơn v2

Không thay model Transaction/Item. Dòng có `sourceLineId` chỉ truyền cùng draft và lưu trong metrics. Một operation quét có thể trả nhiều draft: cùng attemptId nhưng draftId riêng; xác nhận ghép đúng `(userId,operationId,selectedAttemptId,draftId)`.

## Dữ liệu

`payload.receipt.raw` là bản AI trước chuẩn hóa; `predicted` là bản chuẩn hóa được đề xuất; `reference` là bản lưu thành công. Header gồm merchantName/date/totalAmount/discount/category; dòng gồm sourceLineId/rawName/itemName/quantity/unit/unitPrice/lineTotal và thông tin phân loại/định lượng. Snapshot giới hạn 200 dòng, tên 300 ký tự. Không ảnh/base64/prompt.
Mỗi dòng còn giữ measurementStatus và warningCodes lấy từ normalizer `warnings[].code` (gộp với codes đã có, chống trùng, tối đa 30). measurementBasis là object `{scope:PER_PURCHASE_UNIT|TOTAL,quantity,unit:G|ML|PIECE,evidence}` với evidence tối đa 200 ký tự, lưu khi có cấu trúc hợp lệ. Đây là provenance để phân biệt định lượng đã xác nhận/còn phải kiểm tra và truy nguyên phép quy đổi; không đưa trạng thái/warning/basis vào mẫu số accuracy để tránh coi thông tin kiểm tra bổ sung là lỗi OCR.
Nếu bản gốc có hơn 200 dòng, snapshot đánh dấu truncated/originalItemCount; chất lượng trả N/A và missingFields=SNAPSHOT_TRUNCATED, không chấm trên phần bị cắt để tạo điểm đẹp. Đây chỉ là giới hạn telemetry, không giới hạn lưu giao dịch.

Client chỉ gửi lifecycle, local ML Kit attempt và RESULT_PRESENTED metadata `{draftId,payload:{receipt:{selectedAttemptId}}}`; không được gửi snapshot AI hoặc final label qua endpoint telemetry. Final snapshot do backend ghi sau commit. Batch endpoint dùng chung với công tơ; logic công tơ giữ nguyên.

Confirmation tới sớm giữ MISSING_ATTEMPT; attempt tới muộn được đối soát theo queue tuần tự operation trong process. Không lấy response mới nhất hoặc ghép index draft. `AI_METRICS_ENABLED=false` tắt v2. 202 vẫn chỉ nhận vào RAM, không xác nhận lưu bền vững; cần công bố coverage.

## Phép đo

- Ghép dòng một-một theo sourceLineId, giữ danh tính khi người dùng sửa tên/đảo thứ tự. Không gộp dòng trùng tên. Khi thiếu ID, chỉ fallback tên chuẩn hóa bằng nhau; hai ID khác nhau không ghép theo tên.
- TP là dòng còn giữ trong final; FP dòng AI thừa/bị xóa; FN dòng user bổ sung. Precision/recall/F1 **đánh giá sự hiện diện dòng**, không chứng minh mọi trường trong dòng đều đúng.
- `fieldAccuracyPct`: đúng/mẫu số gồm trường có dữ liệu ở ít nhất một phía. Header merchantName/date/totalAmount/discount; dòng itemName/quantity/unit/unitPrice/lineTotal/standardQuantity/standardUnit. Trường bị bỏ sót, dòng thêm và dòng xóa đều vào mẫu số. Category, hạn dùng, nơi bảo quản không bị coi là lỗi OCR.
- `evaluation.fieldResults.<tên trường>.total/correct` lưu mẫu số và số đúng riêng cho quantity/unitPrice/lineTotal/standardQuantity/standardUnit và các trường còn lại. `lineTotal` snapshot lấy từ `totalPrice` của normalized draft, fallback `lineTotal` của raw draft.
- `evaluation.measureErrors` lưu count/absoluteErrorSum/mae riêng G, ML, PIECE, chỉ khi cả hai phía dùng cùng đơn vị. Đổi đơn vị, thiếu lượng hoặc đơn vị khác không được trộn vào MAE; lỗi unit vẫn bị tính trong field accuracy. Khi tổng hợp nhiều draft phải sum(error)/sum(count) theo unit, không trung bình các MAE draft.
- `amountExactMatch/amountAbsoluteError`: tổng tiền đúng tuyệt đối/sai lệch VND, không tolerance để làm đẹp phép đo.
- `nameEditDistance/nameReferenceLength/nameKsrPct`: Levenshtein tên item ghép, dòng thiếu tính công nhập cả tên, dòng thừa tính công xóa. KSR=100*(1-distance/referenceLength), có thể âm. Đây là proxy tối thiểu công sửa, không số phím thực.
- `rawFieldAccuracyPct`: cùng phép đo trên bản trước chuẩn hóa để so tác động rule. Đây là mức khớp representation nghiệp vụ với final, **không phải độ chính xác OCR nguyên văn**: tên chuẩn, đơn vị và phép quy đổi định lượng có thể khác có chủ đích. Không coi chênh lệch là cải thiện model AI hoặc lỗi nhận dạng ký tự.
- Mẫu số 0 hoặc thiếu cặp trả N/A, không trả 100%.
- Reference USER_CONFIRMED chỉ là dữ liệu user chốt, muốn độ chính xác thật phải kiểm tra lại ảnh độc lập.

## Truy vấn mongosh mẫu

```javascript
const filter = {userId:ObjectId('507f1f77bcf86cd799439011'),feature:'RECEIPT',schemaVersion:2,
  occurredAt:{$gte:ISODate('2026-10-01T00:00:00+07:00'),$lt:ISODate('2026-11-01T00:00:00+07:00')}};
db.aimetrics.aggregate([
  {$match:{...filter,eventType:'USER_CONFIRMED','dataQuality.pairingStatus':'PAIRED','evaluation.receiptEvaluable':true}},
  {$group:{_id:null,drafts:{$sum:1},tp:{$sum:'$evaluation.truePositives'},fp:{$sum:'$evaluation.falsePositives'},fn:{$sum:'$evaluation.falseNegatives'},fields:{$sum:'$evaluation.fieldCount'},correctFields:{$sum:'$evaluation.correctFieldCount'},meanNameKsrPct:{$avg:'$evaluation.nameKsrPct'},meanMoneyError:{$avg:'$evaluation.amountAbsoluteError'}}}
]);
// Provider count must deduplicate attempt: metadata repeats across sibling drafts.
db.aimetrics.aggregate([
  {$match:{...filter,eventType:'ATTEMPT_COMPLETED',origin:'SERVER'}},
  {$group:{_id:{operation:'$operationId',attempt:'$attemptId'},providerCalls:{$max:'$providerAttempts'},durationMs:{$max:'$timings.processingMs'},cacheHit:{$first:'$cacheHit'}}},
  {$group:{_id:null,requests:{$sum:1},providerCalls:{$sum:'$providerCalls'},meanDurationMs:{$avg:'$durationMs'}}}
]);
db.aimetrics.aggregate([
  {$match:{...filter,eventType:'USER_CONFIRMED'}},
  {$group:{_id:'$dataQuality.pairingStatus',count:{$sum:1}}}
]);
// Sai lệch định lượng: giữ từng đơn vị, mẫu số đúng theo số dòng.
db.aimetrics.aggregate([
  {$match:{...filter,eventType:'USER_CONFIRMED','dataQuality.pairingStatus':'PAIRED','evaluation.receiptEvaluable':true}},
  {$unwind:'$evaluation.measureErrors'},
  {$group:{_id:'$evaluation.measureErrors.unit',count:{$sum:'$evaluation.measureErrors.count'},errorSum:{$sum:'$evaluation.measureErrors.absoluteErrorSum'}}},
  {$set:{mae:{$divide:['$errorSum','$count']}}}
]);
```

Cache hits providerCalls=0, thời gian lấy cache khác thời gian gọi model. Các latency phải ghi theo phạm vi thực tế; không cộng latency các sibling drafts thành thời gian quét.
