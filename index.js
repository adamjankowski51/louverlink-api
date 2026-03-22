const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ── Database init ─────────────────────────────────────────────────────────────
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS devices (
      device_id        TEXT PRIMARY KEY,
      ip               TEXT,
      firmware_version TEXT,
      current_position INTEGER DEFAULT -1,
      target_position  INTEGER DEFAULT 0,
      is_moving        BOOLEAN DEFAULT false,
      battery_voltage  REAL DEFAULT 0,
      battery_pct      INTEGER DEFAULT 0,
      usb_powered      BOOLEAN DEFAULT false,
      poll_interval_ms INTEGER DEFAULT 30000,
      last_seen        TIMESTAMPTZ DEFAULT NOW(),
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('[DB] Tables ready');
}

// ── espPing ───────────────────────────────────────────────────────────────────
app.get('/functions/espPing', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// ── espPoll ───────────────────────────────────────────────────────────────────
app.post('/functions/espPoll', async (req, res) => {
  const {
    device_id,
    ip,
    firmware_version,
    current_position,
    is_moving,
    battery_voltage,
    battery_pct,
    usb_powered,
    poll_interval_ms
  } = req.body;

  if (!device_id) {
    return res.status(400).json({ error: 'device_id required' });
  }

  try {
    // Upsert device state
    const result = await pool.query(`
      INSERT INTO devices (
        device_id, ip, firmware_version, current_position,
        is_moving, battery_voltage, battery_pct, usb_powered,
        poll_interval_ms, last_seen
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
      ON CONFLICT (device_id) DO UPDATE SET
        ip               = EXCLUDED.ip,
        firmware_version = EXCLUDED.firmware_version,
        current_position = EXCLUDED.current_position,
        is_moving        = EXCLUDED.is_moving,
        battery_voltage  = EXCLUDED.battery_voltage,
        battery_pct      = EXCLUDED.battery_pct,
        usb_powered      = EXCLUDED.usb_powered,
        poll_interval_ms = EXCLUDED.poll_interval_ms,
        last_seen        = NOW()
      RETURNING target_position
    `, [
      device_id, ip, firmware_version, current_position,
      is_moving, battery_voltage, battery_pct, usb_powered,
      poll_interval_ms
    ]);

    const target = result.rows[0].target_position;

    res.json({ target_position: target });

  } catch (err) {
    console.error('[Poll] DB error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', ts: Date.now() });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`[Server] LouverLink API running on port ${PORT}`);
  });
}).catch(err => {
  console.error('[Server] Failed to init DB:', err.message);
  process.exit(1);
});
