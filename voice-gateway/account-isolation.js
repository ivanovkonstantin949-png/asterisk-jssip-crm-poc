// account-isolation.js
//
// Бизнес-логика возврата клиента на закреплённого менеджера.
//
// Требование заказчика (07.05 12:11):
//   «у нас переводов не будет между операторами. изоляция на уровне аккаунт айди.
//    если менеджер А звонила клиенту, при перезвоне звонок идет на нее.
//    очередей нет. будет говориться все операторы заняты, и в пропущенные»
//
// Семантика:
//   phone (caller_id из SIP) → CRM.lookup → account_id + pinned_manager_id
//   account_id — единица изоляции, НЕ телефон. Один клиент может иметь несколько номеров,
//   привязка лежит в CRM.
//
// Правила маршрутизации:
//   1. lookup в CRM по phone
//   2. если pinned_manager_id есть и менеджер available → bridge к нему
//   3. если pinned есть, но НЕ available → busy + missed на этого менеджера
//   4. если pinned НЕТ (новый клиент) → берём свободного из пула, фиксируем в CRM
//   5. свободных нет → busy без закрепления
//
// Доступность менеджера:
//   - real-time статус приходит по WS из CRM (online|busy|offline)
//   - локальный кэш этого статуса в managerStatusCache
//   - дополнительно gateway знает «занят прямо сейчас на канале X» через own state

class AccountIsolation {
  constructor({ crm, managerStatusCache, callOccupancy }) {
    this.crm = crm;
    this.managerStatusCache = managerStatusCache; // Map<manager_id, {status, on_shift}>
    this.callOccupancy = callOccupancy;           // Set<manager_id> — занят на активном канале
  }

  isManagerAvailable(managerId) {
    if (!managerId) return false;
    if (this.callOccupancy.has(managerId)) return false;
    const cached = this.managerStatusCache.get(managerId);
    if (!cached) return false;
    return cached.on_shift && cached.status === 'online';
  }

  pickFreeManager() {
    for (const [id, st] of this.managerStatusCache) {
      if (st.on_shift && st.status === 'online' && !this.callOccupancy.has(id)) {
        return id;
      }
    }
    return null;
  }

  // Главная точка входа.
  // Возвращает решение: { decision, account_id, manager_id, reason }
  //   decision = "bridge" | "busy"
  async route(phone) {
    let lookup = null;
    try {
      lookup = await this.crm.lookupAccount(phone);
    } catch (err) {
      console.warn(`[isolation] CRM lookup error for ${phone}: ${err.message}`);
    }

    // Случай 4-5: новый клиент, в CRM не нашли
    if (!lookup) {
      const free = this.pickFreeManager();
      if (!free) {
        return { decision: 'busy', account_id: null, manager_id: null, reason: 'unknown-account-all-busy' };
      }
      return { decision: 'bridge', account_id: null, manager_id: free, reason: 'new-account-pick-free' };
    }

    const { account_id, pinned_manager_id } = lookup;

    // Случай 2: закреплён и доступен
    if (pinned_manager_id && this.isManagerAvailable(pinned_manager_id)) {
      return { decision: 'bridge', account_id, manager_id: pinned_manager_id, reason: 'pinned-available' };
    }

    // Случай 3: закреплён, но недоступен
    if (pinned_manager_id) {
      return { decision: 'busy', account_id, manager_id: pinned_manager_id, reason: 'pinned-busy' };
    }

    // Случай 4: account есть, без привязки — берём свободного, gateway закрепит после ответа
    const free = this.pickFreeManager();
    if (!free) {
      return { decision: 'busy', account_id, manager_id: null, reason: 'no-pin-all-busy' };
    }
    return { decision: 'bridge', account_id, manager_id: free, reason: 'no-pin-pick-free' };
  }
}

module.exports = { AccountIsolation };
