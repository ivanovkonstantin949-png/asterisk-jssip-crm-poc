// account-isolation.js
//
// Ключевая бизнес-логика PoC.
//
// Требование заказчика:
//   - очередей нет
//   - переводов между операторами нет
//   - повторный звонок клиента всегда идёт на менеджера, с которым клиент уже общался
//   - если закреплённый менеджер занят/оффлайн — клиенту проигрывается busy
//     и звонок попадает в стек пропущенных конкретно этого менеджера
//
// Хранилище маппинга account_id ↔ manager_id для демо — in-memory Map.
// В проде заменяется на Redis/PostgreSQL без изменения сигнатур.

class AccountIsolation {
  constructor({ managerPool }) {
    // managerPool: экземпляр ManagerPool (см. server.js), знает кто online/busy
    this.managerPool = managerPool;

    // caller_id (E.164 или внутренний номер) → manager_id (extension)
    this.accountToManager = new Map();

    // manager_id → массив пропущенных { callerId, ts }
    this.missedByManager = new Map();
  }

  // Главная точка входа. Возвращает manager_id, на которого нужно соединить звонок,
  // либо null если клиента нужно отбить busy-сообщением.
  async route(callerId) {
    const pinnedManager = this.accountToManager.get(callerId);

    if (pinnedManager) {
      // У клиента уже есть закреплённый менеджер — только к нему, без альтернатив
      if (this.managerPool.isAvailable(pinnedManager)) {
        return { managerId: pinnedManager, reason: "pinned-available" };
      }
      // Закреплённый занят — busy + в стек пропущенных
      this.addMissed(pinnedManager, callerId);
      return { managerId: null, reason: "pinned-busy", pinnedManager };
    }

    // Новый клиент — берём свободного из пула и закрепляем
    const free = this.managerPool.getFreeManager();
    if (free) {
      this.accountToManager.set(callerId, free);
      return { managerId: free, reason: "new-pinned" };
    }

    // Все заняты — busy без закрепления (новый клиент, не за кем закреплять)
    return { managerId: null, reason: "all-busy" };
  }

  addMissed(managerId, callerId) {
    if (!this.missedByManager.has(managerId)) {
      this.missedByManager.set(managerId, []);
    }
    this.missedByManager.get(managerId).push({
      callerId,
      ts: new Date().toISOString(),
    });
  }

  // Просмотр пропущенных конкретного менеджера (для CRM UI)
  getMissed(managerId) {
    return this.missedByManager.get(managerId) || [];
  }

  // Принудительная привязка (например, импорт из CRM при старте)
  pin(callerId, managerId) {
    this.accountToManager.set(callerId, managerId);
  }

  // Текущая карта (для дашборда/отладки)
  snapshot() {
    return {
      accountToManager: Object.fromEntries(this.accountToManager),
      missedByManager: Object.fromEntries(this.missedByManager),
    };
  }
}

module.exports = { AccountIsolation };
