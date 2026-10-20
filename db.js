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
`);

const stmts = {
    // --- users ---
    userById: db.prepare('SELECT id, name, email, created_at FROM users WHERE id = ?'),
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

module.exports = {
    db,

    // --- users ---
    findUserById: (id) => stmts.userById.get(id),
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
