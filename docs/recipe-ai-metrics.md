# aiMetrics gợi ý món ăn

Áp dụng từ `pipelineVersion: recipe-metrics-2`. Không migration dữ liệu cũ. Ba luồng: OVERVIEW (danh sách đề xuất/giải cứu, không tính món ngẫu nhiên), TODAY (Hôm nay ăn gì), RAG (tìm và điều chỉnh món bằng AI). Giữ thuật toán, model, kho và cơ chế trừ FEFO hiện có.

## Sự kiện và ý nghĩa

- Server ghi một `AI_RESPONSE` cho mỗi request kết thúc, bao gồm kho trống, không tìm thấy món, AI không qua validation/matcher, lỗi và thành công. `sessionId` nối request với hiển thị/nấu. Các request lỗi trước middleware xác thực không nằm trong mẫu.
- Snapshot ứng viên chứa `canCook`, điểm bao phủ nguyên liệu, khẩu phần khả thi, số nguyên liệu chính thiếu và số nguyên liệu cần xem lại. Các món xuất hiện cả đề xuất và giải cứu được khử trùng trong cùng request. `returnedRecipeIds` chỉ chứa món thực sự trả cho người dùng; ứng viên AI bị chặn vẫn được lưu riêng để kiểm tra.
- `providerAttempts`: số request Gemini thực tế, bao gồm thử model khác/retry. Không gọi Gemini ghi 0; thiếu metadata ghi null, không giả định 1. `modelLatencyMs` đo xử lý provider (có thể gồm đợi retry); `latencyMs` đo toàn bộ server đến lúc chuẩn bị gửi JSON, gồm retrieval/matching/lưu draft.
- Client gửi `RESULT_PRESENTED` sau khung hình tiếp theo, `timings.timeToPreviewMs` đo từ gọi API đến khung hình kết quả. Đây là thời gian phản hồi hiển thị ước lượng, không đo lúc mắt người dùng đọc. Request metrics gửi nền sau khi đo, không await trên luồng gợi ý. API batch hiện có trả 202 và hàng đợi RAM: metrics có thể thiếu nếu mạng lỗi/app tắt/server khởi động lại.
- Khi nấu thành công, server ghi `USER_CONFIRMED` nếu recipe có trong kết quả của session. Rank/source lấy từ snapshot server. Retry nấu đã replay không tạo thêm sự kiện. Đây là tương tác sử dụng, không phải nhãn xác nhận công thức chính xác. Chưa đo tỷ lệ nấu thành công trên mọi lần thử, vì chưa ghi mọi lần thử nấu thất bại.

## Chỉ số có thể đưa vào báo cáo

Vận hành: số lượt theo từng luồng, tỷ lệ có món trả về, tỷ lệ lỗi, thời gian server trung bình, thời gian hiển thị trung bình và số mẫu thời gian, tỷ lệ lượt cần Gemini, request Gemini/lượt (nêu mẫu có metadata).

Chất lượng khả dụng theo kiểm tra kho: số món đánh giá, tỷ lệ món đủ nguyên liệu để nấu, độ bao phủ nguyên liệu trung bình, tỷ lệ món cần xem lại nguyên liệu. Khẩu phần khả thi có trong snapshot để kiểm tra nhưng không nên trung bình giữa nhiều món rồi gọi là độ chính xác.

Tương tác: số session được người dùng sử dụng để nấu. Muốn kết luận độ chính xác thật của matching hoặc tính hợp lý của món cần bộ test có nhãn người đánh giá độc lập; số liệu tự kiểm tra kho không thay thế nhãn này.

## Truy vấn Compass

Chọn collection `aiMetrics`, tab Aggregations, Text mode. Có thể thêm userId/khoảng createdAt vào $match. Các số là dữ liệu mới sau nâng cấp; OVERVIEW, TODAY, RAG nên trình bày riêng vì luồng/tốc độ khác nhau.

