const express = require('express');
const bodyParser = require('body-parser');
const app = express();
const path = require('path');
const session = require('express-session');

// --- 基礎設定 ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));

// --- 1. Session 設定 ---
app.use(session({
    secret: 'dancehub-secret',
    resave: false,
    saveUninitialized: true
}));

// --- 2. 模擬資料庫內容 ---
// ⭕ 修正：將 image 換成穩定的高質感遠端圖片網址，確保畫面 100% 抓得到圖不破圖！
const rooms = [
    { name: "Studio", dist: "大安區", price: 500, image: "https://images.unsplash.com/photo-1508700115892-45ecd05ae2ad?w=500&auto=format&fit=crop" },
    { name: "dance", dist: "中正區", price: 450, image: "https://images.unsplash.com/photo-1547153760-18fc86324498?w=500&auto=format&fit=crop" }
];

// 用戶檢舉計數器
const userReportsCounter = {
    'bad': 5,
    'Ghoster': 3,
    '256': 1
};

// 黑名單展示資料
const blacklistUsers = [
    { 
        name: 'bad', 
        reasons: ['惡意取消'], 
        reason: '惡意取消', 
        date: '2026-03-10', 
        avatar: 'bad',
        reportCount: 5
    },
    { 
        name: 'Ghoster', 
        reasons: ['放鳥次數過多'], 
        reason: '放鳥次數過多', 
        date: '2026-03-05', 
        avatar: 'Ghost',
        reportCount: 3
    }
];

const allPosts = [
    { id: "1", author: "小雅", avatar: "小雅", content: "4月練舞，北車，缺三人。", time: "2 小時前", hashtags: ["找比賽", "K-Pop"], lastMsg: "好喔！妳平常都在哪邊練習？" },
    { id: "2", author: "小新", avatar: "小新", content: "12月，風格偏HipHop，希望有比賽經驗。", time: "5 小時前", hashtags: ["練基礎", "HipHop", "找比賽"], lastMsg: "那明天 18:00 見！" },
    { id: "3", author: "阿強", avatar: "阿強", content: "想找人一起在西門町拍 Dance Cover！", time: "10 小時前", hashtags: ["拍片", "街舞", "HipHop"], lastMsg: "嘿，有興趣一起拍片嗎？" }
];

// --- 3. 全域變數中間件 ---
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    res.locals.hasNewMsg = !!req.session.user;
    next();
});
app.use(express.static('public'));

// --- 4. 路由開始 ---

// 首頁路由
app.get('/', (req, res) => {
    res.render('index', { featuredPost: allPosts[0], featuredVenue: rooms[0] });
});

app.get('/login', (req, res) => res.render('login'));

// 登入邏輯
app.post('/login', (req, res) => {
    const { username } = req.body;
    
    if (!username) return res.redirect('/login');

    const currentReports = userReportsCounter[username] || 0;
    
    if (currentReports >= 5) {
        return res.send(`
            <script>
                alert('您的帳號因被檢舉次數達 ${currentReports} 次，已被系統永久停權。');
                window.location.href = '/login';
            </script>
        `);
    }

    req.session.user = { 
        name: username, 
        avatarSeed: username, 
        reports: currentReports,
        isWarning: currentReports === 4 
    }; 
    
    return res.redirect('/me');
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });

app.get('/me', (req, res) => {
    // 檢查 Session 裡面有沒有登入過的使用者資料
    if (!req.session.user) {
        // 如果沒有，強制轉址踢回登入頁面
        return res.redirect('/login'); 
    }
    
    // 如果有登入，才允許載入頁面，並把使用者資料傳過去
    res.render('me', { user: req.session.user });
});

app.get('/blacklist', (req, res) => {
    const searchQuery = req.query.search || '';
    let filteredList = blacklistUsers;

    if (searchQuery) {
        filteredList = blacklistUsers.filter(u => 
            u.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
            u.reason.includes(searchQuery)
        );
    }
    res.render('blacklist', { blacklisted: filteredList, searchQuery: searchQuery });
});

