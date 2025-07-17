const sqlite3 = require('sqlite3').verbose();
const path = require('path');

class Database {
    constructor() {
        this.db = null;
        this.dbPath = path.join(__dirname, '..', 'shuffle.db');
    }

    // Initialize database and create tables
    async initialize() {
        return new Promise((resolve, reject) => {
            this.db = new sqlite3.Database(this.dbPath, (err) => {
                if (err) {
                    console.error('Failed to open database:', err);
                    reject(err);
                    return;
                }

                console.log('Connected to SQLite database');
                this.createTables()
                    .then(() => resolve())
                    .catch(reject);
            });
        });
    }

    // Create necessary tables
    async createTables() {
        return new Promise((resolve, reject) => {
            const sql = `
        CREATE TABLE IF NOT EXISTS play_counts (
          context_id TEXT NOT NULL,
          track_id TEXT NOT NULL,
          play_count INTEGER DEFAULT 0,
          last_played DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (context_id, track_id)
        );
        
        CREATE INDEX IF NOT EXISTS idx_context_id ON play_counts(context_id);
        CREATE INDEX IF NOT EXISTS idx_play_count ON play_counts(context_id, play_count);
      `;

            this.db.exec(sql, (err) => {
                if (err) {
                    console.error('Failed to create tables:', err);
                    reject(err);
                } else {
                    console.log('Database tables initialized');
                    resolve();
                }
            });
        });
    }

    // Get play count for a specific track in a context
    async getPlayCount(contextId, trackId) {
        return new Promise((resolve, reject) => {
            const sql = 'SELECT play_count FROM play_counts WHERE context_id = ? AND track_id = ?';

            this.db.get(sql, [contextId, trackId], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row ? row.play_count : 0);
                }
            });
        });
    }

    // Increment play count for a track in a context
    async incrementPlayCount(contextId, trackId) {
        return new Promise((resolve, reject) => {
            const sql = `
        INSERT INTO play_counts (context_id, track_id, play_count, last_played)
        VALUES (?, ?, 1, CURRENT_TIMESTAMP)
        ON CONFLICT(context_id, track_id) 
        DO UPDATE SET 
          play_count = play_count + 1,
          last_played = CURRENT_TIMESTAMP
      `;

            this.db.run(sql, [contextId, trackId], function (err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.changes);
                }
            });
        });
    }

    // Get all play counts for a context, ordered by play count (ascending = least played first)
    async getContextPlayCounts(contextId) {
        return new Promise((resolve, reject) => {
            const sql = `
        SELECT track_id, play_count, last_played 
        FROM play_counts 
        WHERE context_id = ? 
        ORDER BY play_count ASC, last_played ASC
      `;

            this.db.all(sql, [contextId], (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows);
                }
            });
        });
    }

    // Get stats for a context
    async getContextStats(contextId) {
        return new Promise((resolve, reject) => {
            const sql = `
        SELECT 
          COUNT(*) as total_tracks,
          MIN(play_count) as min_plays,
          MAX(play_count) as max_plays,
          AVG(play_count) as avg_plays,
          SUM(play_count) as total_plays
        FROM play_counts 
        WHERE context_id = ?
      `;

            this.db.get(sql, [contextId], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row || { total_tracks: 0, min_plays: 0, max_plays: 0, avg_plays: 0, total_plays: 0 });
                }
            });
        });
    }

    // Close database connection
    close() {
        if (this.db) {
            this.db.close((err) => {
                if (err) {
                    console.error('Error closing database:', err);
                } else {
                    console.log('Database connection closed');
                }
            });
        }
    }
}

module.exports = new Database();