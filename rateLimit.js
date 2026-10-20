// 簡單的記憶體版次數限制：在 windowMs 內同一個 key 最多 max 次
class Limiter {
    constructor(max, windowMs) {
        this.max = max;
        this.windowMs = windowMs;
        this.hits = new Map();
        const timer = setInterval(() => this.prune(), windowMs);
        if (timer.unref) timer.unref();
    }

    prune(now = Date.now()) {
        for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key);
    }

    // 登記一次嘗試；回傳 false 代表已超過上限
    hit(key, now = Date.now()) {
        let entry = this.hits.get(key);
        if (!entry || entry.resetAt <= now) {
            entry = { count: 0, resetAt: now + this.windowMs };
            this.hits.set(key, entry);
        }
        entry.count++;
        return entry.count <= this.max;
    }

    isBlocked(key, now = Date.now()) {
        const entry = this.hits.get(key);
        return !!entry && entry.resetAt > now && entry.count >= this.max;
    }

    reset(key) {
        this.hits.delete(key);
    }
}

module.exports = Limiter;
