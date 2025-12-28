// callLog.js
import { pool } from "./db.js";

export async function upsertCallStart({ callId, from, to }) {
  await pool.query(
    `
    INSERT INTO calls (call_id, from_number, to_number, status)
    VALUES ($1, $2, $3, 'initiated')
    ON CONFLICT (call_id) DO UPDATE
      SET from_number = EXCLUDED.from_number,
          to_number = EXCLUDED.to_number,
          updated_at = NOW()
    `,
    [callId, from, to]
  );
}

export async function logUtterance({ callId, role, text }) {
  if (!text?.trim()) return;
  await pool.query(
    `INSERT INTO call_utterances (call_id, role, text) VALUES ($1, $2, $3)`,
    [callId, role, text.trim()]
  );
}

export async function completeCall({ callId, status, durationSeconds }) {
  await pool.query(
    `
    UPDATE calls
    SET status = $2,
        ended_at = NOW(),
        duration_seconds = $3,
        updated_at = NOW()
    WHERE call_id = $1
    `,
    [callId, status, durationSeconds]
  );
}
