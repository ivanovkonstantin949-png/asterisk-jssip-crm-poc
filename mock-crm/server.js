// mock-crm/server.js
//
// Имитация Node.js CRM на стороне заказчика.
// Цель — показать ТОЧНЫЙ КОНТРАКТ, который реальная CRM должна реализовать.
// В проде этот сервис заменяется боевой CRM Дениса с теми же endpoint'ами.
//
// Контракт (см. CONTRACT.md в корне репо):
//   GET  /accounts/lookup?phone=<E.164>
//        → 200 { account_id, pinned_manager_id|null, last_seen_at }
//        → 404 если телефон неизвестен
//
//   GET  /managers/:id
//        → 200 { manager_id, status: "online"|"busy"|"offline", on_shift }
//
//   POST /calls/events           (webhook от voice-gateway)
//        body: { event, channel_id, account_id, manager_id?, caller, ts }
//        events: call.incoming | call.bridged | call.missed | call.ended
//        → 204
//
//   POST /accounts/:id/pin       (привязать менеджера, ручная операция)
//        body: { manager_id }
//        → 204
//
//   WS   /ws/manager-status      (publisher — gateway подписывается)
//        push: { manager_id, status, ts } каждый раз когда статус меняется

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT || '4000', 10);

// === seed-data, имитация записей в реальной CRM ===
const accounts = new Map([
  // phone → account
  ['+79991110001', { account_id: 'ACC-1001', pinned_manager_id: '1001', last_seen_at: '2026-05-07T10:30:00Z' }],
  ['+79991110002', { account_id: 'ACC-1002', pinned_manager_id: null,   last_seen_at: '2026-05-07T11:00:00Z' }],
]);

const managers = new Map([
  ['1001', { manager_id: '1001', status: 'online', on_shift: true }],
  ['1002', { manager_id: '1002', status: 'online', on_shift: true }],
  ['1003', { manager_id: '1003', status: 'offline', on_shift: false }],
]);

const events = []; // accumulated webhooks (для отладки)

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true, service: 'mock-crm' }));

app.get('/accounts/lookup', (req, res) => {
  const phone = req.query.phone;
  if (!phone) return res.status(400).json({ error: 'phone query param required' });
  const acc = accounts.get(phone);
  if (!acc) return res.status(404).json({ error: 'unknown phone', phone });
  res.json({ phone, ...acc });
});

app.get('/managers/:id', (req, res) => {
  const m = managers.get(req.params.id);
  if (!m) return res.status(404).json({ error: 'unknown manager' });
  res.json(m);
});

app.post('/accounts/:id/pin', (req, res) => {
  const accountId = req.params.id;
  const managerId = req.body && req.body.manager_id;
  if (!managerId) return res.status(400).json({ error: 'manager_id required' });
  for (const [phone, acc] of accounts) {
    if (acc.account_id === accountId) {
      acc.pinned_manager_id = managerId;
      console.log(`[mock-crm] pinned ${accountId} → ${managerId} (phone ${phone})`);
      return res.status(204).end();
    }
  }
  res.status(404).json({ error: 'unknown account' });
});

app.post('/calls/events', (req, res) => {
  const ev = req.body || {};
  ev._received_at = new Date().toISOString();
  events.push(ev);
  console.log(`[mock-crm] webhook ← ${ev.event} channel=${ev.channel_id} account=${ev.account_id} manager=${ev.manager_id || '-'}`);
  res.status(204).end();
});

app.get('/_debug/events', (_req, res) => res.json({ count: events.length, events }));
app.get('/_debug/accounts', (_req, res) => res.json(Object.fromEntries(accounts)));

// admin endpoint — поменять статус менеджера для теста (имитация UI оператора)
app.post('/_debug/managers/:id/status', (req, res) => {
  const m = managers.get(req.params.id);
  if (!m) return res.status(404).json({ error: 'unknown manager' });
  const next = (req.body && req.body.status) || m.status;
  m.status = next;
  broadcastManagerStatus(m);
  res.json(m);
});

const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: '/ws/manager-status' });
wss.on('connection', (ws) => {
  console.log('[mock-crm] ws subscriber connected');
  // отдаём текущий снэпшот при подписке
  for (const m of managers.values()) {
    ws.send(JSON.stringify({ ...m, ts: new Date().toISOString() }));
  }
  ws.on('close', () => console.log('[mock-crm] ws subscriber disconnected'));
});

function broadcastManagerStatus(manager) {
  const payload = JSON.stringify({ ...manager, ts: new Date().toISOString() });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(payload);
  }
}

server.listen(PORT, '0.0.0.0', () => console.log(`[mock-crm] listening on 0.0.0.0:${PORT}`));
