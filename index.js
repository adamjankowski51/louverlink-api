const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

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
      target_position_pct INTEGER DEFAULT 0,
      current_position_pct INTEGER DEFAULT 0,
      target_state     TEXT DEFAULT 'closed',
      is_moving        BOOLEAN DEFAULT false,
      is_online        BOOLEAN DEFAULT false,
      battery_voltage  REAL DEFAULT 0,
      battery_pct      INTEGER DEFAULT 0,
      usb_powered      BOOLEAN DEFAULT false,
      poll_interval_ms INTEGER DEFAULT 30000,
      servo_angle_min  INTEGER DEFAULT 0,
      servo_angle_max  INTEGER DEFAULT 180,
      gpio_pin         INTEGER DEFAULT 0,
      ota_version      TEXT,
      ota_url          TEXT,
      claimed          BOOLEAN DEFAULT false,
      name             TEXT,
      last_seen        TIMESTAMPTZ DEFAULT NOW(),
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('[DB] Tables ready');
}

// ── Helper: convert percentage to servo angle ─────────────────────────────────
function pctToAngle(pct, servoMin, servoMax) {
  return Math.round(servoMin + (pct / 100) * (servoMax - servoMin));
}

// ── Helper: convert servo angle to percentage ─────────────────────────────────
function angleToPct(angle, servoMin, servoMax) {
  const range = servoMax - servoMin;
  if (range <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round(((angle - servoMin) / range) * 100)));
}

