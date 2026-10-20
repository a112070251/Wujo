const express = require('express');
const bodyParser = require('body-parser');
const app = express();
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const http = require('http');
const { Server } = require('socket.io');
const store = require('./db');
const bookingRules = require('./bookings');
const Limiter = require('./rateLimit');

// --- 基礎設定 ---
app.set('view engine', 'ejs');
// Render 等平台的 HTTPS 由前面的代理處理；信任一層代理才能取得真實 IP 並設定 secure cookie
app.set('trust proxy', 1);
app.disable('x-powered-by');

// 基本的安全標頭
app.use((req, res, next) => {
    res.set({
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'SAMEORIGIN',
        'Referrer-Policy': 'strict-origin-when-cross-origin'
    });
    next();
});

// 擋掉從其他網站送來的表單（CSRF）：寫入類請求若帶有 Origin，必須和本站相同
app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const headers = req.headers || {};
    if (headers.origin) {
        let host = null;
        try { host = new URL(headers.origin).host; } catch (e) { /* 無效的 Origin */ }
        if (host !== headers.host) return res.status(403).send('來源不符，請求已被拒絕');
    }
    next();
});
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));

// --- 1. Session 設定 ---
// secret 請透過環境變數 SESSION_SECRET 提供；正式環境（NODE_ENV=production）沒設定會直接報錯
if (!process.env.SESSION_SECRET && process.env.NODE_ENV === 'production') {
    throw new Error('請設定環境變數 SESSION_SECRET');
}
const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET || 'dev-only-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 7 * 24 * 60 * 60 * 1000 // 7 天
    }
});
app.use(sessionMiddleware);

const rooms = [
    { id: 0, name: "大安旗艦館", dist: "大安區", price: 500, lat: 25.0339, lng: 121.5434, image: "https://images.unsplash.com/photo-1508700115892-45ecd05ae2ad?w=500&auto=format&fit=crop" },
    { id: 1, name: "中正紀念堂館", dist: "中正區", price: 450, lat: 25.0352, lng: 121.5197, image: "https://images.unsplash.com/photo-1547153760-18fc86324498?w=500&auto=format&fit=crop" },
    { id: 2, name: "信義 101 館", dist: "信義區", price: 600, lat: 25.0336, lng: 121.5646, image: "https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?w=500&auto=format&fit=crop" }
];

// --- 防暴力破解與濫用 ---
const loginLimiter = new Limiter(10, 15 * 60 * 1000);    // 同一 IP + 帳號 15 分鐘最多 10 次
const registerLimiter = new Limiter(10, 60 * 60 * 1000); // 同一 IP 每小時最多註冊 10 次
const reviewLimiter = new Limiter(20, 60 * 60 * 1000);   // 同一使用者每小時最多送出 20 則評價

// --- 評價設定 ---
const MAX_REVIEW_COMMENT = 300;
const PHOTO_REVIEW_TAGS = ['出片極快', '運鏡很穩', '很會引導動作', '配樂切點精準'];
const PHOTO_STYLES = ['街舞動態', 'K-Pop直拍', '活動劇照'];
const PHOTO_LOCATIONS = ['台北', '新北', '桃園', '台中', '台南', '高雄', '其他'];
const MIN_PHOTO_PRICE = 100;
const MAX_PHOTO_PRICE = 100000;
const MAX_PHOTO_BIO = 200;
const MAX_PORTFOLIO_ITEMS = 6;
const MAX_PORTFOLIO_TITLE = 40;
const MAX_PORTFOLIO_URL = 300;

// 只接受 http(s) 連結（擋掉 javascript: 之類），回傳整理過的網址或 null
function cleanPortfolioUrl(input) {
    const raw = String(input || '').trim();
    if (raw.length === 0 || raw.length > MAX_PORTFOLIO_URL) return null;
    try {
        const u = new URL(raw);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        if (u.username || u.password) return null;
        return u.href;
    } catch (e) {
        return null;
    }
}

// --- 貼文與訊息的共用設定 ---
const POST_TAGS = ['找比賽', '練基礎', '拍片', 'K-Pop', 'HipHop', '街舞', 'Breaking', 'Popping'];
const MAX_POST_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 500;
const POST_ERRORS = {
    empty: '貼文內容不能是空白',
    toolong: `貼文最多 ${MAX_POST_LENGTH} 個字`
};

// --- 檢舉與管理設定 ---
const REPORT_CATEGORIES = ['惡意取消或放鳥', '言論騷擾', '冒充或詐騙', '不當內容', '其他'];
const MAX_REPORT_DETAIL = 500;
const MAX_REPORT_EVIDENCE = 300;
const MAX_REPORTS_PER_DAY = 5;
const REPORT_MESSAGES = {
    submitted: { type: 'success', text: '檢舉已送出，管理員審核通過後才會公開。' },
    invalid: { type: 'error', text: `請選擇檢舉類別，並填寫 5 到 ${MAX_REPORT_DETAIL} 個字的說明（佐證最多 ${MAX_REPORT_EVIDENCE} 字）。` },
    notfound: { type: 'error', text: '找不到這位使用者，請確認用戶名稱是否正確。' },
    self: { type: 'error', text: '不能檢舉自己。' },
    duplicate: { type: 'error', text: '你已經檢舉過這位使用者了，請等待管理員審核。' },
    limit: { type: 'error', text: `為避免濫用，每人 24 小時內最多送出 ${MAX_REPORTS_PER_DAY} 件檢舉。` },
    error: { type: 'error', text: '送出失敗，請稍後再試。' }
};

