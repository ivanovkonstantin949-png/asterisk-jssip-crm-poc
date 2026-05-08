// crm-client.js
//
// HTTP + WebSocket клиент к CRM заказчика.
// Контракт описан в CONTRACT.md и продемонстрирован mock-crm-сервисом.
//
// HTTP:
//   - lookupAccount(phone)        GET  /accounts/lookup?phone=...
//   - getManagerStatus(id)        GET  /managers/:id
//   - sendCallEvent(event)        POST /calls/events    (fire-and-forget с retry)
//
// WebSocket:
//   - подписка на /ws/manager-status, события статусов менеджеров.
//     Кэшируется в памяти gateway, используется в AccountIsolation.isAvailable().

const WebSocket = require("ws");

class CrmClient {
  constructor({ baseUrl, wsUrl, onManagerStatus }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.wsUrl = wsUrl;
    this.onManagerStatus = onManagerStatus || (() => {});
    this.ws = null;
    this.wsBackoff = 1000;
  }

  async lookupAccount(phone) {
    const r = await fetch(
      `${this.baseUrl}/accounts/lookup?phone=${encodeURIComponent(phone)}`,
    );
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`CRM lookup failed: ${r.status}`);
    return r.json();
  }

  async getManagerStatus(managerId) {
    const r = await fetch(
      `${this.baseUrl}/managers/${encodeURIComponent(managerId)}`,
    );
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`CRM manager status failed: ${r.status}`);
    return r.json();
  }

  async sendCallEvent(event) {
    const payload = { ts: new Date().toISOString(), ...event };
    try {
      const r = await fetch(`${this.baseUrl}/calls/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok && r.status !== 204) {
        console.warn(`[crm] webhook ${event.event} returned ${r.status}`);
      }
    } catch (err) {
      // в проде — очередь повторов (Redis Streams / outbox-таблица).
      // Для PoC ограничиваемся логом, чтобы не блокировать обработку звонка.
      console.warn(`[crm] webhook ${event.event} failed: ${err.message}`);
    }
  }

  connectWebSocket() {
    const ws = new WebSocket(this.wsUrl);
    ws.on("open", () => {
      console.log(`[crm] ws connected to ${this.wsUrl}`);
      this.wsBackoff = 1000;
    });
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.onManagerStatus(msg);
      } catch (err) {
        console.warn("[crm] ws bad message:", err.message);
      }
    });
    ws.on("close", () => {
      console.warn(`[crm] ws closed, reconnect in ${this.wsBackoff}ms`);
      setTimeout(() => this.connectWebSocket(), this.wsBackoff);
      this.wsBackoff = Math.min(this.wsBackoff * 2, 30000);
    });
    ws.on("error", (err) => {
      console.warn("[crm] ws error:", err.message);
    });
    this.ws = ws;
  }
}

module.exports = { CrmClient };
