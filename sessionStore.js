// 把 session 存進 SQLite（和資料庫同一個檔案），伺服器重啟或重新部署後使用者仍保持登入
const session = require('express-session');

class SqliteStore extends session.Store {
    constructor(db) {
        super();
        this.db = db;
        db.exec(`
            CREATE TABLE IF NOT EXISTS sessions (
                sid     TEXT PRIMARY KEY,
                data    TEXT NOT NULL,
                expires INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);
        `);
        this.stmts = {
            get: db.prepare('SELECT data FROM sessions WHERE sid = ? AND expires > ?'),
            set: db.prepare('INSERT INTO sessions (sid, data, expires) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires = excluded.expires'),
            touch: db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?'),
            destroy: db.prepare('DELETE FROM sessions WHERE sid = ?'),
            prune: db.prepare('DELETE FROM sessions WHERE expires <= ?')
        };
        this.prune();
        // 每小時清一次過期的 session；unref 讓這個計時器不會阻止程式結束
        this.timer = setInterval(() => this.prune(), 60 * 60 * 1000);
        if (this.timer.unref) this.timer.unref();
    }

    prune() {
        try { this.stmts.prune.run(Date.now()); } catch (err) { console.error('清理 session 失敗:', err); }
    }

    expiryOf(sess) {
        const exp = sess && sess.cookie && sess.cookie.expires;
        const t = exp ? new Date(exp).getTime() : NaN;
        return Number.isFinite(t) ? t : Date.now() + 24 * 60 * 60 * 1000;
    }

    get(sid, cb) {
        try {
            const row = this.stmts.get.get(sid, Date.now());
            cb(null, row ? JSON.parse(row.data) : null);
        } catch (err) { cb(err); }
    }

    set(sid, sess, cb) {
        try {
            this.stmts.set.run(sid, JSON.stringify(sess), this.expiryOf(sess));
            cb && cb(null);
        } catch (err) { cb && cb(err); }
    }

    touch(sid, sess, cb) {
        try {
            this.stmts.touch.run(this.expiryOf(sess), sid);
            cb && cb(null);
        } catch (err) { cb && cb(err); }
    }

    destroy(sid, cb) {
        try {
            this.stmts.destroy.run(sid);
            cb && cb(null);
        } catch (err) { cb && cb(err); }
    }
}

module.exports = SqliteStore;
