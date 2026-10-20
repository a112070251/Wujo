// SQLite 資料庫連線與使用者資料表
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
    )
`);

const stmts = {
    byName: db.prepare('SELECT * FROM users WHERE name = ?'),
    byEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    byLogin: db.prepare('SELECT * FROM users WHERE name = ? OR email = ?'),
    insert: db.prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)')
};

module.exports = {
    db,
    findUserByName: (name) => stmts.byName.get(name),
    findUserByEmail: (email) => stmts.byEmail.get(email),
    // 登入時可用「暱稱」或「電子信箱」
    findUserByLogin: (login) => stmts.byLogin.get(login, login),
    createUser: (name, email, passwordHash) => {
        const info = stmts.insert.run(name, email, passwordHash);
        return info.lastInsertRowid;
    }
};