```javascript
[
  {$match: {feature: 'RECIPE_SUGGEST', pipelineVersion: 'recipe-metrics-2'}},
  {$facet: {
    vanHanh: [
      {$match: {eventType: 'AI_RESPONSE'}},
      {$group: {_id: '$subFeature', soLuot: {$sum: 1},
        soLuotCoMon: {$sum: {$cond: [{$gt: ['$suggestionCount', 0]}, 1, 0]}},
        soLuotLoi: {$sum: {$cond: [{$eq: ['$resultStatus', 'ERROR']}, 1, 0]}},
        soLuotDungGemini: {$sum: {$cond: ['$usedAiFallback', 1, 0]}},
        soLuotCoSoRequest: {$sum: {$cond: [{$isNumber: '$providerAttempts'}, 1, 0]}},
        tongRequestGemini: {$sum: '$providerAttempts'},
        requestGeminiMoiLuot: {$avg: '$providerAttempts'},
        serverMsTrungBinh: {$avg: '$latencyMs'}}},
      {$set: {tyLeCoMonPct: {$multiply: [100, {$divide: ['$soLuotCoMon', '$soLuot']}]},
        tyLeLoiPct: {$multiply: [100, {$divide: ['$soLuotLoi', '$soLuot']}]},
        tyLeDungGeminiPct: {$multiply: [100, {$divide: ['$soLuotDungGemini', '$soLuot']}]},
        serverGiayTrungBinh: {$divide: ['$serverMsTrungBinh', 1000]}}}
    ],
    hienThi: [
      {$match: {eventType: 'RESULT_PRESENTED', 'timings.timeToPreviewMs': {$type: 'number'}}},
      {$group: {_id: '$stage', soMau: {$sum: 1}, msTrungBinh: {$avg: '$timings.timeToPreviewMs'}}},
      {$set: {giayTrungBinh: {$divide: ['$msTrungBinh', 1000]}}}
    ],
    chatLuong: [
      {$match: {eventType: 'AI_RESPONSE', resultStatus: {$ne: 'ERROR'}}},
      {$unwind: '$payload.recipe.candidates'},
      {$match: {$expr: {$and: [{$in: ['$payload.recipe.candidates.recipeId', '$payload.recipe.returnedRecipeIds']},
        {$in: ['$payload.recipe.candidates.canCook', [true, false]]}]}}},
      {$group: {_id: '$subFeature', soMonDanhGia: {$sum: 1},
        soMonDuNguyenLieu: {$sum: {$cond: ['$payload.recipe.candidates.canCook', 1, 0]}},
        baoPhuNguyenLieuPctTrungBinh: {$avg: '$payload.recipe.candidates.ingredientCoveragePercent'},
        soMonCanXemLai: {$sum: {$cond: [{$gt: ['$payload.recipe.candidates.reviewRequiredCount', 0]}, 1, 0]}}}},
      {$set: {tyLeDuNguyenLieuPct: {$multiply: [100, {$divide: ['$soMonDuNguyenLieu', '$soMonDanhGia']}]},
        tyLeCanXemLaiPct: {$multiply: [100, {$divide: ['$soMonCanXemLai', '$soMonDanhGia']}]}}}
    ],
    suDung: [
      {$match: {eventType: 'USER_CONFIRMED', cookSuccess: true}},
      {$group: {_id: {userId: '$userId', sessionId: '$sessionId'}}},
      {$count: 'soSessionDaDungDeNau'}
    ]
  }}
]
```

Mỗi lần trả danh sách là một mẫu vận hành; mỗi món trong danh sách là một mẫu khả dụng. Một món được đề xuất ở nhiều lượt được tính nhiều lần vì snapshot kho có thể thay đổi. Không gọi các tỷ lệ trên là accuracy AI hay đánh giá hương vị.

Kiểm thử thực tế: tải danh sách, bấm Hôm nay ăn gì, tìm RAG, thử kho trống, thử thiếu nguyên liệu, sau đó nấu một món. Kiểm tra mỗi response có một session, RESULT_PRESENTED có thời gian, cook nối đúng session và retry không tăng lượt nấu. Dữ liệu cũ không bổ sung lại được các snapshot/thời gian chưa đo.