app.post('/submit-blacklist', (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    const { targetName, reason } = req.body;
    if (targetName && reason) {
        userReportsCounter[targetName] = (userReportsCounter[targetName] || 0) + 1;
        const currentTotal = userReportsCounter[targetName];

        const existingIdx = blacklistUsers.findIndex(u => u.name.toLowerCase() === targetName.toLowerCase());

        if (existingIdx !== -1) {
            const user = blacklistUsers[existingIdx];
            if (!user.reasons) user.reasons = [user.reason];
            user.reasons.push(reason);
            user.reason = user.reasons.join(' | ');
            user.reportCount = currentTotal;
            user.date = new Date().toISOString().split('T')[0];
            blacklistUsers.splice(existingIdx, 1);
            blacklistUsers.unshift(user);
        } else {
            blacklistUsers.unshift({
                name: targetName,
                reasons: [reason],
                reason: reason,
                date: new Date().toISOString().split('T')[0],
                avatar: targetName,
                reportCount: currentTotal
            });
        }
    }
    res.redirect('/blacklist');
});

app.get('/partner', (req, res) => {
    const currentTag = req.query.tag || '全部';
    let filteredPosts = (currentTag !== '全部') ? allPosts.filter(p => p.hashtags.includes(currentTag)) : allPosts;
    res.render('partner_page', { posts: filteredPosts, currentTag: currentTag });
});

app.get('/messages', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const chatList = allPosts.map(post => ({ id: post.id, name: post.author, lastMsg: post.lastMsg, time: post.time, avatar: post.author }));
    res.render('messages', { chatList: chatList });
});

// A. 帶 ID 的聊天路由 (點擊特定貼文或訊息進來時)
app.get('/chat/:id', (req, res) => {
    // 這裡通常會根據網址的 id 去資料庫或陣列撈出對方的資料
    // 以下先用跟你 message.ejs 對應的模擬資料做示範：
    const chatTarget = {
        id: req.params.id,
        name: "測試舞者", // 這裡之後可以改成從資料庫撈出的真實姓名
        avatar: "avatar_seed_123" // 這裡放 DiceBear 的 seed
    };

    // 🎯 關鍵：一定要把 chatTarget 傳進去！
    res.render('chat', { chatTarget: chatTarget }); 
});

// ⭕ B. 新增：純 /chat 備用安全路由 (點擊下方導覽列的聊天直接進來時，抓第一個舞伴當預設值)
app.get('/chat', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    // 預設抓貼文名單的第一個作者「小雅」
    const defaultPartner = { name: allPosts[0].author, avatar: allPosts[0].author };
    res.render('chat', { partner: defaultPartner });
});

// 1. 列表頁維持複數 /venues
app.get('/venues', (req, res) => {
    res.render('venues_page', { rooms });
});

// 2. 詳細頁維持複數 /venues/:id
app.get('/venues/:id', (req, res) => {
    const roomData = rooms[req.params.id]; 
    if (roomData) {
        res.render('venues_detail', { venue: roomData }); 
    } else {
        res.status(404).send("找不到教室資訊");
    }
});

// 查看他人個人檔案
app.get('/profile/:username', (req, res) => {
    // 💡 核心修正：沒登入的人點進來，無條件踢回去登入頁！
    if (!req.session.user) {
        return res.redirect('/login');
    }

    const targetName = req.params.username;
    const reports = userReportsCounter[targetName] || 0;
    
    const profileData = {
        name: targetName,
        avatar: targetName,
        danceType: targetName === "阿強" ? "Breaking / Popping" : "K-Pop / HipHop",
        intro: "嗨！我是" + targetName + "。希望能找到志同道合的舞伴一起進步，歡迎私訊我約練喔！",
        reportCount: reports
    };

    res.render('profile', { profile: profileData });
});

// 找攝影師
app.get('/photographers', (req, res) => {
    const photographers = [
        { name: "小明", avatar: "XiaoMing", style: "街舞動態攝影", price: "1500/hr", location: "台北" },
        { name: "阿華", avatar: "AhHua", style: "舞台劇照", price: "2000/hr", location: "台中" }
    ];
    res.render('photographers', { photographers });
});

app.get('/review', (req, res) => {
    const targetName = req.query.target;
    const targetUser = {
        name: targetName || "神祕舞者",
        avatar: targetName || "default",
        danceType: "K-Pop / Urban"
    };
    res.render('review', { targetUser });
});

app.get('/share', (req, res) => res.render('share'));
app.post('/submit-review', (req, res) => res.redirect('/me'));

app.listen(3000, () => console.log('DanceHub 伺服器已啟動：http://localhost:3000'));