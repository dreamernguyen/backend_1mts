# Nâng cấp hóa đơn → kho → so giá

## Trường dữ liệu

- `quantity`: số đơn vị mua, `unit`: gói/hộp/phần; `purchasePrice`: giá mỗi đơn vị mua.
- `standardQuantity`: tổng lượng chuẩn cả dòng; trong Item đây là lượng tồn hiện tại.
- `baseUnitPrice`: giá mua trên 1g/1ml/1 đơn vị đếm; giữ số thập phân, chỉ làm tròn khi hiển thị.
- `Transaction.items.totalPrice`: thành tiền thực tế lúc mua (trường tùy chọn mới). Dữ liệu cũ không cần migration.
- `gamificationRewards.priceComparisons`: bằng chứng so giá và nguồn tham chiếu (metadata tùy chọn mới).
- `Item` không đổi schema. sourceLineId, deliveryConfirmed và inventoryEligible chỉ đi qua draft/request/metrics, không thêm trường vào kho.

## Hành vi

AI đọc quan hệ cột/dòng và số liệu mua; backend đổi đơn vị, tính tổng, đối soát. Prompt phân biệt giá gạch ngang, điểm sử dụng, VAT có sẵn, voucher, quà tặng và định lượng mơ hồ.

Form hiển thị số lượng/giá theo đơn vị mua và tổng lượng. Sửa tên giữ nguyên thành tiền; thay số lượng/giá mới tính phần phụ thuộc. Hàng cân được đổi thành một phần mua, giữ tổng khối lượng và thành tiền. Phiếu/voucher vẫn giữ trong dòng tài chính để đối soát nhưng không tạo Item. Quà tặng thực phẩm chỉ nhập kho khi người dùng xác nhận đã nhận.

Chi tiết kho giữ riêng nhóm có giá/đơn vị mua khác nhau. Giá quy đổi tính từ lúc mua, không chia lại cho lượng còn trong kho.

## So giá và WIS

Đọc một truy vấn lịch sử giao dịch MARKET liên quan (tối đa 100 giao dịch, ngày mua không sau giao dịch hiện tại), chọn lần trước gần nhất đủ dữ liệu theo tên chuẩn/category/subCategory/đơn vị chuẩn. So sánh theo g/ml/PIECE; gom các dòng cùng danh tính trong một giao dịch bằng tổng tiền/tổng lượng. Không phân bổ voucher toàn bill. Không thưởng từ dòng miễn phí, định lượng cần kiểm tra hoặc tiền mâu thuẫn.

Thưởng giữ cơ chế bonusWis hiện có: một điểm cho mỗi nhóm nguyên liệu mua rẻ hơn, không theo số dòng trùng. Retry cùng idempotency key không ghi lại giao dịch/thưởng. Dữ liệu lịch sử cũ thiếu thành tiền dùng quantity × purchasePrice; không sửa lại giá cũ trong database. Chưa giải quyết việc phân biệt mọi phẩm cấp/sản phẩm cùng tên, hoặc chống người dùng tự nhập giá giả; đây là giới hạn của dữ liệu xác nhận.

## Metrics và tốc độ

Receipt v2 có operation/attempt/draft/line IDs; snapshot AI gốc, đề xuất chuẩn hóa, dữ liệu cuối. Xem `receipt-ai-metrics-v2.md` để truy vấn. Chỉ dùng cặp ghép được; snapshot trên 200 dòng bỏ chấm chất lượng. Raw field accuracy chỉ là mức khớp biểu diễn nghiệp vụ, không phải CER ký tự OCR.

Client gửi lifecycle theo batch sau frame preview/kết thúc, không gửi mỗi lần gõ. Hàng đợi RAM, HTTP 202 không xác nhận ghi MongoDB bền vững. Request ảnh/text dùng client riêng để hủy. Native OCR đang chạy có thể kết thúc sau khi hủy nhưng kết quả không được dùng. Provider đã nhận request có thể tiếp tục ở backend sau khi client đóng HTTP, tối đa deadline; không tuyên bố hủy chắc chắn quota đã dùng.

Receipt backend nhận ngân sách còn lại (tối đa115s), dùng deadline chung qua các model fallback. Luồng AI recipe/insight không đổi cách gọi. Cache vẫn có; cache hit không tính thành request provider mới. Không có benchmark ảnh/AI thật trong môi trường này, chưa kết luận tốc độ hoặc accuracy tăng bao nhiêu.

## Bộ ảnh kiểm tra thủ công

### Điều chỉnh theo snapshot hd8

AI đề xuất định lượng và bằng chứng trong cùng request đọc hóa đơn; backend kiểm tra cơ sở, đổi đơn vị và tính lại phép nhân. Không thêm request xác minh AI. Định lượng rõ của bao bì phải độc lập với mô tả giới hạn của từng trái hoặc khoảng số miếng. Trường hợp không đủ bằng chứng giữ trạng thái cần kiểm tra; số bao bì tạm lưu không được hiển thị như số miếng thực phẩm đã xác định.

Preview hiển thị tổng lượng trên dòng riêng, thông tin mua/bảo quản là nhãn phụ. Đơn vị G/ML/PIECE có nhãn g/ml/Cái-quả. Màu vàng dành cho đối chiếu, cam cho thiếu định lượng, đỏ cho lỗi chặn lưu; tooltip giải thích tại thẻ. Phép quy đổi đã hoàn thành không được tô cảnh báo. Snapshot metrics giữ trạng thái định lượng và mã cảnh báo theo từng dòng để đối chiếu.

- hd8: 4 túi ức gà500g → 2000g/168000đ; combo bắp2×3 → 6trái; tổng335630 trừ1000 điểm →334630, không trừ thêm “đã tiết kiệm”.
- hd7: tách trọng lượng mua khỏi kích thước trái; không đọc quảng cáo cuối ảnh thành item.
- hd5: hàng cân và giá gạch ngang; trứng10+2; định lượng71g/72g cần xác nhận.
- hd6: 0.394kg×64800 →394g/25531đ; 0.33kg×73200 →330g/24156đ; phiếu mua hàng không vào kho.
- hd3: hai dòng thịt heo500g giữ riêng; quà tặng cần xác nhận đã nhận.
- hd4: 2túi500g →1000g/87048đ; thiếu phần tổng cuối không bịa số tiền thanh toán.

Sau cập nhật cần khởi động lại backend và client. Dùng bản backend mới tương ứng với API_BASE_URL; không tự deploy Render hoặc thay đổi database thật.
