# Metrics công tơ: gửi theo nhóm (phương án 2)

Phạm vi: công tơ điện/nước. Không thay thuật toán đọc ảnh, không đổi model nghiệp vụ, không áp dụng sang hóa đơn/món ăn/insight.

## Luồng

1. Bắt đầu quét: tạo `operationId`, giữ sự kiện trong RAM client.
2. Mỗi lần thực sự gọi OCR native: ghi `ATTEMPT_STARTED` (ORIGINAL/CROP). Kết quả local được ghi riêng; `LOCAL_SELECTION` là chọn kết quả, không phải một lần gọi ML Kit nữa.
3. Nếu fallback Gemini: dùng API nhận diện hiện có; server ghi số request provider thực tế, kể cả retry/lỗi. Không thêm API metrics vào đường chờ OCR.
4. Frame kết quả đầu tiên được hiển thị: ghi `RESULT_PRESENTED/PREVIEW`, lấy `timeToPreviewMs`, gửi nhóm metrics nền. Đây là thời gian từ bắt đầu quét đến frame kết quả, không phải riêng thời gian Gemini.
5. Lưu: API lưu chỉ số hiện có ghi `USER_CONFIRMED` sau khi nghiệp vụ lưu thành công. Hủy/nhập tay/quét lại/đóng: ghi trạng thái phù hợp và kích hoạt gửi phần còn lại. Không gửi từng lần gõ.
6. Server ghép `selectedAttemptId` với kết quả gốc đã chọn rồi tính chất lượng. Việc lưu/ghép của cùng một operation được xử lý nối tiếp để tránh lệch thứ tự.

## Giao thức và giới hạn

`POST /ai-metrics/events/batch`, body `{ "events": [...] }`: tối đa 20 sự kiện, 256 KB; từng sự kiện tối đa 16 KB. Kiểm tra toàn bộ nhóm trước khi đưa vào hàng đợi. Retry giữ nguyên eventId; unique index chống ghi trùng. Endpoint từng sự kiện cũ vẫn được giữ tương thích.

Client giữ tối đa 64 sự kiện trong RAM; gửi nối tiếp, tối đa 2 lần thử mỗi nhóm. Nhóm chưa được chấp nhận được giữ để gửi lại ở lần flush sau. Không có hàng đợi bền vững trên thiết bị. HTTP 202 chỉ xác nhận đã nhận vào hàng đợi server, không bảo đảm MongoDB đã ghi. Tắt app/server đột ngột hoặc lỗi kéo dài có thể thiếu dữ liệu; không tự suy ra những lượt thiếu là hủy.

## Chỉ số cho báo cáo

- Chất lượng: chỉ dùng lượt đã lưu và ghép được cặp; tách POWER/WATER. Độ chính xác số = số đề xuất bằng số lưu / số mẫu đánh giá số. MAE = trung bình `absoluteError`, điện kWh, nước m³.
- Ký tự của **đề xuất chuẩn hóa**: `proposalEditDistance` là số thao tác chèn/xóa/thay tối thiểu (Levenshtein); trung bình số này cho biết lượng sửa. `proposalSimilarityPct = 100 × (1 − khoảng cách / max(độ dài đề xuất, độ dài số lưu))`.
- KSR gộp = `100 × (1 − tổng proposalEditDistance / tổng finalLength)`. Đây là ước lượng tiết kiệm thao tác theo khoảng cách chuỗi, không phải đếm phím người dùng thực sự bấm. Có thể âm nếu sửa khó hơn nhập mới. Báo kèm số mẫu ký tự; không thay dữ liệu thiếu bằng 0.
- Chuỗi bỏ đơn vị, khoảng trắng và số 0 đệm đầu; giữ dấu thập phân. CER của chuỗi OCR gốc là phép đo riêng, chỉ có khi có nhãn ảnh độc lập.
- Vận hành: số operation; số lượt đã lưu/hủy/chưa rõ kết thúc; tỷ lệ ra đề xuất; thời gian preview trung bình; tổng/ trung bình lần gọi ML Kit từ ATTEMPT_STARTED; lượt dùng Gemini và số provider request thực tế; lỗi/timeout; tỷ lệ ghép đủ dữ liệu.

Không lấy mọi document làm số lượt quét: một operation có nhiều sự kiện. Dữ liệu cũ không có ATTEMPT_STARTED không đủ để tính chính xác số lần OCR native.

## Compass: chất lượng đề xuất chuẩn hóa

Dán pipeline sau vào Aggregations của `aimetrics`. Thêm userId/khoảng ngày vào `$match` để lấy đúng tập thực nghiệm. Chỉ dùng evaluator mới; không có dữ liệu thì không có dòng kết quả.

