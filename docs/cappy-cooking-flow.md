# Luồng nấu ăn sau triển khai ngày 06/10/2026

## 1. Tìm kiếm và tạo món
- Tìm kiếm giữ lexical/vector hiện có; không lọc bỏ món vì thiếu nguyên liệu. Các thẻ giữ điểm phù hợp và cảnh báo thiếu NL chính.
- Nhập chữ sẽ ẩn Hôm nay ăn gì. Nút tìm ở cuối ô hoặc Enter thực hiện tìm kiếm; Back trở về trang chính.
- Cuối kết quả hoặc bong bóng pet: Nhờ Cappy chế biến dùng nguyên truy vấn, tự chạy, không nhập lại.
- POST /api/recipes/ai-search: kiểm tra yêu cầu nguy hiểm phổ biến; tìm tên chuẩn đã có trước khi gọi Gemini. Nếu đã có, trả công thức đó. Nếu chưa có, Gemini tạo công thức theo kiến thức mô hình, không truy cập web và không bắt buộc đủ kho.
- Đây là tạo sinh từ yêu cầu, không gán nhãn RAG cho luồng không truy xuất công thức tham khảo. AI từ chối yêu cầu không liên quan nấu ăn/nguy hiểm; backend kiểm tra JSON, schema, đơn vị và định lượng tối thiểu. Không coi kiểm tra schema là chứng minh món ngon/an toàn tuyệt đối.
- Kết quả là nháp, có nguyên liệu, gia vị, các bước và lượng còn thiếu theo số khẩu phần cơ sở. Lưu mới đưa vào catalog chung ACTIVE, thêm vào công thức đã lưu của người dùng và tạo embedding nền. Nếu embedding lỗi, công thức vẫn tìm bằng từ khóa; log lỗi embedding để kiểm tra lại.
- CT_* luôn hiển thị SYSTEM; ai_recipe_* hiển thị AI, kể cả dữ liệu cũ gắn nhầm source. Không chạy migration dữ liệu thật.

## 2. Hôm nay ăn gì
- Đọc kho còn dùng được mới cho mỗi request; catalog dùng chung trong RAM 60 giây. Không gọi Gemini, không sinh món riêng ở cuối danh sách.
- Chọn tối đa 5 công thức trong catalog chung, gồm món hệ thống và món AI đã lưu. Ưu tiên món nấu được; xáo trộn trong nhóm có mức ưu tiên giải cứu tương đương.
- Nếu chỉ có 3 món nấu được, bổ sung tối đa 2 món gần đủ dựa trên điểm matcher. Hiển thị lượng cần mua cho 2 khẩu phần; món nấu được đề xuất tối đa 2 khẩu phần trong giới hạn kho.
- Nếu không có món nấu được, hiện nhắc đi chợ; có thể vẫn xem món gần đủ cùng lượng thiếu. Kho trống/chỉ gia vị không trả món nấu được.
- Trước/Tiếp đổi ngay trong nhóm đã nhận, không gọi API hoặc Gemini. Không đảm bảo luôn đủ 5 món nếu catalog/kho không phù hợp.
- Giải cứu là danh sách ưu tiên thực phẩm còn hạn và sắp hết hạn. Hôm nay ăn gì giúp chọn bữa ăn; hai phần có thể trùng món vì cùng kho, khác mục đích tương tác. Không khuyến khích dùng đồ quá hạn.

## 3. Đối chiếu nguyên liệu và thay thế
- Giữ EXACT, EQUIVALENT, SUBSTITUTE, RELATED, NO_MATCH, REVIEW_REQUIRED. Category/vector không quyết định một nguyên liệu có sẵn.
- Cá mòi không nhận đầu cá hồi; thịt cá hồi không nhận đầu cá hồi; thịt đùi heo không thay dầu/mỡ nấu ăn. Loài cá chưa nhận diện chắc chắn yêu cầu xem lại, không tự coi cùng nguyên liệu.
- RELATED không vào nhóm Sẵn có và không cung cấp lượng nấu.
- Chỉ đưa lựa chọn thay thế đã được công thức cho phép và có lượng phù hợp trong kho. Người dùng chọn Dùng X thay Y, backend kiểm tra danh sách cho phép và đối chiếu lại; kế hoạch FEFO dùng đúng nguyên liệu đã chọn. Không sửa công thức catalog.
- Nấu vẫn kiểm tra lại lượng/expiry trong transaction, giữ idempotency; lựa chọn thay thế cũng thuộc khóa thao tác phía client.

