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

const rooms = [
    { id: 0, name: "大安旗艦館", dist: "大安區", price: 500, lat: 25.0339, lng: 121.5434, image: "https://images.unsplash.com/photo-1508700115892-45ecd05ae2ad?w=500&auto=format&fit=crop" },
    { id: 1, name: "中正紀念堂館", dist: "中正區", price: 450, lat: 25.0352, lng: 121.5197, image: "https://images.unsplash.com/photo-1547153760-18fc86324498?w=500&auto=format&fit=crop" },
    { id: 2, name: "信義 101 館", dist: "信義區", price: 600, lat: 25.0336, lng: 121.5646, image: "https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?w=500&auto=format&fit=crop" }
];

const dynamicPhotographers = [
    { name: "小明", avatar: "XiaoMing", style: "街舞動態攝影", price: "1500", location: "台北" },
    { name: "阿華", avatar: "AhHua", style: "舞台劇照", price: "2000", location: "台中" }
];

const photoReviews = [
    { name: "舞者 小雅", rating: "5", tags: ["出片極快", "運鏡很穩"], comment: "分鏡切得超級棒！跳 K-Pop 副歌時的推進鏡頭很有震撼力，而且拍攝完隔天就拿到初剪檔案了，效率高到嚇人，大推！", date: "2026-06-15" },
    { name: "舞者 阿強", rating: "4", tags: ["很會引導動作"], comment: "很會引導不習慣面對鏡頭的舞者，燈光打得非常好看。美中不足是當天教室冷氣有點弱，但攝影師專業度沒話說！", date: "2026-05-29" }
];

// 用戶檢舉計數器
const userReportsCounter = {
    'bad': 5,
    'Ghoster': 3,
    '256': 1
};

const partnerReviews = {
    '阿強': [
        { reviewer: '小雅', rating: '5', comment: '這週二一起在 Kinetics Studio 練 Breaking 非常愉快，排舞教學很有耐心！' }
    ],
    '小雅': [
        { reviewer: '阿強', rating: '4', comment: '非常有活力的夥伴，練舞時間觀念很好，基本功很紮實！' }
    ]
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

// --- 尋找這段原本的 /me 路由，並在其下方補上 POST 路由 ---
app.get('/me', (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login'); 
    }
    
    // 初始化設定，防呆不寫死
    if (typeof req.session.user.isPhotographer === 'undefined') {
        req.session.user.isPhotographer = false;
        req.session.user.photoPrice = "0";
        req.session.user.photoStyle = "";
    }
    
    res.render('me', { user: req.session.user });
});

// 🎯 【關鍵修正】確切移至此處！確保在所有動態路由（如 /venues/:id）之上
app.post('/update-photographer', (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    const { isPhotographer, photoPrice, photoStyle } = req.body;

    // 將資料動態更新進 Session 記憶體中，實時生效
    req.session.user.isPhotographer = (isPhotographer === 'true');
    req.session.user.photoPrice = photoPrice || "0";
    req.session.user.photoStyle = photoStyle || "";

    res.redirect('/me'); // 儲存後導回個人頁面刷新檢視
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

// A. 帶 ID 的聊天路由
app.get('/chat/:id', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    
    // 根據貼文 ID 撈出對應的作者
    const post = allPosts.find(p => p.id === req.params.id);
    const chatTarget = post ? { name: post.author, avatar: post.author } : { name: "測試舞者", avatar: "avatar_seed_123" };

    res.render('chat', { chatTarget }); 
});

// B. 純 /chat 備用安全路由
app.get('/chat', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const chatTarget = { name: allPosts[0].author, avatar: allPosts[0].author };
    
    res.render('chat', { chatTarget }); // 統一使用 chatTarget
});

app.get('/api/current-location', (req, res) => {
    // 預留給前端 Fetch 使用，動態回傳附近場館
    res.json({ success: true, district: "大安區", lat: 25.0339, lng: 121.5434 });
});

