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
    device_id, ip, firmware_version, current_position,
    is_moving, battery_voltage, battery_pct, usb_powered, poll_interval_ms
  } = req.body;

  if (!device_id) return res.status(400).json({ error: 'device_id required' });

  try {
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
    `, [device_id, ip, firmware_version, current_position,
        is_moving, battery_voltage, battery_pct, usb_powered, poll_interval_ms]);

    res.json({ target_position: result.rows[0].target_position });
  } catch (err) {
    console.error('[Poll] DB error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// ── Get all devices — for base44 app ─────────────────────────────────────────
app.get('/functions/getDevices', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM devices ORDER BY last_seen DESC'
    );
    res.json({ devices: result.rows });
  } catch (err) {
    console.error('[getDevices] DB error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// ── Get single device — for base44 app ───────────────────────────────────────
app.get('/functions/getDevice/:device_id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM devices WHERE device_id = $1',
      [req.params.device_id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: 'device not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[getDevice] DB error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// ── Set target position — called by base44 app ────────────────────────────────
app.post('/functions/setTarget', async (req, res) => {
  const { device_id, target_position } = req.body;

  if (!device_id || target_position === undefined)
    return res.status(400).json({ error: 'device_id and target_position required' });

  if (target_position < 0 || target_position > 180)
    return res.status(400).json({ error: 'target_position must be 0-180' });

  try {
    const result = await pool.query(
      `UPDATE devices SET target_position = $1 WHERE device_id = $2 RETURNING *`,
      [target_position, device_id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: 'device not found' });
    res.json({ ok: true, device: result.rows[0] });
  } catch (err) {
    console.error('[setTarget] DB error:', err.message);
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