## 4. Tinh luyện bằng RAG
- Chỉ mở ở chi tiết công thức. POST /api/recipes/rag-suggest gửi ID gốc, yêu cầu/tag và kho mới.
- Truy xuất đúng công thức gốc gồm nguyên liệu, khẩu phần, cách nấu; cung cấp context cho Gemini. Đây là RAG: retrieval theo ID + augmentation bằng nội dung công thức/kho + generation. Không bắt buộc dùng vector để gọi là RAG.
- Điều chỉnh khẩu vị hoặc biến thể gần, giữ nguyên liệu chính và nhóm chế biến. Trứng sốt cà chua → trứng sốt kim chi có thể hợp lệ; → canh trứng thuộc tạo món khác. Rule dựa trên tên/nguyên liệu là lớp chặn phổ biến, chưa phải bộ hiểu ẩm thực toàn diện.
- Tag theo món, không chủ động đề nghị chuyển hẳn phương pháp chế biến. Nút Thử biến thể từ kho dùng cùng pipeline, gửi đúng ID gốc và phải qua matcher đủ kho; không có vòng sinh lại tự động.
- Điều chỉnh thường vẫn có thể hiện lượng cần mua. Biến thể thay đổi nguyên liệu có thể lưu vào catalog chung, có baseRecipeId truy về món gốc. Đổi riêng lượng/gia vị dùng trong phiên, không nhân bản catalog.
- Nháp gắn user, sống 30 phút trong RAM, tối đa 500 nháp. Restart server làm mất nháp chưa lưu. Chi tiết/nấu có thể dùng nháp trong phiên; công thức gốc không bị ghi đè.
- Chống lưu lặp cùng token; chống trùng tên chuẩn trong một tiến trình và kiểm tra catalog khi lưu. Chưa chống trùng ngữ nghĩa hoặc đồng thời giữa nhiều server. Duyệt admin là hướng phát triển; bản hiện tại chưa có duyệt admin.

## 5. Tốc độ và lỗi
- Catalog cache 60 giây, đọc kho mới, tái sử dụng snapshot trong request. Không giới hạn catalog ở 400 món đầu nên món AI mới vẫn được xét.
- Log [Recipe performance] có catalogCount, loadMs, matchingMs để xác định nút thắt.
- Gemini chỉ dùng cho tạo/tinh luyện, lý do tối đa 2 câu, 4–8 bước nấu, context một công thức gốc. Deadline provider 30 giây, client 40 giây.
- UI có loading, giữ yêu cầu khi thất bại, hiển thị reason/code. Sheet cuộn và tránh bàn phím; pet ẩn khi sheet mở và xuất hiện lại khi đóng.
- Các tình huống phổ biến: không có món/thiếu kho, yêu cầu bị từ chối, JSON/schema không hợp lệ, timeout/quota/lỗi HTTP, nháp hết hạn, kho vừa thay đổi. Không âm thầm trả món khác khi AI thất bại.

## 6. Đo lường và demo
- Xem recipe-ai-metrics.md: tách TODAY, OVERVIEW, CREATE, RAG; đo thời gian server/UI, tỷ lệ lỗi, số lượt gọi Gemini; đo mở chi tiết, lưu món mới, nấu từ gợi ý.
- Đủ/thiếu theo matcher là tính khả dụng từ kho, không phải accuracy AI. Chất lượng matcher kiểm tra bằng các ca có kỳ vọng; độ hợp khẩu vị cần phản hồi thật của người dùng.
- Demo: (1) tìm món thiếu kho vẫn thấy kết quả; (2) Hôm nay ăn gì đổi 5 lựa chọn không chờ AI; (3) tìm món chưa có và nhờ Cappy tạo, xem lượng thiếu, lưu, tìm lại; (4) tinh luyện một món theo khẩu vị; (5) chọn thay thế hợp lệ; (6) nấu một món đủ kho, kiểm tra trừ FEFO.
- Test tự động dùng mock database/provider, không đo latency Gemini/Atlas/Render thật. Sau restart server và hot restart app cần thử demo thật trên kho phù hợp trước khi đưa số liệu vào báo cáo.
- Tận dụng cấu trúc báo cáo: inventory → retrieval/matching → Gemini với context → validation → xác nhận/lưu. Cập nhật mô tả lưu công thức AI chung, nháp trong phiên, bốn luồng metrics và Today không gọi Gemini. Không mô tả tạo món như tìm kiếm web hay kiểm duyệt admin đã có.


