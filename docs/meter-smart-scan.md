# Bàn giao công tơ thông minh và AiMetrics v2

## Điều chỉnh sau thử ảnh thực tế — 02/10/2026

- Điều chỉnh UX mới: không phân loại/chặn ảnh sai loại điện/nước; người dùng tự đối chiếu. Gemini chỉ đọc số. Toàn form tối đa hai tag cảnh báo, chạm/hover xem tooltip, không mở dialog cảnh báo.
- Ngân sách toàn lượt quét 30 giây; fallback Gemini bật mặc định, chỉ chạy khi local chưa đủ bằng chứng. Không phải mọi lượt đều phải chờ đủ 30 giây.
- Candidate OCR tối thiểu 3 chữ số, giữ số 0 đầu; không giới hạn số nhỏ người dùng nhập tay.
- Điện cơ có bằng chứng mẫu 5 số nguyên + 1 số hàng 1/10 được chuẩn hóa dấu thập phân. Không tự chia 10 mọi chuỗi điện sáu chữ số; nước không cố định độ dài.
- AiMetrics lưu raw OCR, đề xuất chuẩn hóa và số người dùng chốt riêng; không biến việc chọn gợi ý thành đọc đúng ban đầu. CER raw chỉ tính khi có nhãn đọc ảnh độc lập.
- UI có tips nhập chỉ số độc lập với dòng “Hoặc kết quả có thể là:” và tối đa hai tag ngắn. Không tự làm tròn để tính tiền.
- Không chạy kiểm thử/biên dịch cho đợt điều chỉnh này theo yêu cầu người dùng. Các kết quả kiểm chứng bên dưới thuộc bản trước, không chứng minh bản mới đã được kiểm chứng. Chưa deploy hay thay đổi dữ liệu production.

## Luồng đã triển khai

1. Chọn/chụp ảnh, hiển thị trạng thái xử lý với nút nhập tay và hủy.
2. Kiểm tra ảnh rất nhỏ, không giải mã được hoặc không có chi tiết. Độ sáng chỉ tạo cảnh báo; chưa dùng ngưỡng mờ chưa được hiệu chỉnh để chặn ảnh.
3. Trên Android/iOS: ML Kit đọc ảnh gốc, lọc serial/thông số, giữ chuỗi và vị trí các ứng viên. Đơn vị gần vùng số hỗ trợ xếp hạng. Chỉ crop và đọc thêm khi kết quả chưa rõ.
4. Đối chiếu lịch sử để cảnh báo số giảm. Không tự thêm chữ số đầu, không tự sửa dấu thập phân chỉ để số phù hợp lịch sử.
5. Kết quả local rõ thì mở bản nháp ngay. Nếu mơ hồ và còn thời gian, xác minh Gemini một lần. Web/desktop không có ML Kit dùng AI trực tiếp. Candidate gửi lên là bằng chứng chưa xác minh; AI được yêu cầu đọc ảnh độc lập.
6. Gemini có thể đổi model một lần khi lỗi tạm thời, dùng chung deadline. Không gọi lại vì ảnh không đọc được. Hết thời gian/lỗi thì người dùng kiểm tra ảnh, chụp lại hoặc nhập tay.
7. Người dùng xác nhận trước khi ghi nghiệp vụ. Chuẩn bị ảnh lưu chạy song song; chỉ thao tác lưu mới chờ bước này. Cách tính sản lượng, đơn giá, tiền và model MeterReading giữ nguyên.
8. Metrics chạy độc lập, không được phép làm thất bại giao dịch. Một lần chọn ảnh có một operation; các pass và fallback có attempt riêng. Confirmation chỉ được chấm sau khi ghép đúng attempt đã hiển thị.

Ví dụ: kỳ trước 1200, OCR thấy 215 và 1215. 215 bị cảnh báo thấp hơn lịch sử; hệ thống không biến 215 thành 1215. Nếu ảnh chứng minh 1215 rõ, dùng kết quả đó. Nếu Gemini đọc 1275, bản nháp giữ số từ ảnh AI và yêu cầu người dùng kiểm tra; người dùng chốt 1215 thì sai số AI là 60. Cả local và AI có thể được đối chiếu với cùng số đã chốt.

## Thời gian và cách bật/tắt