// 1. 列表頁維持複數 /venues
app.get('/api/nearest-venue', (req, res) => {
    const userLat = parseFloat(req.query.lat);
    const userLng = parseFloat(req.query.lng);

    if (!userLat || !userLng) {
        return res.status(400).json({ error: "無法取得您的經緯度" });
    }

    // 地球半徑 (公里)
    const R = 6371; 
    let nearestRoom = null;
    let minDistance = Infinity;

    rooms.forEach(room => {
        // 使用 Haversine 公式計算兩點間的真實直線距離
        const dLat = (room.lat - userLat) * Math.PI / 180;
        const dLng = (room.lng - userLng) * Math.PI / 180;
        const a = 
            Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(userLat * Math.PI / 180) * Math.cos(room.lat * Math.PI / 180) * Math.sin(dLng/2) * Math.sin(dLng/2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        const distance = R * c; // 得到的距離 (公里)

        if (distance < minDistance) {
            minDistance = distance;
            nearestRoom = { ...room, distance: distance.toFixed(2) }; // 保留兩位小數
        }
    });

    res.json({ nearestRoom });
});

// 3. 修改原本的 /venues 路由，確保能渲染完整的 rooms
app.get('/venues', (req, res) => {
    res.render('venues_page', { rooms: rooms });
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

app.get('/profile/:username', (req, res) => {
    // 💡 核心修正：沒登入的人點進來，無條件踢回去登入頁！
    if (!req.session.user) {
        return res.redirect('/login');
    }

    const targetName = req.params.username;
    const reports = userReportsCounter[targetName] || 0;
    
    // 🟢 修正原先程式碼變數未定義的錯誤，動態產出該舞者 profile 資料
    const profileData = {
        name: targetName,
        avatar: targetName,
        danceType: targetName === "阿強" ? "Breaking / Popping" : "K-Pop / HipHop",
        intro: "嗨！我是 " + targetName + "。希望能找到志同道合的舞伴一起進步，歡迎私訊我約練喔！",
        reportCount: reports
    };

    // 🟢 動態撈出屬於這個使用者的評價紀錄，若無則給予空陣列防禦
    const reviews = partnerReviews[targetName] || [];

    res.render('profile', {
        profile: profileData,
        reviews: reviews
    });
});

// 找攝影師
app.get('/photographers', (req, res) => {
    // 獲取網址參數，如果沒有傳，預設為 '全部風格'
    const currentStyle = req.query.style || '全部風格';
    
    // 建立完整的攝影師儲存庫
    let currentList = [
        { name: "小明", avatar: "XiaoMing", style: "街舞動態", price: "1500", location: "台北" },
        { name: "阿華", avatar: "AhHua", style: "活動劇照", price: "2000", location: "台中" }
    ];

    // 動態檢查當前登入使用者是否開啟攝影接案，並推入列表中
    if (req.session.user && req.session.user.isPhotographer) {
        const alreadyExists = currentList.some(p => p.name === req.session.user.name);
        if (!alreadyExists) {
            currentList.push({
                name: req.session.user.name,
                avatar: req.session.user.name,
                style: req.session.user.photoStyle || "未填寫風格",
                price: req.session.user.photoPrice || "0",
                location: "台北"
            });
        }
    }

    // 【核心篩選邏輯】如果不是選擇 '全部風格'，就過濾出符合風格的攝影師
    let filteredPhotographers = currentList;
    if (currentStyle !== '全部風格') {
        filteredPhotographers = currentList.filter(p => p.style.includes(currentStyle));
    }

    // 將過濾後的名單與當前選中的風格傳給前端 EJS
    res.render('photographers', { 
        photographers: filteredPhotographers, 
        currentStyle: currentStyle 
    });
});

app.get('/review', (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    const targetName = req.query.target;
    
    if (!targetName) {
        return res.redirect('/partner'); // 如果沒帶目標，防呆踢回夥伴頁
    }

    // 🟢 動態配置：根據點擊的目標名字，自動生成對應的資料
    const targetUser = {
        name: targetName,
        avatar: targetName, // 讓頭像 seed 直接等於名字，跟 profile 頁面完全同步
        // 根據特定名字給予舞風，或者給予通用預設值
        danceType: targetName === "阿強" ? "Breaking / Popping" : "K-Pop / HipHop"
    };

    res.render('review', { targetUser });
});

app.get('/review/photographer', (req, res) => {
    const targetName = req.query.target;
    const targetPhotographer = {
        name: targetName || "神祕攝影師",
        avatar: targetName || "default",
        style: "街舞動態攝影 / 韓系直拍",
        rating: "4.9"
    };
    // 傳送 targetPhotographer 以及動態的 photoReviews 陣列
    res.render('review_photographer', { targetPhotographer, photoReviews });
});

app.post('/submit-photo-review', (req, res) => {
    const { targetName, rating, tags, comment } = req.body;
    const userName = req.session.user ? req.session.user.name : "匿名舞者";
    
    // 處理前端送過來的複選標籤資料（如果是單選會是字串，複選是陣列，沒選則是 undefined）
    let selectedTags = [];
    if (tags) {
        selectedTags = Array.isArray(tags) ? tags : [tags];
    }

    // 將新評價推入全域陣列的最前端（最新的顯示在最上面）
    photoReviews.unshift({
        name: "舞者 " + userName,
        rating: rating,
        tags: selectedTags,
        comment: comment,
        date: new Date().toISOString().split('T')[0] // 動態生成今天日期
    });

    // 重新導向回該攝影師的評價頁面
    res.redirect(`/review/photographer?target=${encodeURIComponent(targetName)}`);
});

app.get('/share', (req, res) => res.render('share'));
app.post('/submit-review', (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    const { targetName, rating, comment } = req.body;
    const reviewerName = req.session.user.name;

    if (targetName) {
        // 如果這個被評價人還沒有評價紀錄陣列，先初始化它
        if (!partnerReviews[targetName]) {
            partnerReviews[targetName] = [];
        }

        // 將新寫好的評價推入該舞者的資料最前端
        partnerReviews[targetName].unshift({
            reviewer: reviewerName,
            rating: rating || "5",
            comment: comment || "這位夥伴很棒！"
        });

        // 🎯 核心需求：評價完畢後，直接動態重導向跳轉到「該名對方的個人檔案頁面」
        return res.redirect(`/profile/${encodeURIComponent(targetName)}`);
    }

    res.redirect('/partner');
});

app.listen(3000, () => console.log('DanceHub 伺服器已啟動：http://localhost:3000'));