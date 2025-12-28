// callLog.js
import { pool } from "./db.js";

export async function upsertCallStart({ callId, from, to }) {
  if (!callId) return;

  await pool.query(
    `
      INSERT INTO calls (call_id, from_number, to_number, status)
      VALUES ($1, $2, $3, 'initiated')
      ON CONFLICT (call_id) DO UPDATE
        SET from_number = EXCLUDED.from_number,
            to_number   = EXCLUDED.to_number,
            updated_at  = NOW()
    `,
    [callId, from ?? null, to ?? null]
  );
}

export async function logUtterance({ callId, role, text }) {
  if (!callId) return;
  const clean = (text || "").trim();
  if (!clean) return;

  await pool.query(
    `INSERT INTO call_utterances (call_id, role, text) VALUES ($1, $2, $3)`,
    [callId, role, clean]
  );
}

export async function setCallDurationFallback({ callId, durationSeconds }) {
  if (!callId) return;

  await pool.query(
    `
      UPDATE calls
      SET duration_seconds = COALESCE(duration_seconds, $2),
          updated_at       = NOW()
      WHERE call_id = $1
    `,
    [callId, durationSeconds]
  );
}

export async function saveCallSummary({ callId, summaryText, summaryJson }) {
  if (!callId) return;

  await pool.query(
    `
      UPDATE calls
      SET summary_text = $2,
          summary_json = $3,
          updated_at   = NOW()
      WHERE call_id = $1
    `,
    [callId, summaryText || null, summaryJson || null]
  );
}

export async function setOfficialCallDuration({ callId, durationSeconds, status }) {
  if (!callId) return;

  await pool.query(
    `
      UPDATE calls
      SET duration_seconds = $2,
          status           = COALESCE($3, status),
          ended_at         = NOW(),
          updated_at       = NOW()
      WHERE call_id = $1
    `,
    [callId, durationSeconds, status || null]
  );
}
