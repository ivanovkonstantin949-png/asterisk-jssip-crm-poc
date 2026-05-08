// voice-gateway/server.js
//
// Шлюз между Asterisk (через ARI) и Node.js CRM заказчика.
//
// На входе:  WebRTC-звонки с браузерных операторов и SIP-trunk провайдера.
// На выходе: REST + WebSocket интеграция с CRM (см. CONTRACT.md).
//
// Ключевые потоки:
//   1) Подписка на WS /ws/manager-status у CRM — поддерживаем кэш статусов.
//   2) StasisStart inbound:
//        a) lookup в CRM по phone → account_id + pinned_manager_id
//        b) AccountIsolation.route() → решение bridge|busy
//        c) если bridge: originate PJSIP/<manager>, mixing bridge, webhook call.bridged
//        d) если busy: playback "all-busy", webhook call.missed
//        e) на disconnect: webhook call.ended
//   3) Если новый account и взяли свободного — POST /accounts/:id/pin

const express = require('express');
const { AccountIsolation } = require('./account-isolation');
const { connectAri } = require('./ari-client');
const { CrmClient } = require('./crm-client');

const ARI_URL  = process.env.ARI_URL;
const ARI_USER = process.env.ARI_USER;
const ARI_PASS = process.env.ARI_PASS;
const ARI_APP  = process.env.ARI_APP || 'poc-stasis';
const PORT     = parseInt(process.env.PORT || '3000', 10);
const CRM_HTTP = process.env.CRM_HTTP_URL || 'http://mock-crm:4000';
const CRM_WS   = process.env.CRM_WS_URL   || 'ws://mock-crm:4000/ws/manager-status';

if (!ARI_URL || !ARI_USER || !ARI_PASS) {
  console.error('Missing ARI_URL / ARI_USER / ARI_PASS env vars');
  process.exit(1);
}

// === local state, обновляется из CRM по WS ===
const managerStatusCache = new Map();   // manager_id → { status, on_shift }
const callOccupancy      = new Set();   // manager_id, занят на канале прямо сейчас

const crm = new CrmClient({
  baseUrl: CRM_HTTP,
  wsUrl: CRM_WS,
  onManagerStatus: (msg) => {
    if (!msg || !msg.manager_id) return;
    managerStatusCache.set(msg.manager_id, { status: msg.status, on_shift: msg.on_shift });
    console.log(`[crm] status update ${msg.manager_id} → ${msg.status} (on_shift=${msg.on_shift})`);
  },
});
crm.connectWebSocket();

const isolation = new AccountIsolation({ crm, managerStatusCache, callOccupancy });

async function handleInbound(event, channel, client) {
  const phone = (channel.caller && channel.caller.number) || 'anonymous';
  console.log(`[stasis] inbound from ${phone} (channel ${channel.id})`);

  const decision = await isolation.route(phone);
  console.log(`[isolation] ${phone} → ${JSON.stringify(decision)}`);

  await crm.sendCallEvent({
    event: 'call.incoming',
    channel_id: channel.id,
    caller: phone,
    account_id: decision.account_id,
    manager_id: decision.manager_id,
    reason: decision.reason,
  });

  if (decision.decision === 'busy') {
    await crm.sendCallEvent({
      event: 'call.missed',
      channel_id: channel.id,
      caller: phone,
      account_id: decision.account_id,
      manager_id: decision.manager_id,
      reason: decision.reason,
    });
    await playBusyAndHangup(channel, client);
    return;
  }

  callOccupancy.add(decision.manager_id);
  try {
    await dialManager(channel, client, decision);
  } finally {
    callOccupancy.delete(decision.manager_id);
  }
}

async function playBusyAndHangup(channel, client) {
  try {
    const playback = client.Playback();
    await channel.play({ media: 'sound:vm-goodbye' }, playback);
    await new Promise((r) => setTimeout(r, 2500));
  } catch (err) {
    console.warn('[stasis] playback failed:', err.message);
  }
  try { await channel.hangup(); } catch (_) {}
}

async function dialManager(inboundChannel, client, decision) {
  const managerExt = decision.manager_id;
  const phone = (inboundChannel.caller && inboundChannel.caller.number) || 'anonymous';

  const bridge = client.Bridge();
  await bridge.create({ type: 'mixing' });

  const outbound = client.Channel();
  await outbound.originate({
    endpoint: `PJSIP/${managerExt}`,
    app: ARI_APP,
    appArgs: 'dialed',
    callerId: phone,
    timeout: 30,
  });

  let answered = false;

  client.on('StasisStart', async (ev, ch) => {
    if (ch.id !== outbound.id) return;
    answered = true;
    await bridge.addChannel({ channel: [inboundChannel.id, outbound.id] });
    console.log(`[bridge] ${inboundChannel.id} <-> ${outbound.id} via ${managerExt}`);

    if (!decision.account_id) {
      // ничего не делаем — нет account_id, не за что закреплять
    } else if (decision.reason === 'no-pin-pick-free' || decision.reason === 'new-account-pick-free') {
      try {
        await fetch(`${CRM_HTTP}/accounts/${decision.account_id}/pin`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ manager_id: managerExt }),
        });
        console.log(`[crm] pinned ${decision.account_id} → ${managerExt}`);
      } catch (err) {
        console.warn(`[crm] pin failed: ${err.message}`);
      }
    }

    await crm.sendCallEvent({
      event: 'call.bridged',
      channel_id: inboundChannel.id,
      caller: phone,
      account_id: decision.account_id,
      manager_id: managerExt,
    });
  });

  outbound.once('ChannelDestroyed', async () => {
    if (!answered) {
      console.log(`[dial] manager ${managerExt} did not answer`);
      await crm.sendCallEvent({
        event: 'call.missed',
        channel_id: inboundChannel.id,
        caller: phone,
        account_id: decision.account_id,
        manager_id: managerExt,
        reason: 'no-answer',
      });
      await playBusyAndHangup(inboundChannel, client);
    }
    try { await bridge.destroy(); } catch (_) {}
  });

  inboundChannel.once('StasisEnd', async () => {
    await crm.sendCallEvent({
      event: 'call.ended',
      channel_id: inboundChannel.id,
      caller: phone,
      account_id: decision.account_id,
      manager_id: managerExt,
    });
    try { await outbound.hangup(); } catch (_) {}
  });
}

(async () => {
  await connectAri({
    url: ARI_URL,
    user: ARI_USER,
    pass: ARI_PASS,
    appName: ARI_APP,
    onStasisStart: async (event, channel, client) => {
      const args = event.args || [];
      if (args[0] === 'inbound') await handleInbound(event, channel, client);
    },
  });
})();

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true, service: 'voice-gateway' }));

app.get('/state', (_req, res) => {
  res.json({
    manager_status_cache: Object.fromEntries(managerStatusCache),
    call_occupancy: [...callOccupancy],
  });
});

app.listen(PORT, '0.0.0.0', () => console.log(`[http] voice-gateway listening on 0.0.0.0:${PORT}`));