```json
[
  { "$match": { "feature": "METER_OCR", "schemaVersion": 2, "eventType": "USER_CONFIRMED", "evaluatorVersion": "meter-2.2", "dataQuality.pairingStatus": "PAIRED" } },
  { "$group": {
    "_id": "$meterType",
    "savedSamples": { "$sum": 1 },
    "numericSamples": { "$sum": { "$cond": ["$evaluation.numericEvaluable", 1, 0] } },
    "exactSamples": { "$sum": { "$cond": ["$evaluation.exactNumericMatch", 1, 0] } },
    "mae": { "$avg": "$evaluation.absoluteError" },
    "characterSamples": { "$sum": { "$cond": ["$evaluation.proposalCharacterEvaluable", 1, 0] } },
    "meanEdits": { "$avg": "$evaluation.proposalEditDistance" },
    "meanSimilarityPct": { "$avg": "$evaluation.proposalSimilarityPct" },
    "totalEdits": { "$sum": "$evaluation.proposalEditDistance" },
    "totalFinalCharacters": { "$sum": "$evaluation.finalLength" }
  } },
  { "$set": {
    "needsCorrectionSamples": { "$subtract": ["$numericSamples", "$exactSamples"] },
    "exactPct": { "$cond": [{ "$gt": ["$numericSamples", 0] }, { "$multiply": [100, { "$divide": ["$exactSamples", "$numericSamples"] }] }, null] },
    "ksrPct": { "$cond": [{ "$gt": ["$totalFinalCharacters", 0] }, { "$multiply": [100, { "$subtract": [1, { "$divide": ["$totalEdits", "$totalFinalCharacters"] }] }] }, null] }
  } }
]
```

## Compass: vận hành theo lượt

Chỉ chọn khoảng ngày sau khi cập nhật cả client/server; thêm userId vào `$match`. `unfinishedOperations` gồm thiếu dữ liệu hoặc chưa kết thúc, không mặc định là hủy. Lượt đã lưu ưu tiên trạng thái đã lưu dù trước đó dừng OCR để nhập tay. Thời gian chỉ trung bình những lượt thực sự có frame preview.

```json
[
  { "$match": { "feature": "METER_OCR", "schemaVersion": 2, "operationId": { "$type": "string" } } },
  { "$group": {
    "_id": { "operation": "$operationId", "type": "$meterType" },
    "started": { "$max": { "$cond": [{ "$eq": ["$eventType", "OPERATION_STARTED"] }, 1, 0] } },
    "saved": { "$max": { "$cond": [{ "$eq": ["$eventType", "USER_CONFIRMED"] }, 1, 0] } },
    "cancelled": { "$max": { "$cond": [{ "$eq": ["$eventType", "OPERATION_CANCELLED"] }, 1, 0] } },
    "mlKitCalls": { "$sum": { "$cond": [{ "$and": [{ "$eq": ["$eventType", "ATTEMPT_STARTED"] }, { "$eq": ["$engine", "ML_KIT"] }] }, 1, 0] } },
    "geminiRequests": { "$sum": { "$cond": [{ "$and": [{ "$eq": ["$eventType", "ATTEMPT_COMPLETED"] }, { "$eq": ["$engine", "GEMINI"] }] }, { "$ifNull": ["$providerAttempts", 0] }, 0] } },
    "previewMs": { "$max": { "$cond": [{ "$and": [{ "$eq": ["$eventType", "RESULT_PRESENTED"] }, { "$eq": ["$stage", "PREVIEW"] }] }, "$timings.timeToPreviewMs", null] } }
  } },
  { "$match": { "started": 1 } },
  { "$group": {
    "_id": "$_id.type",
    "scanOperations": { "$sum": 1 },
    "savedOperations": { "$sum": "$saved" },
    "cancelledOperations": { "$sum": { "$cond": [{ "$and": [{ "$eq": ["$saved", 0] }, { "$eq": ["$cancelled", 1] }] }, 1, 0] } },
    "unfinishedOperations": { "$sum": { "$cond": [{ "$and": [{ "$eq": ["$saved", 0] }, { "$eq": ["$cancelled", 0] }] }, 1, 0] } },
    "mlKitCalls": { "$sum": "$mlKitCalls" },
    "meanMlKitCallsPerScan": { "$avg": "$mlKitCalls" },
    "geminiRequests": { "$sum": "$geminiRequests" },
    "meanGeminiRequestsPerScan": { "$avg": "$geminiRequests" },
    "geminiOperations": { "$sum": { "$cond": [{ "$gt": ["$geminiRequests", 0] }, 1, 0] } },
    "previewSamples": { "$sum": { "$cond": [{ "$isNumber": "$previewMs" }, 1, 0] } },
    "meanPreviewMs": { "$avg": "$previewMs" }
  } }
]
```

Nhập tay sau khi hủy quét, có `noProposal=true` và chuỗi cuối hợp lệ: KSR=0 nằm ở `pairingStatus=MANUAL`. Truy vấn chất lượng phía trên chỉ lấy cặp PAIRED; muốn tính tiết kiệm nhập liệu cho cả nhóm nhập tay này, thêm nhánh `$or` cho MANUAL + `payload.meter.noProposal=true` + `evaluation.proposalCharacterEvaluable=true`, và báo riêng số mẫu nhập tay. Không đưa nhóm nhập tay vào mẫu accuracy số/MAE.

Chưa chạy test/analyzer/build theo yêu cầu của chủ dự án. Các mô tả trên là hành vi triển khai; cần kiểm thử trên máy/app và đối chiếu document mới trước khi đưa số liệu vào báo cáo.