// 管理員以環境變數 ADMIN_EMAILS 指定（多個信箱用逗號分隔），登入時的信箱符合即為管理員
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

function isAdminEmail(email) {
    return !!email && ADMIN_EMAILS.includes(String(email).toLowerCase());
}

// 資料庫存的是 UTC 時間字串（YYYY-MM-DD HH:MM:SS）
function parseDbTime(sqlUtc) {
    return new Date(String(sqlUtc).replace(' ', 'T') + 'Z');
}

function timeAgo(sqlUtc) {
    const t = parseDbTime(sqlUtc);
    if (isNaN(t)) return '';
    const diff = Math.max(0, Math.floor((Date.now() - t.getTime()) / 1000));
    if (diff < 60) return '剛剛';
    if (diff < 3600) return `${Math.floor(diff / 60)} 分鐘前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小時前`;
    if (diff < 7 * 86400) return `${Math.floor(diff / 86400)} 天前`;
    return t.toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' });
}

function formatClock(sqlUtc) {
    const t = parseDbTime(sqlUtc);
    if (isNaN(t)) return '';
    return t.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Taipei' });
}

function toPostView(row) {
    return {
        id: row.id,
        authorId: row.author_id,
        author: row.author_name,
        content: row.content,
        time: timeAgo(row.created_at),
        hashtags: row.tags
    };
}

// 已被停權（檢舉 5 次以上）的帳號，即使 session 還在也不能發文或傳訊
function isBanned(user) {
    return Number.isInteger(user.id) && store.countApprovedReports(user.id) >= store.REPORT_BAN_THRESHOLD;
}

// --- 3. 全域變數中間件 ---
app.use((req, res, next) => {
    const sessUser = req.session.user;
    // 登入後才被停權的帳號，下一次操作就會被登出
    if (sessUser && isBanned(sessUser)) {
        return req.session.destroy(() => res.redirect('/login?banned=1'));
    }
    res.locals.user = sessUser || null;
    res.locals.isAdmin = !!sessUser && isAdminEmail(sessUser.email);
    res.locals.unreadCount = (sessUser && Number.isInteger(sessUser.id)) ? store.countUnread(sessUser.id) : 0;
    res.locals.hasNewMsg = res.locals.unreadCount > 0;
    res.locals.notifCount = (sessUser && Number.isInteger(sessUser.id)) ? store.countUnreadNotifications(sessUser.id) : 0;
    next();
});

// --- 4. 路由開始 ---

// 首頁路由
app.get('/', (req, res) => {
    const latest = store.getLatestPost();
    res.render('index', {
        featuredPost: latest ? toPostView(latest) : null,
        featuredVenue: rooms[0]
    });
});

// 1. 顯示登入頁面
app.get('/login', (req, res) => {
    if (req.session.user) return res.redirect('/me');
    res.render('login', {
        error: req.query.banned ? '您的帳號因被檢舉次數過多，已被系統停權。' : null,
        username: '',
        notice: req.query.registered ? '註冊成功，請登入' : (req.query.deleted ? '你的帳號與相關資料已刪除。' : null)
    });
});

// 2. 顯示註冊頁面
app.get('/register', (req, res) => {
    res.render('register', { error: null, form: { name: '', email: '' } });
});

// 3. 顯示法律條款與隱私權政策頁面
app.get('/terms', (req, res) => {
    res.render('terms', { contactEmail: process.env.CONTACT_EMAIL || '' });
});

// 登入邏輯
// 帳號不存在時也跑一次 bcrypt，讓回應時間一致，避免被用來探測哪些帳號存在
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 10);

// 只計算管理員審核通過的檢舉
function getReportCount(name) {
    return store.countApprovedReportsByName(String(name));
}

app.post('/login', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');

    const fail = (status, error) => res.status(status).render('login', { error, username, notice: null });

    if (!username || !password) return fail(400, '請輸入帳號與密碼');

    const limitKey = `${req.ip}|${username.toLowerCase()}`;
    if (loginLimiter.isBlocked(limitKey)) return fail(429, '嘗試次數過多，請 15 分鐘後再試');

    try {
        const account = store.findUserByLogin(username);
        const passwordOk = await bcrypt.compare(password, account ? account.password_hash : DUMMY_HASH);

        if (!account || !passwordOk) {
            loginLimiter.hit(limitKey);
            return fail(401, '帳號或密碼錯誤');
        }
        loginLimiter.reset(limitKey);

        const currentReports = getReportCount(account.name);
        if (currentReports >= 5) {
            return fail(403, `您的帳號因被檢舉次數達 ${currentReports} 次，已被系統永久停權。`);
        }

        // 登入成功後重新產生 session，避免 session fixation
        req.session.regenerate((err) => {
            if (err) {
                console.error('登入失敗:', err);
                return fail(500, '登入失敗，請稍後再試');
            }
            req.session.user = {
                id: account.id,
                email: account.email,
                name: account.name,
                avatarSeed: account.name,
                reports: currentReports,
                isWarning: currentReports === 4
            };
            req.session.save(() => res.redirect('/me'));
        });
    } catch (err) {
        console.error('登入失敗:', err);
        return fail(500, '登入失敗，請稍後再試');
    }
});

