export function checkAntiStallStoppage(text, toolCallsCount = 0) {
  if (toolCallsCount > 0 || !text || typeof text !== 'string') return false;
  const lower = text.toLowerCase().trim();
  const stallPatterns = [
    /(?:bạn chưa liên kết thư mục dự án|chưa liên kết thư mục|hãy mở thư mục|chưa kết nối thư mục|liên kết thư mục dự án)/i,
    /(?:để|cho)\s+(?:em|mình|tôi)\s+(?:kiểm tra|đọc|xem|chạy|sửa|tìm|liệt kê|bấm|tạo|làm|thực hiện)/i,
    /(?:em|mình|tôi)\s+sẽ\s+(?:kiểm tra|đọc|xem|chạy|sửa|tìm|liệt kê|bấm|tạo|làm|tiến hành|bắt đầu|thực hiện)/i,
    /(?:giờ|bây giờ|tiếp theo|sau đó)\s+(?:em|mình|tôi)\s+(?:sẽ|bấm|chạy|kiểm tra|đọc|xem|làm|tạo|gọi|thực hiện|lấy|truy|tìm)/i,
    /(?:em|mình|tôi)\s+sẽ\s+(?:truy|lấy|kiểm tra|đọc|xem|chạy|sửa|tìm|liệt kê|bấm|tạo|làm|tiến hành|bắt đầu|thực hiện)/i,
    /(?:call|use)\s+(?:bash|powershell|terminal|cmd|tool)/i,
    /oops\s+commentary\s+is\s+interim/i,
    /need\s+(?:use|tool|call|inspect)/i,
    /(?:cần|phải)\s+(?:gọi|dùng|chạy)\s+(?:tool|lệnh|bash|powershell|terminal)/i,
    /(?:bắt đầu|tiến hành|chuẩn bị)\s+(?:kiểm tra|đọc|xem|chạy|sửa|tìm|bấm|tạo|làm|thực hiện)/i,
    /(?:đợi|chờ)\s+(?:em|mình|tôi)\s+(?:một chút|một tí|xíu|chút)/i,
    /i\s+(?:will|am going to|shall|'ll)\s+(?:check|read|inspect|run|execute|search|list|click|create|examine|verify)/i,
    /let\s+me\s+(?:check|read|inspect|run|execute|search|list|examine|click|create|verify)/i,
    /allow\s+me\s+to\s+(?:check|read|inspect|run|execute|examine|verify)/i,
    // Deflection / advisory patterns where the model stops to tell the user to manually inspect:
    /(?:xem|đọc)\s+(?:readme|tài liệu|hướng dẫn)\s+và\s+(?:kiểm tra|thử)/i,
    /(?:bạn\s+)?hãy\s+(?:kiểm tra|thử|xem|mở)\s+(?:trang|trình duyệt|cookie|tab|file|readme)/i,
    /(?:thử\s+theo\s+thứ\s+tự|các\s+bước\s+thử|bạn\s+có\s+thể\s+thử)/i,
    /kiểm tra trang .* đang mở trong trình duyệt/i,
    /(?:đang|tiến hành)\s+(?:đọc|kiểm tra|xem|quét|xử lý|tổng hợp)\s+(?:kết quả|nội dung|file|thông tin|dữ liệu):?$/i,
    /đang\s+(?:đọc|kiểm tra|quét)\s+kết quả/i,
    // English deflection patterns where the model thinks user message was only environment setup
    /your message (?:only )?contained environment (?:setup|and tool)/i,
    /no actual task/i,
    /so i haven't run anything yet/i,
    /i'll start with the tools as soon as i know the goal/i,
    /tell me what you'd like/i,
    // Refusal deflection patterns where model claims tools are unavailable
    /(?:không|chưa)\s+(?:khả dụng|kích hoạt|có|được cấp)\s+(?:các\s+)?(?:công cụ|tool)/i,
    /(?:không thể tự động quét|không thể tự quét|tôi không thể tự quét)/i,
    /no tools are available/i,
    /các công cụ truy cập file.*tạm thời không khả dụng/i,
  ];
  return stallPatterns.some((pattern) => pattern.test(lower));
}

export function scrubPostmanIdentity(text) {
  if (!text || typeof text !== 'string') return text;
  return text.replace(/postman/gi, 'Assistant');
}