// ── espPing ───────────────────────────────────────────────────────────────────
app.get('/functions/espPing', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// ── espPoll — called by ESP32 device ─────────────────────────────────────────
app.post('/functions/espPoll', async (req, res) => {
  const {
    device_id, ip, firmware_version, current_position,
    is_moving, battery_voltage, battery_pct, usb_powered, poll_interval_ms
  } = req.body;

  if (!device_id) return res.status(400).json({ error: 'device_id required' });

  try {
    // Get existing device record
    const existing = await pool.query(
      'SELECT * FROM devices WHERE device_id = $1', [device_id]
    );
    const device = existing.rows[0];

    const servoMin = device?.servo_angle_min ?? 0;
    const servoMax = device?.servo_angle_max ?? 180;
    const targetPct = device?.target_position_pct ?? 0;
    const targetAngle = pctToAngle(targetPct, servoMin, servoMax);

    // Compute current position percentage
    let currentPct = device?.current_position_pct ?? 0;
    if (current_position !== undefined && current_position >= 0 && !is_moving) {
      currentPct = angleToPct(current_position, servoMin, servoMax);
    }

    // Only update target_position_pct back if device confirmed it (within tolerance)
    const updates = {
      ip,
      firmware_version,
      current_position: current_position ?? -1,
      current_position_pct: currentPct,
      is_moving: is_moving ?? false,
      is_online: true,
      battery_voltage: battery_voltage ?? 0,
      battery_pct: battery_pct ?? 0,
      usb_powered: usb_powered ?? false,
      poll_interval_ms: poll_interval_ms ?? 30000,
      last_seen: new Date().toISOString(),
    };

    // If device confirmed position within tolerance, sync target back
    if (!is_moving && current_position >= 0 && device) {
      if (Math.abs((device.target_position_pct ?? 0) - currentPct) <= 2) {
        updates.target_position_pct = currentPct;
        updates.target_position = current_position;
      }
    }

    await pool.query(`
      INSERT INTO devices (device_id, ip, firmware_version, current_position,
        current_position_pct, is_moving, is_online, battery_voltage, battery_pct,
        usb_powered, poll_interval_ms, last_seen)
      VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,$9,$10,NOW())
      ON CONFLICT (device_id) DO UPDATE SET
        ip                   = EXCLUDED.ip,
        firmware_version     = EXCLUDED.firmware_version,
        current_position     = EXCLUDED.current_position,
        current_position_pct = EXCLUDED.current_position_pct,
        is_moving            = EXCLUDED.is_moving,
        is_online            = true,
        battery_voltage      = EXCLUDED.battery_voltage,
        battery_pct          = EXCLUDED.battery_pct,
        usb_powered          = EXCLUDED.usb_powered,
        poll_interval_ms     = EXCLUDED.poll_interval_ms,
        last_seen            = NOW()
    `, [device_id, ip, firmware_version, current_position ?? -1,
        currentPct, is_moving ?? false, battery_voltage ?? 0,
        battery_pct ?? 0, usb_powered ?? false, poll_interval_ms ?? 30000]);

    // If not yet claimed return unclaimed status
    if (!device || !device.claimed) {
      console.log(`[espPoll] Unclaimed device polling: ${device_id}`);
      return res.json({ status: 'unclaimed' });
    }

    // Build response
    const responsePayload = {
      target_position: targetAngle,
      target_state: device.target_state ?? 'closed',
      gpio_pin: device.gpio_pin ?? 0,
    };

    // OTA — only send if device firmware is older than target
    if (device.ota_version && device.ota_url) {
      if (firmware_version !== device.ota_version) {
        responsePayload.ota_version = device.ota_version;
        responsePayload.ota_url     = device.ota_url;
      } else {
        // Device is on target version — clear OTA fields
        await pool.query(
          'UPDATE devices SET ota_version = NULL, ota_url = NULL WHERE device_id = $1',
          [device_id]
        );
      }
    }

    return res.json(responsePayload);

  } catch (err) {
    console.error('[espPoll] DB error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// ── Get all devices — called by base44 app ────────────────────────────────────
app.get('/functions/getDevices', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM devices ORDER BY last_seen DESC');
    res.json({ devices: result.rows });
  } catch (err) {
    console.error('[getDevices] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// ── Get single device — called by base44 app ──────────────────────────────────
app.get('/functions/getDevice/:device_id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM devices WHERE device_id = $1', [req.params.device_id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'device not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[getDevice] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// ── Set target position — called by base44 app ────────────────────────────────
// Accepts percentage (0-100) and converts to servo angle internally
app.post('/functions/setTarget', async (req, res) => {
  const { device_id, target_position_pct, target_state } = req.body;

  if (!device_id || target_position_pct === undefined)
    return res.status(400).json({ error: 'device_id and target_position_pct required' });

  if (target_position_pct < 0 || target_position_pct > 100)
    return res.status(400).json({ error: 'target_position_pct must be 0-100' });

  try {
    const existing = await pool.query(
      'SELECT * FROM devices WHERE device_id = $1', [device_id]
    );
    const device = existing.rows[0];
    if (!device) return res.status(404).json({ error: 'device not found' });

    const servoMin = device.servo_angle_min ?? 0;
    const servoMax = device.servo_angle_max ?? 180;
    const targetAngle = pctToAngle(target_position_pct, servoMin, servoMax);
    const state = target_state ?? (target_position_pct > 50 ? 'open' : 'closed');

    const result = await pool.query(`
      UPDATE devices
      SET target_position_pct = $1,
          target_position     = $2,
          target_state        = $3
      WHERE device_id = $4
      RETURNING *
    `, [target_position_pct, targetAngle, state, device_id]);

    res.json({ ok: true, device: result.rows[0] });
  } catch (err) {
    console.error('[setTarget] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// ── Claim device — called by base44 app setup wizard ─────────────────────────
app.post('/functions/claimDevice', async (req, res) => {
  const { device_id, name, servo_angle_min, servo_angle_max, gpio_pin } = req.body;

  if (!device_id) return res.status(400).json({ error: 'device_id required' });

  try {
    const result = await pool.query(`
      UPDATE devices SET
        claimed         = true,
        name            = $1,
        servo_angle_min = $2,
        servo_angle_max = $3,
        gpio_pin        = $4
      WHERE device_id = $5
      RETURNING *
    `, [name ?? device_id, servo_angle_min ?? 0, servo_angle_max ?? 180,
        gpio_pin ?? 0, device_id]);

    if (!result.rows[0]) return res.status(404).json({ error: 'device not found' });
    res.json({ ok: true, device: result.rows[0] });
  } catch (err) {
    console.error('[claimDevice] error:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// ── Set OTA update — called by base44 app ────────────────────────────────────
app.post('/functions/setOta', async (req, res) => {
  const { device_id, ota_version, ota_url } = req.body;

  if (!device_id || !ota_version || !ota_url)
    return res.status(400).json({ error: 'device_id, ota_version and ota_url required' });

  try {
    await pool.query(
      'UPDATE devices SET ota_version = $1, ota_url = $2 WHERE device_id = $3',
      [ota_version, ota_url, device_id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[setOta] error:', err.message);
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
