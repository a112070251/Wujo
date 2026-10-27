// 展覽用的示範資料：只有在設定 SEED_DEMO=1 與 DEMO_PASSWORD 時才會建立。
// 免費方案的資料庫每次重啟都會清空，所以每次啟動時若「還沒有任何使用者」就重新建立一次。
const bookingRules = require('./bookings');

const DANCERS = [
    { name: '小雅', email: 'demo.xiaoya@example.com' },
    { name: '阿強', email: 'demo.aqiang@example.com' },
    { name: '小美', email: 'demo.xiaomei@example.com' }
];

const PHOTOGRAPHERS = [
    {
        name: '小明', email: 'demo.xiaoming@example.com',
        price: 1500, style: '街舞動態', location: '台北',
        bio: '專拍街舞與 Breaking，擅長動態運鏡，通常隔天交初剪。',
        works: [['街舞 Cypher 紀錄', 'https://example.com/xiaoming/cypher'], ['Breaking 比賽直拍', 'https://example.com/xiaoming/breaking']]
    },
    {
        name: '阿華', email: 'demo.ahua@example.com',
        price: 2000, style: '活動劇照', location: '台中',
        bio: '舞台劇照與成果展紀錄，提供精修照片。',
        works: [['成果展劇照', 'https://example.com/ahua/showcase']]
    }
];

const POSTS = [
    ['小雅', '想找 K-Pop 舞伴，每週二晚上在大安區練舞，新手也歡迎！', ['K-Pop']],
    ['阿強', '找 Breaking 練習夥伴，一起練基礎動作與地板，週末下午最佳。', ['Breaking', '練基礎']],
    ['小美', '年底有街舞比賽，徵求同組隊友，想挑戰看看！', ['找比賽', '街舞']],
    ['小雅', '想拍一支 HipHop 舞蹈短片，找攝影師與舞伴，歡迎私訊。', ['拍片', 'HipHop']]
];

function seedDemo(store, bcrypt, password, adminEmail = '') {
    if (store.db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return false;

    const hash = bcrypt.hashSync(password, 10);
    const ids = {};
    for (const u of [...DANCERS, ...PHOTOGRAPHERS]) ids[u.name] = store.createUser(u.name, u.email, hash);
    const bad = store.createUser('放鳥小王', 'demo.noshow@example.com', hash);
    // 管理員帳號：用 ADMIN_EMAILS 的第一個信箱，重啟後仍能登入示範檢舉審核
    if (adminEmail) ids['管理員'] = store.createUser('管理員', adminEmail, hash);

    for (const [author, content, tags] of POSTS) store.createPost(ids[author], content, tags);

    for (const p of PHOTOGRAPHERS) {
        store.savePhotographer(ids[p.name], { price: p.price, style: p.style, location: p.location, bio: p.bio });
        for (const [title, url] of p.works) store.addPortfolioItem(ids[p.name], title, url);
    }

    store.saveReview(ids['阿強'], ids['小雅'], 5, '練舞很準時、教學有耐心，推薦！');
    store.saveReview(ids['小雅'], ids['阿強'], 4, '基本功紮實，節奏感很好。');
    store.savePhotographerReview(ids['小雅'], ids['小明'], 5, ['出片極快', '運鏡很穩'], '分鏡切得很棒，隔天就拿到初剪，大推！');
    store.savePhotographerReview(ids['阿強'], ids['小明'], 4, ['很會引導動作'], '很會引導不習慣面對鏡頭的舞者，燈光也好看。');
    store.savePhotographerReview(ids['小美'], ids['阿華'], 5, ['配樂切點精準'], '成果展的劇照很有氛圍，溝通順暢。');

    store.createMessage(ids['小雅'], ids['阿強'], '嗨！看到你的貼文，這週末有空一起練嗎？');
    store.createMessage(ids['阿強'], ids['小雅'], '可以啊，週六下午兩點，教室見！');

    // 黑名單頁示範：兩筆已通過的檢舉（未達停權門檻）
    for (const reporter of ['小雅', '阿強']) {
        const rid = store.createReport(ids[reporter], bad, '惡意取消或放鳥', '約好練舞卻臨時沒出現，也沒有事先告知。', '');
        store.reviewReport(rid, ids['小明'], 'approve');
    }

    // 一筆待審核的檢舉，讓管理員審核頁有東西可以示範
    store.createReport(ids['小美'], bad, '言論騷擾', '在群組裡對其他舞者說了不禮貌的話。', '');

    // 示範預約：小雅三天後在大安旗艦館 18:00–20:00
    const day = bookingRules.addDays(bookingRules.taipeiNow().date, 3);
    store.createBooking(ids['小雅'], 0, day, 18, 2, 1000);

    return true;
}

module.exports = { seedDemo };