app.post('/register', async (req, res) => {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const { agreeTerms } = req.body;

    const form = { name, email };
    const fail = (status, error) => res.status(status).render('register', { error, form });

    if (!registerLimiter.hit(String(req.ip))) return fail(429, '註冊次數過多，請稍後再試');
    if (!agreeTerms) return fail(400, '必須同意服務條款與隱私權政策才能完成註冊');
    if (name.length < 2 || name.length > 20) return fail(400, '暱稱需為 2 到 20 個字');
    if (name.includes('@')) return fail(400, '暱稱不能包含 @');
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(400, '請輸入有效的電子信箱');
    if (password.length < 6) return fail(400, '密碼至少需要 6 個字元');
    if (Buffer.byteLength(password, 'utf8') > 72) return fail(400, '密碼過長，請縮短一些');
    if (store.findUserByName(name)) return fail(409, '這個暱稱已被使用');
    if (store.findUserByEmail(email)) return fail(409, '這個電子信箱已經註冊過了');

    try {
        const passwordHash = await bcrypt.hash(password, 10);
        store.createUser(name, email, passwordHash);
        return res.redirect('/login?registered=1');
    } catch (err) {
        if (err && String(err.code).startsWith('SQLITE_CONSTRAINT')) {
            return fail(409, '暱稱或電子信箱已被使用');
        }
        console.error('註冊失敗:', err);
        return fail(500, '註冊失敗，請重試');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
});

app.get('/me', (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login'); 
    }
    
    // 檢舉次數以資料庫為準（只算管理員審核通過的）
    if (Number.isInteger(req.session.user.id)) {
        const approved = store.countApprovedReports(req.session.user.id);
        req.session.user.reports = approved;
        req.session.user.isWarning = approved === store.REPORT_BAN_THRESHOLD - 1;
    }

    const today = bookingRules.taipeiNow().date;
    const bookings = Number.isInteger(req.session.user.id)
        ? store.listUpcomingBookings(req.session.user.id, today)
            .filter(b => bookingRules.isUpcoming(b))
            .map(b => ({
                id: b.id,
                venueName: rooms[b.room_id] ? rooms[b.room_id].name : '教室',
                month: Number(b.date.slice(5, 7)),
                day: Number(b.date.slice(8, 10)),
                dateText: bookingRules.dateLabel(b.date),
                timeText: bookingRules.timeRangeLabel(b.start_hour, b.duration),
                price: b.price,
                canCancel: bookingRules.canCancel(b)
            }))
        : [];
    const notice = Object.hasOwn(BOOKING_MESSAGES, req.query.msg) ? BOOKING_MESSAGES[req.query.msg] : null;

    const pg = Number.isInteger(req.session.user.id) ? store.getPhotographerByUserId(req.session.user.id) : null;
    const photographer = {
        active: !!pg && pg.active === 1,
        price: pg ? pg.price : '',
        style: pg ? pg.style : PHOTO_STYLES[0],
        location: pg ? pg.location : PHOTO_LOCATIONS[0],
        bio: pg ? pg.bio : ''
    };

    const portfolio = Number.isInteger(req.session.user.id) ? store.listPortfolio(req.session.user.id) : [];

    res.render('me', { user: req.session.user, bookings, notice, photographer, portfolio, maxPortfolio: MAX_PORTFOLIO_ITEMS, maxPortfolioTitle: MAX_PORTFOLIO_TITLE, photoStyles: PHOTO_STYLES, photoLocations: PHOTO_LOCATIONS, maxPhotoBio: MAX_PHOTO_BIO });
});

// --- 刪除自己的帳號（需輸入密碼確認）---
app.post('/delete-account', async (req, res) => {
    const me = req.session.user;
    if (!me) return res.redirect('/login');

    const limitKey = `${req.ip}|delete|${me.id}`;
    if (loginLimiter.isBlocked(limitKey)) return res.redirect('/me?msg=del_limit');
    if (req.body.confirm !== 'yes') return res.redirect('/me?msg=del_confirm');

    try {
        const account = store.findUserWithHashById(me.id);
        if (!account) return req.session.destroy(() => res.redirect('/login'));

        const passwordOk = await bcrypt.compare(String(req.body.password || ''), account.password_hash);
        if (!passwordOk) {
            loginLimiter.hit(limitKey);
            return res.redirect('/me?msg=del_wrong');
        }
        // 有已通過的檢舉紀錄時不能自行刪除，避免用刪帳號再重新註冊來洗掉黑名單
        if (store.countApprovedReports(me.id) > 0) return res.redirect('/me?msg=del_blocked');

        store.deleteUser(me.id);
        req.session.destroy(() => res.redirect('/login?deleted=1'));
    } catch (err) {
        console.error('刪除帳號失敗:', err);
        res.redirect('/me?msg=error');
    }
});

