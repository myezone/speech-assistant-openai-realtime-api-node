// db.js
import pg from "pg";

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,

  // Render internal DB connections usually work without SSL.
  // If you later use an external DB URL, you may need SSL:
  // ssl: { rejectUnauthorized: false },
});

// Optional helper: simple query wrapper
export async function dbQuery(text, params) {
  return pool.query(text, params);
}
