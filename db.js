// SQLite 資料庫連線、資料表與查詢函式
const path = require('path');
const Database = require('better-sqlite3');

const db = new Database(process.env.DB_PATH || path.join(__dirname, 'dancehub.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        name          TEXT NOT NULL UNIQUE COLLATE NOCASE,
        email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS posts (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        author_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content    TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS post_tags (
        post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        tag     TEXT NOT NULL,
        PRIMARY KEY (post_id, tag)
    );

    CREATE TABLE IF NOT EXISTS messages (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        text        TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        read_at     TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(id DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(sender_id, receiver_id, id);
    CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(receiver_id, read_at);

    -- 檢舉：同一人對同一對象只能檢舉一次、不能檢舉自己；管理員審核通過才算數
    CREATE TABLE IF NOT EXISTS reports (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        target_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        category    TEXT NOT NULL,
        detail      TEXT NOT NULL,
        evidence    TEXT NOT NULL DEFAULT '',
        status      TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'rejected', 'revoked')),
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        reviewed_at TEXT,
        reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        UNIQUE (reporter_id, target_id),
        CHECK (reporter_id <> target_id)
    );

    CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_id, status);
    CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, id);

    -- 預約：date 為台北日期 YYYY-MM-DD；booking_slots 每個被占用的整點一列，
    -- 以主鍵 (room_id, date, hour) 保證同一教室同一小時不會被重複預約
    CREATE TABLE IF NOT EXISTS bookings (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        room_id      INTEGER NOT NULL,
        date         TEXT NOT NULL,
        start_hour   INTEGER NOT NULL,
        duration     INTEGER NOT NULL,
        price        INTEGER NOT NULL,
        status       TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        cancelled_at TEXT
    );

    CREATE TABLE IF NOT EXISTS booking_slots (
        booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
        room_id    INTEGER NOT NULL,
        date       TEXT NOT NULL,
        hour       INTEGER NOT NULL,
        PRIMARY KEY (room_id, date, hour)
    );

    CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings(user_id, status, date);

    -- 夥伴評價：每人對同一位使用者只有一則（再送出會更新），不能評價自己
    CREATE TABLE IF NOT EXISTS partner_reviews (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        reviewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        target_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        rating      INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
        comment     TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (reviewer_id, target_id),
        CHECK (reviewer_id <> target_id)
    );

    CREATE INDEX IF NOT EXISTS idx_partner_reviews_target ON partner_reviews(target_id, id);

    -- 攝影師檔案：任何使用者都能開啟，active = 0 代表暫停接案（不出現在列表）
    CREATE TABLE IF NOT EXISTS photographers (
        user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        price      INTEGER NOT NULL CHECK (price BETWEEN 0 AND 100000),
        style      TEXT NOT NULL,
        location   TEXT NOT NULL,
        bio        TEXT NOT NULL DEFAULT '',
        active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 攝影師評價：每人對同一位攝影師只有一則（再送出會更新），不能評價自己
    CREATE TABLE IF NOT EXISTS photographer_reviews (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        reviewer_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        photographer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        rating          INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
        tags            TEXT NOT NULL DEFAULT '',
        comment         TEXT NOT NULL,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (reviewer_id, photographer_id),
        CHECK (reviewer_id <> photographer_id)
    );

    CREATE INDEX IF NOT EXISTS idx_photo_reviews_target ON photographer_reviews(photographer_id, id);

    -- 通知：type 只用來分類圖示；link 一律是站內路徑
    CREATE TABLE IF NOT EXISTS notifications (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type       TEXT NOT NULL,
        text       TEXT NOT NULL,
        link       TEXT NOT NULL DEFAULT '',
        read_at    TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at, id);

    -- 拍攝邀請：客戶向攝影師提出時段，攝影師確認或婉拒；已確認的拍攝在同一時段不能重疊
    CREATE TABLE IF NOT EXISTS shoot_requests (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        photographer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        date            TEXT NOT NULL,
        start_hour      INTEGER NOT NULL,
        duration        INTEGER NOT NULL,
        price           INTEGER NOT NULL,
        note            TEXT NOT NULL DEFAULT '',
        status          TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        responded_at    TEXT,
        CHECK (client_id <> photographer_id)
    );

    -- 同一客戶對同一攝影師、同一開始時間，進行中的邀請只能有一筆
    CREATE UNIQUE INDEX IF NOT EXISTS idx_shoot_dup
        ON shoot_requests(client_id, photographer_id, date, start_hour) WHERE status IN ('pending', 'accepted');
    CREATE INDEX IF NOT EXISTS idx_shoot_photographer ON shoot_requests(photographer_id, status, date);
    CREATE INDEX IF NOT EXISTS idx_shoot_client ON shoot_requests(client_id, status, date);

    -- 攝影師作品集：只存外部連結（YouTube、Instagram、雲端相簿等）
    CREATE TABLE IF NOT EXISTS portfolio_items (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title      TEXT NOT NULL,
        url        TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (user_id, url)
    );
`);

const stmts = {
    // --- users ---
    userById: db.prepare('SELECT id, name, email, created_at FROM users WHERE id = ?'),
    userWithHash: db.prepare('SELECT id, name, email, password_hash FROM users WHERE id = ?'),
    deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
    byName: db.prepare('SELECT * FROM users WHERE name = ?'),
    byEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    byLogin: db.prepare('SELECT * FROM users WHERE name = ? OR email = ?'),
    insertUser: db.prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)'),

    // --- posts ---
    insertPost: db.prepare('INSERT INTO posts (author_id, content) VALUES (?, ?)'),
    insertTag: db.prepare('INSERT OR IGNORE INTO post_tags (post_id, tag) VALUES (?, ?)'),
    listPosts: db.prepare(`
        SELECT p.id, p.content, p.created_at,
               u.id AS author_id, u.name AS author_name,
               (SELECT group_concat(t.tag, ',') FROM post_tags t WHERE t.post_id = p.id) AS tags
        FROM posts p
        JOIN users u ON u.id = p.author_id
        WHERE (@tag = '' OR EXISTS (SELECT 1 FROM post_tags t WHERE t.post_id = p.id AND t.tag = @tag))
          AND (@like = '' OR p.content LIKE @like ESCAPE '\\' OR u.name LIKE @like ESCAPE '\\')
        ORDER BY p.id DESC
        LIMIT @limit
    `),
    countPostsByUser: db.prepare('SELECT COUNT(*) AS n FROM posts WHERE author_id = ?'),

    // --- messages ---
    insertMessage: db.prepare('INSERT INTO messages (sender_id, receiver_id, text) VALUES (?, ?, ?)'),
    messageById: db.prepare('SELECT * FROM messages WHERE id = ?'),
    conversation: db.prepare(`
        SELECT * FROM (
            SELECT * FROM messages
            WHERE (sender_id = @a AND receiver_id = @b) OR (sender_id = @b AND receiver_id = @a)
            ORDER BY id DESC
            LIMIT @limit
        ) ORDER BY id ASC
    `),
    markRead: db.prepare(`
        UPDATE messages SET read_at = datetime('now')
        WHERE receiver_id = ? AND sender_id = ? AND read_at IS NULL
    `),
    countUnread: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE receiver_id = ? AND read_at IS NULL'),
    conversations: db.prepare(`
        SELECT u.id AS partner_id, u.name AS partner_name,
               m.text AS last_text, m.created_at AS last_at, m.sender_id AS last_sender_id,
               (SELECT COUNT(*) FROM messages x
                 WHERE x.sender_id = u.id AND x.receiver_id = @me AND x.read_at IS NULL) AS unread
        FROM (
            SELECT CASE WHEN sender_id = @me THEN receiver_id ELSE sender_id END AS partner_id,
                   MAX(id) AS last_id
            FROM messages
            WHERE sender_id = @me OR receiver_id = @me
            GROUP BY partner_id
        ) c
        JOIN messages m ON m.id = c.last_id
        JOIN users u ON u.id = c.partner_id
        ORDER BY m.id DESC
    `)
};

// --- 檢舉相關查詢 ---
// 已審核通過的檢舉達到這個數量就會被停權
const REPORT_BAN_THRESHOLD = 5;

const REPORT_SELECT = `
    SELECT r.*, rep.name AS reporter_name, tgt.name AS target_name,
           (SELECT COUNT(*) FROM reports x
             WHERE x.target_id = r.target_id AND x.status = 'approved') AS target_approved
    FROM reports r
    JOIN users rep ON rep.id = r.reporter_id
    JOIN users tgt ON tgt.id = r.target_id
`;

const reportStmts = {
    insert: db.prepare('INSERT INTO reports (reporter_id, target_id, category, detail, evidence) VALUES (?, ?, ?, ?, ?)'),
    exists: db.prepare('SELECT 1 AS found FROM reports WHERE reporter_id = ? AND target_id = ?'),
    byId: db.prepare(REPORT_SELECT + ' WHERE r.id = ?'),
    listByStatus: db.prepare(REPORT_SELECT + ' WHERE r.status = ? ORDER BY r.id DESC LIMIT ?'),
    countByStatus: db.prepare('SELECT COUNT(*) AS n FROM reports WHERE status = ?'),
    recentByReporter: db.prepare(`
        SELECT COUNT(*) AS n FROM reports
        WHERE reporter_id = ? AND created_at >= datetime('now', ?)
    `),
    approvedCount: db.prepare(`SELECT COUNT(*) AS n FROM reports WHERE target_id = ? AND status = 'approved'`),
    approvedCountByName: db.prepare(`
        SELECT COUNT(*) AS n FROM reports r JOIN users u ON u.id = r.target_id
        WHERE u.name = ? AND r.status = 'approved'
    `),
    review: db.prepare(`
        UPDATE reports SET status = @to, reviewed_at = datetime('now'), reviewed_by = @admin
        WHERE id = @id AND status = @from
    `),
    // 公開黑名單：只看審核通過的檢舉；公開的只有類別與次數，不含檢舉人與詳細內容
    blacklist: db.prepare(`
        SELECT u.id, u.name,
               COUNT(r.id) AS report_count,
               MAX(r.reviewed_at) AS last_at,
               group_concat(DISTINCT r.category) AS categories
        FROM users u
        JOIN reports r ON r.target_id = u.id AND r.status = 'approved'
        GROUP BY u.id
        HAVING (@like = '' OR u.name LIKE @like ESCAPE '\\'
                OR group_concat(DISTINCT r.category) LIKE @like ESCAPE '\\')
        ORDER BY last_at DESC, u.id DESC
        LIMIT @limit
    `)
};

// 審核動作 → [原本狀態, 新狀態]
const REVIEW_TRANSITIONS = {
    approve: ['pending', 'approved'],
    reject: ['pending', 'rejected'],
    revoke: ['approved', 'revoked']
};

// LIKE 的萬用字元要跳脫，避免使用者輸入 % 或 _ 影響搜尋結果
function toLikePattern(q) {
    const text = String(q || '').trim();
    if (!text) return '';
    return '%' + text.replace(/[\\%_]/g, '\\$&') + '%';
}

function parsePost(row) {
    return { ...row, tags: row.tags ? row.tags.split(',') : [] };
}

const createPostTx = db.transaction((authorId, content, tags) => {
    const postId = stmts.insertPost.run(authorId, content).lastInsertRowid;
    for (const tag of tags) stmts.insertTag.run(postId, tag);
    return postId;
});

const reviewStmts = {
    upsert: db.prepare(`INSERT INTO partner_reviews (reviewer_id, target_id, rating, comment) VALUES (?, ?, ?, ?)
        ON CONFLICT(reviewer_id, target_id) DO UPDATE SET rating = excluded.rating, comment = excluded.comment, created_at = datetime('now')`),
    stats: db.prepare('SELECT ROUND(AVG(rating), 1) AS avg, COUNT(*) AS n FROM partner_reviews WHERE target_id = ?'),
    list: db.prepare(`SELECT r.id, r.rating, r.comment, r.created_at, u.name AS reviewer_name
        FROM partner_reviews r JOIN users u ON u.id = r.reviewer_id
        WHERE r.target_id = ? ORDER BY r.id DESC LIMIT 50`)
};

const PHOTOGRAPHER_SELECT = `
    SELECT u.id, u.name, p.price, p.style, p.location, p.bio, p.active,
           (SELECT ROUND(AVG(rating), 1) FROM photographer_reviews WHERE photographer_id = u.id) AS avg_rating,
           (SELECT COUNT(*) FROM photographer_reviews WHERE photographer_id = u.id) AS review_count
    FROM photographers p JOIN users u ON u.id = p.user_id`;

const photographerStmts = {
    upsert: db.prepare(`INSERT INTO photographers (user_id, price, style, location, bio, active) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET price = excluded.price, style = excluded.style, location = excluded.location,
            bio = excluded.bio, active = excluded.active, updated_at = datetime('now')`),
    deactivate: db.prepare("UPDATE photographers SET active = 0, updated_at = datetime('now') WHERE user_id = ?"),
    byUserId: db.prepare(PHOTOGRAPHER_SELECT + ' WHERE u.id = ?'),
    byName: db.prepare(PHOTOGRAPHER_SELECT + ' WHERE u.name = ?'),
    listAll: db.prepare(PHOTOGRAPHER_SELECT + ' WHERE p.active = 1 ORDER BY p.updated_at DESC, u.id DESC LIMIT 100'),
    listByStyle: db.prepare(PHOTOGRAPHER_SELECT + ' WHERE p.active = 1 AND p.style = ? ORDER BY p.updated_at DESC, u.id DESC LIMIT 100'),
    upsertReview: db.prepare(`INSERT INTO photographer_reviews (reviewer_id, photographer_id, rating, tags, comment) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(reviewer_id, photographer_id) DO UPDATE SET rating = excluded.rating, tags = excluded.tags,
            comment = excluded.comment, created_at = datetime('now')`),
    reviews: db.prepare(`SELECT r.id, r.rating, r.tags, r.comment, r.created_at, u.name AS reviewer_name
        FROM photographer_reviews r JOIN users u ON u.id = r.reviewer_id
        WHERE r.photographer_id = ? ORDER BY r.id DESC LIMIT 50`)
};

const portfolioStmts = {
    insert: db.prepare('INSERT INTO portfolio_items (user_id, title, url) VALUES (?, ?, ?)'),
    list: db.prepare('SELECT id, title, url FROM portfolio_items WHERE user_id = ? ORDER BY id DESC'),
    count: db.prepare('SELECT COUNT(*) AS n FROM portfolio_items WHERE user_id = ?'),
    remove: db.prepare('DELETE FROM portfolio_items WHERE id = ? AND user_id = ?')
};

const NOTIFICATION_KEEP = 100; // 每位使用者最多保留最新 100 則

const notifStmts = {
    insert: db.prepare('INSERT INTO notifications (user_id, type, text, link) VALUES (?, ?, ?, ?)'),
    trim: db.prepare(`DELETE FROM notifications WHERE user_id = ? AND id NOT IN
        (SELECT id FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ${NOTIFICATION_KEEP})`),
    list: db.prepare('SELECT id, type, text, link, read_at, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50'),
    unread: db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL'),
    markRead: db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL")
};

const SHOOT_SELECT = `SELECT s.*, c.name AS client_name, p.name AS photographer_name
    FROM shoot_requests s JOIN users c ON c.id = s.client_id JOIN users p ON p.id = s.photographer_id`;

const shootStmts = {
    insert: db.prepare('INSERT INTO shoot_requests (client_id, photographer_id, date, start_hour, duration, price, note) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    byId: db.prepare(SHOOT_SELECT + ' WHERE s.id = ?'),
    forClient: db.prepare(SHOOT_SELECT + " WHERE s.client_id = ? AND s.status IN ('pending', 'accepted') AND s.date >= ? ORDER BY s.date, s.start_hour LIMIT 50"),
    forPhotographer: db.prepare(SHOOT_SELECT + " WHERE s.photographer_id = ? AND s.status IN ('pending', 'accepted') AND s.date >= ? ORDER BY s.date, s.start_hour LIMIT 50"),
    activeCount: db.prepare(`SELECT COUNT(*) AS n FROM shoot_requests
        WHERE client_id = ? AND status IN ('pending', 'accepted')
          AND (date > ? OR (date = ? AND start_hour + duration > ?))`),
    conflict: db.prepare(`SELECT 1 FROM shoot_requests WHERE photographer_id = ? AND date = ? AND status = 'accepted'
        AND id <> ? AND start_hour < ? AND ? < start_hour + duration`),
    setStatus: db.prepare("UPDATE shoot_requests SET status = ?, responded_at = datetime('now') WHERE id = ?"),
    cancel: db.prepare(`UPDATE shoot_requests SET status = 'cancelled', responded_at = datetime('now')
        WHERE id = ? AND status IN ('pending', 'accepted') AND (client_id = ? OR photographer_id = ?)`)
};

// 回覆邀請：只有被邀請的攝影師、且狀態是 pending 才能回覆；確認時檢查時段是否和已確認的拍攝重疊
const respondShootTx = db.transaction((id, photographerId, action) => {
    const s = shootStmts.byId.get(id);
    if (!s || s.photographer_id !== photographerId || s.status !== 'pending') return 'notpending';
    if (action === 'accept') {
        if (shootStmts.conflict.get(photographerId, s.date, id, s.start_hour + s.duration, s.start_hour)) return 'conflict';
        shootStmts.setStatus.run('accepted', id);
    } else {
        shootStmts.setStatus.run('declined', id);
    }
    return 'ok';
});

const bookingStmts = {
    insert: db.prepare('INSERT INTO bookings (user_id, room_id, date, start_hour, duration, price) VALUES (?, ?, ?, ?, ?, ?)'),
    insertSlot: db.prepare('INSERT INTO booking_slots (booking_id, room_id, date, hour) VALUES (?, ?, ?, ?)'),
    byId: db.prepare('SELECT * FROM bookings WHERE id = ?'),
    totalConfirmed: db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE user_id = ? AND status = 'confirmed'"),
    bookedHours: db.prepare('SELECT hour FROM booking_slots WHERE room_id = ? AND date = ? ORDER BY hour'),
    activeCount: db.prepare(`SELECT COUNT(*) AS n FROM bookings
        WHERE user_id = ? AND status = 'confirmed'
          AND (date > ? OR (date = ? AND start_hour + duration > ?))`),
    upcoming: db.prepare(`SELECT * FROM bookings
        WHERE user_id = ? AND status = 'confirmed' AND date >= ?
        ORDER BY date, start_hour LIMIT 50`),
    cancel: db.prepare(`UPDATE bookings SET status = 'cancelled', cancelled_at = datetime('now')
        WHERE id = ? AND user_id = ? AND status = 'confirmed'`),
    deleteSlots: db.prepare('DELETE FROM booking_slots WHERE booking_id = ?')
};

// 預約與占用時段在同一個交易裡寫入，任何一小時已被占用就整筆失敗（SQLITE_CONSTRAINT）
const createBookingTx = db.transaction((userId, roomId, date, startHour, duration, price) => {
    const id = bookingStmts.insert.run(userId, roomId, date, startHour, duration, price).lastInsertRowid;
    for (let h = startHour; h < startHour + duration; h++) bookingStmts.insertSlot.run(id, roomId, date, h);
    return id;
});

const cancelBookingTx = db.transaction((id, userId) => {
    const changes = bookingStmts.cancel.run(id, userId).changes;
    if (changes) bookingStmts.deleteSlots.run(id);
    return changes;
});

module.exports = {
    db,

    // --- users ---
    findUserById: (id) => stmts.userById.get(id),
    findUserWithHashById: (id) => stmts.userWithHash.get(id),
    // 刪除帳號：貼文、私訊、評價、預約、攝影師檔案、通知等都會一併刪除（ON DELETE CASCADE）
    deleteUser: (id) => stmts.deleteUser.run(id).changes,
    findUserByName: (name) => stmts.byName.get(name),
    findUserByEmail: (email) => stmts.byEmail.get(email),
    // 登入時可用「暱稱」或「電子信箱」
    findUserByLogin: (login) => stmts.byLogin.get(login, login),
    createUser: (name, email, passwordHash) => {
        return stmts.insertUser.run(name, email, passwordHash).lastInsertRowid;
    },

    // --- posts ---
    createPost: (authorId, content, tags = []) => createPostTx(authorId, content, tags),
    listPosts: ({ tag = '', q = '', limit = 50 } = {}) => {
        return stmts.listPosts.all({ tag, like: toLikePattern(q), limit }).map(parsePost);
    },
    getLatestPost: () => {
        const rows = stmts.listPosts.all({ tag: '', like: '', limit: 1 });
        return rows.length ? parsePost(rows[0]) : null;
    },
    countPostsByUser: (userId) => stmts.countPostsByUser.get(userId).n,

    // --- messages ---
    createMessage: (senderId, receiverId, text) => {
        const id = stmts.insertMessage.run(senderId, receiverId, text).lastInsertRowid;
        return stmts.messageById.get(id);
    },
    getConversation: (userA, userB, limit = 200) => stmts.conversation.all({ a: userA, b: userB, limit }),
    markConversationRead: (receiverId, senderId) => stmts.markRead.run(receiverId, senderId).changes,
    countUnread: (userId) => stmts.countUnread.get(userId).n,
    listConversations: (userId) => stmts.conversations.all({ me: userId }),

    // --- partner reviews ---
    saveReview: (reviewerId, targetId, rating, comment) => reviewStmts.upsert.run(reviewerId, targetId, rating, comment).changes,
    listReviews: (targetId) => reviewStmts.list.all(targetId),
    partnerReviewStats: (targetId) => reviewStmts.stats.get(targetId),

    // --- photographers ---
    savePhotographer: (userId, { price, style, location, bio }) => photographerStmts.upsert.run(userId, price, style, location, bio, 1).changes,
    deactivatePhotographer: (userId) => photographerStmts.deactivate.run(userId).changes,
    getPhotographerByUserId: (userId) => photographerStmts.byUserId.get(userId),
    // 只回傳「已開啟接案」的攝影師；自己的檔案用 getPhotographerByUserId
    getActivePhotographerByName: (name) => {
        const row = photographerStmts.byName.get(name);
        return row && row.active === 1 ? row : undefined;
    },
    listPhotographers: (style) => style ? photographerStmts.listByStyle.all(style) : photographerStmts.listAll.all(),
    savePhotographerReview: (reviewerId, photographerId, rating, tags, comment) =>
        photographerStmts.upsertReview.run(reviewerId, photographerId, rating, tags.join(','), comment).changes,
    listPhotographerReviews: (photographerId) => photographerStmts.reviews.all(photographerId).map(r => ({
        ...r,
        tags: r.tags ? r.tags.split(',') : []
    })),

    // --- portfolio ---
    addPortfolioItem: (userId, title, url) => portfolioStmts.insert.run(userId, title, url).lastInsertRowid,
    listPortfolio: (userId) => portfolioStmts.list.all(userId),
    countPortfolio: (userId) => portfolioStmts.count.get(userId).n,
    removePortfolioItem: (id, userId) => portfolioStmts.remove.run(id, userId).changes,

    // --- notifications ---
    notify: (userId, type, text, link = '') => {
        notifStmts.insert.run(userId, type, String(text).slice(0, 200), link);
        notifStmts.trim.run(userId, userId);
    },
    listNotifications: (userId) => notifStmts.list.all(userId),
    countUnreadNotifications: (userId) => notifStmts.unread.get(userId).n,
    markNotificationsRead: (userId) => notifStmts.markRead.run(userId).changes,

    // --- shoot requests ---
    createShootRequest: (clientId, photographerId, date, startHour, duration, price, note) =>
        shootStmts.insert.run(clientId, photographerId, date, startHour, duration, price, note).lastInsertRowid,
    getShoot: (id) => shootStmts.byId.get(id),
    listShootsForClient: (userId, today) => shootStmts.forClient.all(userId, today),
    listShootsForPhotographer: (userId, today) => shootStmts.forPhotographer.all(userId, today),
    countActiveShoots: (clientId, today, hour) => shootStmts.activeCount.get(clientId, today, today, hour).n,
    respondShoot: (id, photographerId, action) => {
        if (action !== 'accept' && action !== 'decline') return 'notpending';
        return respondShootTx(id, photographerId, action);
    },
    cancelShoot: (id, userId) => shootStmts.cancel.run(id, userId, userId).changes,

    // --- bookings ---
    createBooking: (userId, roomId, date, startHour, duration, price) =>
        createBookingTx(userId, roomId, date, startHour, duration, price),
    getBooking: (id) => bookingStmts.byId.get(id),
    countBookingsByUser: (userId) => bookingStmts.totalConfirmed.get(userId).n,
    listBookedHours: (roomId, date) => bookingStmts.bookedHours.all(roomId, date).map(r => r.hour),
    countActiveBookings: (userId, today, hour) => bookingStmts.activeCount.get(userId, today, today, hour).n,
    listUpcomingBookings: (userId, today) => bookingStmts.upcoming.all(userId, today),
    cancelBooking: (id, userId) => cancelBookingTx(id, userId),

    // --- reports ---
    REPORT_BAN_THRESHOLD,
    createReport: (reporterId, targetId, category, detail, evidence = '') => {
        return reportStmts.insert.run(reporterId, targetId, category, detail, evidence).lastInsertRowid;
    },
    hasReported: (reporterId, targetId) => !!reportStmts.exists.get(reporterId, targetId),
    countRecentReports: (reporterId, hours = 24) => {
        return reportStmts.recentByReporter.get(reporterId, `-${Number(hours)} hours`).n;
    },
    getReport: (id) => reportStmts.byId.get(id),
    listReports: (status, limit = 100) => reportStmts.listByStatus.all(status, limit),
    countReports: (status) => reportStmts.countByStatus.get(status).n,
    countApprovedReports: (userId) => reportStmts.approvedCount.get(userId).n,
    countApprovedReportsByName: (name) => reportStmts.approvedCountByName.get(name).n,
    // action: approve / reject（待審核）、revoke（撤銷已通過的）；回傳受影響筆數，0 代表狀態不符
    reviewReport: (id, adminId, action) => {
        if (!Object.hasOwn(REVIEW_TRANSITIONS, action)) return 0;
        const [from, to] = REVIEW_TRANSITIONS[action];
        return reportStmts.review.run({ id, admin: adminId, from, to }).changes;
    },
    listBlacklist: ({ q = '', limit = 100 } = {}) => {
        return reportStmts.blacklist.all({ like: toLikePattern(q), limit }).map(r => ({
            ...r,
            categories: r.categories ? r.categories.split(',') : []
        }));
    }
};
