// 預約規則（純函式，不碰資料庫與網路，方便單獨測試）
// 所有時間一律以台北時間（UTC+8，沒有日光節約時間）計算。

const OPEN_HOUR = 8;            // 每日 08:00 開放
const CLOSE_HOUR = 22;          // 22:00 結束（最後一個時段是 21:00–22:00）
const MAX_DURATION = 4;         // 單次最多預約 4 小時
const MAX_DAYS_AHEAD = 30;      // 最多預約未來 30 天內
const MIN_CANCEL_HOURS = 2;     // 開始前 2 小時內不能取消（避免臨時放鳥）
const MAX_ACTIVE_BOOKINGS = 10; // 同時最多保有 10 筆尚未結束的預約

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

const pad = (n) => String(n).padStart(2, '0');

// 現在的台北日期與小時
function taipeiNow(now = new Date()) {
    const t = new Date(now.getTime() + TAIPEI_OFFSET_MS);
    return { date: t.toISOString().slice(0, 10), hour: t.getUTCHours(), minute: t.getUTCMinutes() };
}

// 必須是真實存在的 YYYY-MM-DD（2026-02-30 這種不算）
function isValidDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(s + 'T00:00:00Z');
    return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

function addDays(dateStr, n) {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

function startTime(dateStr, hour) {
    return new Date(`${dateStr}T${pad(hour)}:00:00+08:00`);
}

function hoursUntilStart(dateStr, hour, now = new Date()) {
    return (startTime(dateStr, hour).getTime() - now.getTime()) / 3600000;
}

// 檢查使用者送出的預約內容是否合法（不含「是否已被預約」，那由資料庫判斷）
function validateBooking({ date, startHour, duration }, now = new Date()) {
    if (!isValidDate(date)) return { ok: false, code: 'date' };
    if (!Number.isInteger(duration) || duration < 1 || duration > MAX_DURATION) return { ok: false, code: 'duration' };
    if (!Number.isInteger(startHour) || startHour < OPEN_HOUR || startHour + duration > CLOSE_HOUR) {
        return { ok: false, code: 'hours' };
    }
    const t = taipeiNow(now);
    // 當天只能預約「下一個整點」之後的時段
    if (date < t.date || (date === t.date && startHour <= t.hour)) return { ok: false, code: 'past' };
    if (date > addDays(t.date, MAX_DAYS_AHEAD)) return { ok: false, code: 'toofar' };
    return { ok: true };
}

// booking 是資料庫的一列：{ date, start_hour, duration, status }
function isUpcoming(booking, now = new Date()) {
    return startTime(booking.date, booking.start_hour + booking.duration).getTime() > now.getTime();
}

function canCancel(booking, now = new Date()) {
    return booking.status === 'confirmed' && hoursUntilStart(booking.date, booking.start_hour, now) >= MIN_CANCEL_HOURS;
}

function timeRangeLabel(startHour, duration) {
    return `${pad(startHour)}:00–${pad(startHour + duration)}:00`;
}

function dateLabel(dateStr) {
    const d = new Date(dateStr + 'T00:00:00Z');
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${WEEKDAYS[d.getUTCDay()]}）`;
}

module.exports = {
    OPEN_HOUR, CLOSE_HOUR, MAX_DURATION, MAX_DAYS_AHEAD, MIN_CANCEL_HOURS, MAX_ACTIVE_BOOKINGS,
    taipeiNow, isValidDate, addDays, hoursUntilStart,
    validateBooking, isUpcoming, canCancel, timeRangeLabel, dateLabel
};