## Khắc phục sau test ngày 06/10
- Prompt CREATE tách riêng, không chứa kho/few-shot của RAG. Đối chiếu kho sau sinh, không ép món thành phiên bản chữa cháy. Mì/mỳ cay thiếu mì, mì cay hải sản thiếu hải sản phù hợp bị chặn bằng AI_DISH_MISMATCH (rule cho trường hợp phổ biến, chưa bao phủ mọi món).
- Tinh luyện cho phép thêm sốt khi giữ nguyên liệu chính và phương pháp nền trong các bước; không chỉ phán đoán dựa trên tên món. Prompt yêu cầu giữ chính xác tên nguyên liệu chính.
- Chuyển sang tạo món khác trong cùng sheet, gửi cả baseRecipeId và yêu cầu. Có nút quay lại giữ nội dung; không mở sheet lồng nhau.
- Tạo món dùng mode CREATE_NEW; tương thích ADAPT_EXISTING cũ. Tinh luyện vẫn bắt buộc provenance đúng ID. Các lỗi AI_EMPTY_RESPONSE/AI_INVALID_JSON/AI_INVALID_MODE/AI_MISSING_RECIPE được log rõ, UI báo công thức chưa hoàn chỉnh thay vì thiếu căn cứ.
- SDK bọc aborted được chuyển thành AI_TIMEOUT (504), có xét trạng thái hủy và thời gian. Log recipe dùng Recipe AI, giữ nhãn Receipt AI cho hóa đơn.


## Nguyên liệu thực tế (prompt v5)
- Ingredient.role (MAIN/SECONDARY/SEASONING) độc lập với required và purchaseRequired. Metadata mới là tùy chọn để đọc dữ liệu cũ; không migration catalog.
- Prompt tạo/tinh luyện chọn một cách chuẩn bị: nguyên liệu thô + hướng dẫn chế biến, hoặc gói/sản phẩm mua sẵn rõ tên. Không liệt kê trùng đầu vào và thành phẩm tự nấu. Nước lọc giữ định lượng nhưng purchaseRequired=false, required=false; các thực phẩm/gia vị/gói nước lẩu purchaseRequired=true.
- Backend kiểm tra enum/boolean và chặn các tên thành phẩm mơ hồ phổ biến (nước dùng tự nấu, thịt cua luộc sẵn không ghi sản phẩm đóng gói). Không tự đổi thành phần, suy ra lượng xương hay tính hiệu suất cua. Output sai cần thử lại.
- Nước lọc không vào danh sách cần mua, không chặn khẩu phần hay bị trừ inventory; ở chi tiết hiện Chuẩn bị tại nhà. Metadata được giữ khi lưu và đọc chi tiết.
- Rule mới không tự sửa các công thức cũ. Vẫn cần kiểm tra thực tế output Gemini; kiểm tra kỹ thuật không chứng minh toàn bộ công thức hợp lý.


## UI nháp và lưu/mở chi tiết
- Bản nháp có khẩu phần, đường phân cách và các mục riêng: Cần mua thêm, Điều chỉnh (tinh luyện), Nguyên liệu đầy đủ, Cách làm. Hai mục cuối mở rộng khi cần, tránh dồn hai danh sách dài và các bước vào cùng khối văn bản.
- Bỏ lặp dòng nguồn tham khảo (món gốc đã hiển thị trên sheet) và cảnh báo AI dài. Gia vị NONE hiển thị vừa đủ, không hiện 0 vừa đủ.
- Lưu thành công trả recipeId/baseServings từ sheet, đóng sheet rồi host mở MaterialPageRoute tới chi tiết. Không dùng Get.to với cùng loại RecipeDetailScreen để tránh chặn điều hướng trùng; kiểm tra ID trước đổi state, giữ nháp nếu lỗi lưu.
- Chi tiết mới dùng baseServings của kết quả đã lưu; làm mới cache để không hiển thị dữ liệu cũ. Không đổi điều kiện từ chối tinh luyện trong lượt sửa UI này.

## Tối ưu snapshot gợi ý (06/10/2026)
- OVERVIEW/TODAY dùng chung ranking cache theo user, nội dung snapshot kho, catalog và ngày Việt Nam; TTL 60 giây, tối đa 100 user/process. Mỗi request vẫn đọc kho mới để phát hiện thay đổi từ mọi nguồn. Không dùng cache để cấp quyền nấu hoặc trừ kho.
- Refresh trang gọi recommendations?refresh=true, ép tính lại ranking. Kho thêm/sửa/xóa/dùng thành công làm mất hiệu lực cache chi tiết và trạng thái gợi ý ở Flutter. Khi tạo lại màn Cook cũng yêu cầu refresh.
- Ranking dùng snapshot kho đã lọc một lần, cùng thời điểm phân tích; TODAY tái sử dụng analysis, không phân tích lại 5 lựa chọn. OVERVIEW lấy món ngẫu nhiên từ catalog đã tải, không gọi aggregate thêm.
- Log Recipe performance có loadMs, matchingMs, cacheHit, catalogCount, inventoryCount. Dùng để đo trên dữ liệu thật sau restart; unit tests không chứng minh latency trên Atlas/Render.
- Catalog sửa trực tiếp ngoài app được tải lại theo TTL catalog; lưu món bằng app vô hiệu catalog cache hiện có. Không migration hay đổi công thức scoring.
