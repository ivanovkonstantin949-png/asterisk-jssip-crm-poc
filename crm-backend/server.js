// server.js
//
// Точка входа crm-backend.
//   - подключается к Asterisk ARI (ari-client.js)
//   - на StasisStart inbound вызывает AccountIsolation.route()
//   - бриджит входящий канал с каналом закреплённого менеджера
//     (создаёт исходящий PJSIP/<extension> и mixing bridge)
//   - busy-кейсы — Playback на встроенный sound, потом Hangup
//
// Креды/URL ТОЛЬКО из process.env (см. .env.example).

const express = require("express");
const { AccountIsolation } = require("./account-isolation");
const { connectAri } = require("./ari-client");

const ARI_URL = process.env.ARI_URL;
const ARI_USER = process.env.ARI_USER;
const ARI_PASS = process.env.ARI_PASS;
const ARI_APP = process.env.ARI_APP || "poc-stasis";
const PORT = parseInt(process.env.PORT || "3000", 10);

if (!ARI_URL || !ARI_USER || !ARI_PASS) {
  console.error("Missing ARI_URL / ARI_USER / ARI_PASS env vars");
  process.exit(1);
}

// Простейший пул менеджеров. В проде — состояние из ARI endpoint state +
// CRM-флаги «на смене / перерыв / not ready».
class ManagerPool {
  constructor(extensions) {
    // ext → { busy: false }
    this.state = new Map(
      extensions.map((ext) => [ext, { busy: false, online: true }]),
    );
  }

  isAvailable(ext) {
    const m = this.state.get(ext);
    return Boolean(m && m.online && !m.busy);
  }

  getFreeManager() {
    for (const [ext, st] of this.state) {
      if (st.online && !st.busy) return ext;
    }
    return null;
  }

  setBusy(ext, busy) {
    const m = this.state.get(ext);
    if (m) m.busy = busy;
  }

  snapshot() {
    return Object.fromEntries(this.state);
  }
}

const managerPool = new ManagerPool(["1001", "1002", "1003"]);
const isolation = new AccountIsolation({ managerPool });

async function handleInbound(event, channel, client) {
  const callerId = channel.caller.number || "anonymous";
  console.log(`[stasis] inbound from ${callerId} (channel ${channel.id})`);

  const decision = await isolation.route(callerId);
  console.log(`[isolation] ${callerId} → ${JSON.stringify(decision)}`);

  if (!decision.managerId) {
    await playBusyAndHangup(channel, client);
    return;
  }

  managerPool.setBusy(decision.managerId, true);
  try {
    await dialManager(channel, client, decision.managerId);
  } finally {
    managerPool.setBusy(decision.managerId, false);
  }
}

async function playBusyAndHangup(channel, client) {
  try {
    const playback = client.Playback();
    await channel.play({ media: "sound:vm-goodbye" }, playback);
    await new Promise((r) => setTimeout(r, 2500));
  } catch (err) {
    console.warn("[stasis] playback failed:", err.message);
  }
  try {
    await channel.hangup();
  } catch (_) {}
}

async function dialManager(inboundChannel, client, managerExt) {
  const bridge = client.Bridge();
  await bridge.create({ type: "mixing" });

  const outbound = client.Channel();
  await outbound.originate({
    endpoint: `PJSIP/${managerExt}`,
    app: ARI_APP,
    appArgs: "dialed",
    callerId: inboundChannel.caller.number,
    timeout: 30,
  });

  let answered = false;
  outbound.once("StasisStart", async () => {
    answered = true;
    await bridge.addChannel({ channel: [inboundChannel.id, outbound.id] });
    console.log(
      `[bridge] ${inboundChannel.id} <-> ${outbound.id} via ${managerExt}`,
    );
  });

  outbound.once("ChannelDestroyed", async () => {
    if (!answered) {
      console.log(`[dial] manager ${managerExt} did not answer, busy + missed`);
      isolation.addMissed(
        managerExt,
        inboundChannel.caller.number || "anonymous",
      );
      await playBusyAndHangup(inboundChannel, client);
    }
    try {
      await bridge.destroy();
    } catch (_) {}
  });

  inboundChannel.once("StasisEnd", async () => {
    try {
      await outbound.hangup();
    } catch (_) {}
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
      if (args[0] === "inbound") {
        await handleInbound(event, channel, client);
      }
    },
  });
})();

// Маленький REST для CRM-UI: посмотреть карту и пропущенных
const app = express();
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/state", (_req, res) => {
  res.json({
    managers: managerPool.snapshot(),
    isolation: isolation.snapshot(),
  });
});

app.get("/missed/:managerId", (req, res) => {
  res.json({
    managerId: req.params.managerId,
    missed: isolation.getMissed(req.params.managerId),
  });
});

app.post("/pin", (req, res) => {
  const { callerId, managerId } = req.body || {};
  if (!callerId || !managerId)
    return res.status(400).json({ error: "callerId and managerId required" });
  isolation.pin(callerId, managerId);
  res.json({ ok: true });
});

app.listen(PORT, "0.0.0.0", () =>
  console.log(`[http] crm-backend listening on 0.0.0.0:${PORT}`),
);