app.post('/update-photographer', (req, res) => {
    const me = req.session.user;
    if (!me) return res.redirect('/login');

    if (req.body.isPhotographer !== 'true') {
        store.deactivatePhotographer(me.id);
        return res.redirect('/me?msg=pg_closed');
    }

    const priceText = String(req.body.photoPrice || '').trim();
    const price = /^\d{1,6}$/.test(priceText) ? Number(priceText) : NaN;
    const style = String(req.body.photoStyle || '');
    const location = String(req.body.photoLocation || '');
    const bio = String(req.body.photoBio || '').trim();

    if (!(price >= MIN_PHOTO_PRICE && price <= MAX_PHOTO_PRICE)
        || !PHOTO_STYLES.includes(style)
        || !PHOTO_LOCATIONS.includes(location)
        || bio.length > MAX_PHOTO_BIO) {
        return res.redirect('/me?msg=pg_invalid');
    }

    store.savePhotographer(me.id, { price, style, location, bio });
    res.redirect('/me?msg=pg_saved');
});

app.get('/blacklist', (req, res) => {
    const searchQuery = String(req.query.search || '').trim().slice(0, 50);

    // 公開名單只含「管理員審核通過」的檢舉，且只顯示類別與次數，不公開檢舉人與詳細內容
    const blacklisted = store.listBlacklist({ q: searchQuery }).map(r => ({
        name: r.name,
        avatar: r.name,
        reason: r.categories.join('、'),
        reportCount: r.report_count,
        date: String(r.last_at || '').slice(0, 10)
    }));

    const notice = Object.hasOwn(REPORT_MESSAGES, req.query.msg) ? REPORT_MESSAGES[req.query.msg] : null;

    res.render('blacklist', {
        blacklisted,
        searchQuery,
        categories: REPORT_CATEGORIES,
        maxDetail: MAX_REPORT_DETAIL,
        maxEvidence: MAX_REPORT_EVIDENCE,
        notice
    });
});

// 提交檢舉：送出後是「待審核」，管理員通過後才會公開並計入次數
app.post('/submit-blacklist', (req, res) => {
    const me = req.session.user;
    if (!me) return res.redirect('/login');

    const back = (code) => res.redirect('/blacklist?msg=' + code);

    const targetName = String(req.body.targetName || '').trim();
    const category = String(req.body.category || '');
    const detail = String(req.body.detail || '').trim();
    const evidence = String(req.body.evidence || '').trim();

    if (!targetName || !REPORT_CATEGORIES.includes(category)) return back('invalid');
    if (detail.length < 5 || detail.length > MAX_REPORT_DETAIL) return back('invalid');
    if (evidence.length > MAX_REPORT_EVIDENCE) return back('invalid');

    const target = store.findUserByName(targetName);
    if (!target) return back('notfound');
    if (target.id === me.id) return back('self');
    if (store.hasReported(me.id, target.id)) return back('duplicate');
    if (store.countRecentReports(me.id, 24) >= MAX_REPORTS_PER_DAY) return back('limit');

    try {
        store.createReport(me.id, target.id, category, detail, evidence);
    } catch (err) {
        if (err && String(err.code).startsWith('SQLITE_CONSTRAINT')) return back('duplicate');
        console.error('送出檢舉失敗:', err);
        return back('error');
    }
    return back('submitted');
});

// --- 管理員：審核檢舉 ---
function requireAdmin(req, res, next) {
    const sessUser = req.session.user;
    if (!sessUser) return res.redirect('/login');
    if (!isAdminEmail(sessUser.email)) return res.status(403).send('只有管理員可以使用這個頁面');
    next();
}

const REPORT_TABS = ['pending', 'approved', 'rejected', 'revoked'];

app.get('/admin/reports', requireAdmin, (req, res) => {
    const tab = REPORT_TABS.includes(req.query.tab) ? req.query.tab : 'pending';
    const reports = store.listReports(tab, 100).map(r => ({ ...r, time: timeAgo(r.created_at) }));
    const counts = {};
    REPORT_TABS.forEach(s => { counts[s] = store.countReports(s); });

    res.render('admin_reports', { reports, tab, counts, threshold: store.REPORT_BAN_THRESHOLD });
});

app.post('/admin/reports/:id/:action', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const action = req.params.action;
    if (!Number.isInteger(id) || !['approve', 'reject', 'revoke'].includes(action)) {
        return res.status(400).send('無效的操作');
    }
    const report = store.getReport(id);
    const changed = store.reviewReport(id, req.session.user.id, action);

    if (changed && report && action !== 'revoke') {
        // 只通知檢舉人處理結果；被檢舉者只會收到次數警告，不會知道是誰檢舉的
        store.notify(report.reporter_id, 'report',
            `你對 ${report.target_name} 的檢舉已${action === 'approve' ? '通過' : '被駁回'}`, '/blacklist');
        if (action === 'approve') {
            const approved = store.countApprovedReports(report.target_id);
            if (approved === store.REPORT_BAN_THRESHOLD - 1) {
                store.notify(report.target_id, 'warning',
                    `警告：你已被檢舉 ${approved} 次，再被檢舉 1 次帳號就會被停權`, '/me');
            }
        }
    }
    res.redirect('/admin/reports?tab=' + (action === 'revoke' ? 'approved' : 'pending'));
});