- Ngân sách xử lý ứng dụng: 30 giây; đây là giới hạn chờ logic, không phải bảo đảm mọi thiết bị phản hồi trong 30 giây. Local tối đa 12 giây, Gemini tối đa 10 giây trong ngân sách còn lại.
- Local có ngân sách riêng để dành thời gian xác minh; chỉ crop khi cần. Chọn ảnh và thời gian người dùng sửa/xác nhận không thuộc thời gian xử lý AI.
- Backend AI dùng ngân sách còn lại, tối đa 10 giây, abort provider khi quá hạn. Client bỏ kết quả đến muộn sau hủy; HTTP client hiện chưa hủy request đang chạy tức thì.
- Flutter dart-define: `METER_SMART_SCAN_ENABLED`, `METER_AUTO_VERIFY_ENABLED`, `AI_METRICS_ENABLED` mặc định true. Hai cờ đầu kiểm soát tự xác minh trên nền tảng có local OCR; Web vẫn cần AI để quét.
- `METER_SCAN_BUDGET_MS` mặc định 30000, dùng để cấu hình ngân sách quét khi benchmark; thời gian backend vẫn bị giới hạn tối đa 10 giây.
- Backend `AI_METRICS_ENABLED=false` tắt ghi v2. Không đổi hosting, không thêm dịch vụ trả phí, không huấn luyện model.
- Hãy triển khai backend hỗ trợ v2 trước bản app mới. Bản app cũ vẫn sử dụng metrics v1 tương thích.

## Đánh giá và giới hạn

Các chỉ số đã có cho công tơ: exact numeric match, sai số tuyệt đối/MAE qua aggregate, CER, thời gian tới bản nháp/xác nhận, nguồn local/AI, các pass/fallback, lỗi và trạng thái ghép cặp. Schema đã có form cho receipt, recipe và insight; chưa tích hợp evaluator v2 cho các chức năng đó.

Không gọi tỷ lệ bấm lưu không sửa là độ chính xác độc lập. Số người dùng chốt là nhãn tham chiếu; cần kiểm tra ảnh để báo cáo accuracy thật. Không có bộ đếm thao tác phím nên chưa tuyên bố KSR thực đo. Metrics chưa có outbox bền vững: mất mạng/restart có thể thiếu log; công bố coverage và loại cặp thiếu khỏi accuracy.

Kiểm thử tự động dùng dữ liệu/mock, không gọi Gemini hay database thật. Cần thử Android/iOS với ảnh công tơ thực để xác minh camera, xoay ảnh, crop, plugin ML Kit, độ chính xác, P50/P95 và quota/model AI thực tế. Ngưỡng xếp hạng là rule, chưa phải xác suất confidence đã hiệu chỉnh.

## Checklist nghiệm thu trên thiết bị

- Ảnh rõ chỉ chạy local; ảnh mơ hồ tối đa một lần xác minh tự động.
- Serial gần số, số bắt đầu 0, dấu phẩy/chấm, chỉ số 0, số thấp hơn kỳ trước.
- Ảnh trống, quá nhỏ, phản sáng, tối, xoay ngang; hướng dẫn chụp lại phải dễ thấy.
- Hủy/nhập tay khi local hoặc AI đang chạy; kết quả muộn không thay số nhập.
- Gemini lỗi/hết quota/hết giờ: giữ bằng chứng local và không tạo vòng retry UI.
- Lưu một lần/retry lưu không tạo trùng nghiệp vụ; lỗi metrics không chặn lưu.
- Lọc đúng tài khoản và thời gian; kiểm tra confirmation PAIRED và số operation, không đếm từng pass như lượt quét.

Truy vấn mẫu và quy tắc mẫu số: [ai-metrics-v2.md](ai-metrics-v2.md).

## Kết quả kiểm chứng tự động

- Backend: `node --test --test-reporter=spec` — 171/171 đạt.
- Flutter: `flutter test --reporter expanded` — 90/90 đạt.
- Dart analyze 10 file OCR/công tơ thay đổi — không có issue.
- Analyze toàn bộ `lib test` không có error; còn 3 warning ngoài phạm vi tại `finance_statistics_screen.dart` (2 biến chưa dùng) và `transaction_confirm_dialog.dart` (dead code).
- `flutter build web --no-pub` — thành công. Dry run Wasm cảnh báo `image_picker_for_web` dùng `dart:html`; bản Web JavaScript vẫn build được.
- Không chạy migration hay truy vấn database production, không commit/push/deploy. Schema chỉ bổ sung AiMetrics; cấu hình database hiện tại có autoIndex, nên khi deploy cần xác minh unique partial index v2 đã tạo thành công để bảo đảm chống trùng.