app.get('/notifications', (req, res) => {
    const me = req.session.user;
    if (!me) return res.redirect('/login');

    const notifications = store.listNotifications(me.id).map(n => ({
        ...n,
        unread: !n.read_at,
        time: timeAgo(n.created_at),
        icon: ({ review: '⭐', report: '🛡️', warning: '⚠️' })[n.type] || '🔔'
    }));
    // 先取出「是否未讀」再標為已讀，導覽列的紅點也一併歸零
    store.markNotificationsRead(me.id);
    res.locals.notifCount = 0;
    res.render('notifications', { notifications });
});

app.get('/partner', (req, res) => {
    const currentTag = POST_TAGS.includes(req.query.tag) ? req.query.tag : '全部';
    const q = String(req.query.q || '').trim().slice(0, 50);
    const posts = store
        .listPosts({ tag: currentTag === '全部' ? '' : currentTag, q })
        .map(toPostView);

    res.render('partner_page', {
        posts,
        currentTag,
        q,
        tags: POST_TAGS,
        maxLength: MAX_POST_LENGTH,
        error: Object.hasOwn(POST_ERRORS, req.query.error) ? POST_ERRORS[req.query.error] : null
    });
});

app.post('/posts', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    if (isBanned(req.session.user)) return res.status(403).send('您的帳號已被停權，無法發文');

    const content = String(req.body.content || '').trim();
    const rawTags = req.body.tags || [];
    const tags = [...new Set((Array.isArray(rawTags) ? rawTags : [rawTags]).filter(t => POST_TAGS.includes(t)))].slice(0, 5);

    if (!content) return res.redirect('/partner?error=empty');
    if (content.length > MAX_POST_LENGTH) return res.redirect('/partner?error=toolong');

    store.createPost(req.session.user.id, content, tags);
    res.redirect('/partner');
});

app.get('/messages', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const me = req.session.user.id;

    const chatList = store.listConversations(me).map(c => ({
        id: c.partner_id,
        name: c.partner_name,
        avatar: c.partner_name,
        lastMsg: (c.last_sender_id === me ? '你：' : '') + c.last_text,
        time: timeAgo(c.last_at),
        unread: c.unread
    }));
    res.render('messages', { chatList });
});

// 聊天室：:id 是對方的使用者 ID
app.get('/chat/:id', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const me = req.session.user.id;

    const targetId = Number(req.params.id);
    const target = Number.isInteger(targetId) ? store.findUserById(targetId) : null;
    if (!target) return res.status(404).send('找不到這位使用者');
    if (target.id === me) return res.redirect('/messages');

    // 開啟聊天室視為已讀，導覽列的未讀數也要同步
    store.markConversationRead(me, target.id);
    res.locals.unreadCount = store.countUnread(me);
    res.locals.hasNewMsg = res.locals.unreadCount > 0;

    const messages = store.getConversation(me, target.id).map(m => ({
        id: m.id,
        senderId: m.sender_id,
        text: m.text,
        time: formatClock(m.created_at)
    }));

    res.render('chat', {
        chatTarget: { id: target.id, name: target.name, avatar: target.name },
        messages,
        currentUserId: me,
        maxLength: MAX_MESSAGE_LENGTH
    });
});

// 舊連結相容：沒指定對象時回到訊息列表
app.get('/chat', (req, res) => {
    res.redirect(req.session.user ? '/messages' : '/login');
});

app.get('/api/current-location', (req, res) => {
    res.json({ success: true, district: "大安區", lat: 25.0339, lng: 121.5434 });
});

app.get('/api/nearest-venue', (req, res) => {
    const userLat = parseFloat(req.query.lat);
    const userLng = parseFloat(req.query.lng);

    if (!userLat || !userLng) {
        return res.status(400).json({ error: "無法取得您的經緯度" });
    }

    const R = 6371; 
    let nearestRoom = null;
    let minDistance = Infinity;

    rooms.forEach(room => {
        const dLat = (room.lat - userLat) * Math.PI / 180;
        const dLng = (room.lng - userLng) * Math.PI / 180;
        const a = 
            Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(userLat * Math.PI / 180) * Math.cos(room.lat * Math.PI / 180) * Math.sin(dLng/2) * Math.sin(dLng/2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        const distance = R * c;

        if (distance < minDistance) {
            minDistance = distance;
            nearestRoom = { ...room, distance: distance.toFixed(2) };
        }
    });

    res.json({ nearestRoom });
});

app.get('/venues', (req, res) => {
    res.render('venues_page', { rooms: rooms });
});

// --- 教室預約 ---
const BOOKING_MESSAGES = {
    date: { type: 'error', text: '日期格式不正確，請重新選擇。' },
    duration: { type: 'error', text: `預約時數必須是 1 到 ${bookingRules.MAX_DURATION} 小時。` },
    hours: { type: 'error', text: `營業時間是 ${bookingRules.OPEN_HOUR}:00 到 ${bookingRules.CLOSE_HOUR}:00，請選擇時段內的整點。` },
    past: { type: 'error', text: '這個時段已經過了，請選擇之後的時段。' },
    toofar: { type: 'error', text: `最多只能預約未來 ${bookingRules.MAX_DAYS_AHEAD} 天內的時段。` },
    taken: { type: 'error', text: '這個時段剛被別人預約了，請選擇其他時段。' },
    limit: { type: 'error', text: `你同時最多只能保有 ${bookingRules.MAX_ACTIVE_BOOKINGS} 筆尚未結束的預約。` },
    error: { type: 'error', text: '預約失敗，請稍後再試。' },
    booked: { type: 'success', text: '預約成功！' },
    cancelled: { type: 'success', text: '預約已取消。' },
    cancel_late: { type: 'error', text: `開始前 ${bookingRules.MIN_CANCEL_HOURS} 小時內無法取消，請直接聯絡教室。` },
    notfound: { type: 'error', text: '找不到這筆預約。' },
    del_wrong: { type: 'error', text: '密碼不正確，帳號未刪除。' },
    del_blocked: { type: 'error', text: '你的帳號有已通過的檢舉紀錄，為保護其他使用者，無法自行刪除，請聯絡管理員。' },
    del_limit: { type: 'error', text: '嘗試次數過多，請 15 分鐘後再試。' },
    del_confirm: { type: 'error', text: '請勾選確認方塊，才能刪除帳號。' },
    pg_saved: { type: 'success', text: '攝影師檔案已更新。' },
    pg_closed: { type: 'success', text: '已暫停接案，你不會出現在攝影師列表。' },
    pf_added: { type: 'success', text: '作品連結已新增。' },
    pf_removed: { type: 'success', text: '作品連結已刪除。' },
    pf_invalid: { type: 'error', text: `請填寫作品名稱（最多 ${MAX_PORTFOLIO_TITLE} 字）和有效的 http(s) 連結。` },
    pf_limit: { type: 'error', text: `作品集最多 ${MAX_PORTFOLIO_ITEMS} 筆，請先刪除舊的。` },
    pf_dup: { type: 'error', text: '這個連結已經在你的作品集裡了。' },
    pf_needpg: { type: 'error', text: '請先開啟攝影師身份，才能管理作品集。' },
    pg_invalid: { type: 'error', text: `請填寫 ${MIN_PHOTO_PRICE} 到 ${MAX_PHOTO_PRICE} 的時薪，並選擇風格與地區（簡介最多 ${MAX_PHOTO_BIO} 字）。` }
};

function findRoom(idParam) {
    if (!/^\d+$/.test(String(idParam))) return null;
    return rooms[Number(idParam)] || null;
}

app.get('/venues/:id', (req, res) => {
    const room = findRoom(req.params.id);
    if (!room) return res.status(404).send('找不到教室資訊');

    const now = bookingRules.taipeiNow();
    const maxDate = bookingRules.addDays(now.date, bookingRules.MAX_DAYS_AHEAD);
    let date = String(req.query.date || '');
    if (!bookingRules.isValidDate(date) || date < now.date || date > maxDate) date = now.date;

    const booked = new Set(store.listBookedHours(room.id, date));
    const hours = [];
    for (let h = bookingRules.OPEN_HOUR; h < bookingRules.CLOSE_HOUR; h++) {
        const inFuture = date > now.date || h > now.hour;
        hours.push({ hour: h, label: String(h).padStart(2, '0') + ':00', available: inFuture && !booked.has(h) });
    }

    const notice = Object.hasOwn(BOOKING_MESSAGES, req.query.msg) ? BOOKING_MESSAGES[req.query.msg] : null;

    res.render('venues_detail', {
        venue: room,
        date,
        dateText: bookingRules.dateLabel(date),
        minDate: now.date,
        maxDate,
        hours,
        maxDuration: bookingRules.MAX_DURATION,
        notice
    });
});

app.post('/venues/:id/book', (req, res) => {
    const me = req.session.user;
    if (!me) return res.redirect('/login');

    const room = findRoom(req.params.id);
    if (!room) return res.status(404).send('找不到教室資訊');

    const date = String(req.body.date || '');
    const startHour = /^\d+$/.test(String(req.body.startHour)) ? Number(req.body.startHour) : NaN;
    const duration = /^\d+$/.test(String(req.body.duration)) ? Number(req.body.duration) : NaN;
    const back = (code) => res.redirect(`/venues/${room.id}?date=${encodeURIComponent(date.slice(0, 10))}&msg=${code}`);

    const check = bookingRules.validateBooking({ date, startHour, duration });
    if (!check.ok) return back(check.code);

    const now = bookingRules.taipeiNow();
    if (store.countActiveBookings(me.id, now.date, now.hour) >= bookingRules.MAX_ACTIVE_BOOKINGS) return back('limit');

    try {
        store.createBooking(me.id, room.id, date, startHour, duration, room.price * duration);
    } catch (err) {
        if (err && (String(err.code).startsWith('SQLITE_CONSTRAINT') || /constraint failed/i.test(String(err.message)))) return back('taken');
        console.error('預約失敗:', err);
        return back('error');
    }
    res.redirect('/me?msg=booked');
});

app.post('/bookings/:id/cancel', (req, res) => {
    const me = req.session.user;
    if (!me) return res.redirect('/login');

    const id = /^\d+$/.test(req.params.id) ? Number(req.params.id) : NaN;
    const booking = Number.isInteger(id) ? store.getBooking(id) : null;
    // 只能取消自己的預約
    if (!booking || booking.user_id !== me.id) return res.redirect('/me?msg=notfound');
    if (!bookingRules.canCancel(booking)) return res.redirect('/me?msg=cancel_late');

    store.cancelBooking(id, me.id);
    res.redirect('/me?msg=cancelled');
});

app.get('/profile/:username', (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    const target = store.findUserByName(req.params.username);
    if (!target) return res.status(404).send('找不到這位舞者');

    // 只挑要顯示的欄位，絕對不要把整列使用者資料（含密碼雜湊）傳進模板
    const profileData = {
        id: target.id,
        name: target.name,
        avatar: target.name,
        danceType: '舞者',
        intro: "嗨！我是 " + target.name + "。希望能找到志同道合的舞伴一起進步，歡迎私訊我約練喔！",
        reportCount: getReportCount(target.name),
        postCount: store.countPostsByUser(target.id)
    };

    const reviews = store.listReviews(target.id).map(r => ({
        reviewer: r.reviewer_name,
        rating: String(r.rating),
        comment: r.comment || '（沒有留下文字評語）'
    }));

    res.render('profile', {
        profile: profileData,
        reviews: reviews
    });
});

app.post('/portfolio/add', (req, res) => {
    const me = req.session.user;
    if (!me) return res.redirect('/login');

    const pg = store.getPhotographerByUserId(me.id);
    if (!pg || pg.active !== 1) return res.redirect('/me?msg=pf_needpg');

    const title = String(req.body.title || '').trim();
    const url = cleanPortfolioUrl(req.body.url);
    if (!title || title.length > MAX_PORTFOLIO_TITLE || !url) return res.redirect('/me?msg=pf_invalid');
    if (store.countPortfolio(me.id) >= MAX_PORTFOLIO_ITEMS) return res.redirect('/me?msg=pf_limit');

    try {
        store.addPortfolioItem(me.id, title, url);
    } catch (err) {
        if (err && (String(err.code).startsWith('SQLITE_CONSTRAINT') || /constraint failed/i.test(String(err.message)))) {
            return res.redirect('/me?msg=pf_dup');
        }
        throw err;
    }
    res.redirect('/me?msg=pf_added');
});

app.post('/portfolio/:id/delete', (req, res) => {
    const me = req.session.user;
    if (!me) return res.redirect('/login');

    const id = /^\d+$/.test(req.params.id) ? Number(req.params.id) : NaN;
    // 只能刪除自己的作品
    if (Number.isInteger(id)) store.removePortfolioItem(id, me.id);
    res.redirect('/me?msg=pf_removed');
});

app.get('/photographers', (req, res) => {
    const currentStyle = PHOTO_STYLES.includes(req.query.style) ? req.query.style : '全部風格';

    const photographers = store.listPhotographers(currentStyle === '全部風格' ? null : currentStyle).map(p => ({
        id: p.id,
        name: p.name,
        avatar: p.name,
        style: p.style,
        price: p.price,
        location: p.location,
        bio: p.bio,
        rating: p.avg_rating,
        reviewCount: p.review_count
    }));

    res.render('photographers', { photographers, currentStyle, photoStyles: PHOTO_STYLES });
});

app.get('/review', (req, res) => {
    const me = req.session.user;
    if (!me) return res.redirect('/login');

    const target = store.findUserByName(String(req.query.target || '').trim());
    if (!target) return res.redirect('/partner');
    if (target.id === me.id) return res.redirect('/profile/' + encodeURIComponent(target.name));

    const targetUser = {
        name: target.name,
        avatar: target.name,
        danceType: '舞者'
    };

    res.render('review', { targetUser });
});

app.get('/review/photographer', (req, res) => {
    const pg = store.getActivePhotographerByName(String(req.query.target || '').trim());
    if (!pg) return res.redirect('/photographers');

    const me = req.session.user;
    const targetPhotographer = {
        id: pg.id,
        name: pg.name,
        avatar: pg.name,
        style: pg.style,
        rating: pg.avg_rating,
        reviewCount: pg.review_count
    };
    const photoReviews = store.listPhotographerReviews(pg.id).map(r => ({
        name: '舞者 ' + r.reviewer_name,
        rating: String(r.rating),
        tags: r.tags,
        comment: r.comment,
        date: String(r.created_at).slice(0, 10)
    }));

    res.render('review_photographer', {
        targetPhotographer,
        photoReviews,
        portfolio: store.listPortfolio(pg.id),
        canReview: !!me && me.id !== pg.id,
        notice: req.query.msg === 'saved' ? { type: 'success', text: '評價已送出，謝謝你的回饋！' } : null
    });
});

app.post('/submit-photo-review', (req, res) => {
    const me = req.session.user;
    if (!me) return res.redirect('/login');

    const pg = store.getActivePhotographerByName(String(req.body.targetName || '').trim());
    if (!pg || pg.id === me.id) return res.redirect('/photographers');

    const rating = String(req.body.rating || '');
    const comment = String(req.body.comment || '').trim();
    const rawTags = req.body.tags;
    const selectedTags = [...new Set((Array.isArray(rawTags) ? rawTags : rawTags ? [rawTags] : [])
        .filter(tag => PHOTO_REVIEW_TAGS.includes(tag)))];

    const back = `/review/photographer?target=${encodeURIComponent(pg.name)}`;
    if (!/^[1-5]$/.test(rating) || comment.length < 1 || comment.length > MAX_REVIEW_COMMENT) return res.redirect(back);
    if (!reviewLimiter.hit('photo|' + me.id)) return res.status(429).send('送出太頻繁，請稍後再試');

    store.savePhotographerReview(me.id, pg.id, Number(rating), selectedTags, comment);
    store.notify(pg.id, 'review', `${me.name} 給了你 ${rating} 星的攝影師評價`, `/review/photographer?target=${encodeURIComponent(pg.name)}`);
    res.redirect(back + '&msg=saved');
});

app.get('/share', (req, res) => res.render('share'));

app.post('/submit-review', (req, res) => {
    const me = req.session.user;
    if (!me) return res.redirect('/login');

    const target = store.findUserByName(String(req.body.targetName || '').trim());
    if (!target || target.id === me.id) return res.redirect('/partner');

    const rating = String(req.body.rating || '');
    const comment = String(req.body.comment || '').trim();
    if (!/^[1-5]$/.test(rating) || comment.length > MAX_REVIEW_COMMENT) {
        return res.redirect('/review?target=' + encodeURIComponent(target.name));
    }
    if (!reviewLimiter.hit('partner|' + me.id)) return res.status(429).send('送出太頻繁，請稍後再試');

    // 同一位使用者只保留你對他的最新一則評價
    store.saveReview(me.id, target.id, Number(rating), comment);
    store.notify(target.id, 'review', `${me.name} 給了你 ${rating} 星的夥伴評價`, `/profile/${encodeURIComponent(target.name)}`);
    res.redirect('/profile/' + encodeURIComponent(target.name));
});

// --- 即時私訊（Socket.io）---
const server = http.createServer(app);
const io = new Server(server);

// Socket 與網頁共用同一份 session；身分一律以 session 為準，不信任前端傳來的使用者 ID
io.engine.use(sessionMiddleware);

io.use((socket, next) => {
    const sessUser = socket.request.session && socket.request.session.user;
    if (!sessUser || !Number.isInteger(sessUser.id)) return next(new Error('unauthorized'));
    if (isBanned(sessUser)) return next(new Error('banned'));
    socket.data.userId = sessUser.id;
    next();
});

io.on('connection', (socket) => {
    const me = socket.data.userId;
    // 每位使用者一個個人房間：同一帳號開多個分頁都收得到
    socket.join(`user:${me}`);

    socket.on('send_message', (payload, ack) => {
        const reply = typeof ack === 'function' ? ack : () => {};
        try {
            const toId = Number(payload && payload.to);
            const text = String((payload && payload.text) || '').trim();

            if (!Number.isInteger(toId) || toId === me || !store.findUserById(toId)) {
                return reply({ ok: false, error: '無法傳送給這位使用者' });
            }
            if (!text) return reply({ ok: false, error: '訊息不能是空白' });
            if (text.length > MAX_MESSAGE_LENGTH) {
                return reply({ ok: false, error: `訊息最多 ${MAX_MESSAGE_LENGTH} 個字` });
            }

            const msg = store.createMessage(me, toId, text);
            const out = {
                id: msg.id,
                senderId: me,
                receiverId: toId,
                text: msg.text,
                time: formatClock(msg.created_at)
            };

            io.to(`user:${toId}`).emit('receive_message', out);
            socket.to(`user:${me}`).emit('message_sent', out); // 同帳號的其他分頁同步顯示
            reply({ ok: true, message: out });
        } catch (err) {
            console.error('傳送訊息失敗:', err);
            reply({ ok: false, error: '傳送失敗，請稍後再試' });
        }
    });

    // 對方正開著聊天室時，收到訊息即標記為已讀
    socket.on('mark_read', (payload) => {
        const fromId = Number(payload && payload.from);
        if (Number.isInteger(fromId)) store.markConversationRead(me, fromId);
    });
});

const PORT = process.env.PORT || 3000;
server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`埠 ${PORT} 已被占用，請先關閉舊的伺服器（例如 Stop-Process -Name node -Force）再重試。`);
    } else {
        console.error('伺服器錯誤:', err);
    }
    process.exit(1);
});
server.listen(PORT, () => console.log(`DanceHub 伺服器已啟動：http://localhost:${PORT}`));
