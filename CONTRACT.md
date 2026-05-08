# Контракт интеграции voice-gateway ↔ CRM

Документ описывает, какие endpoints должна предоставить ваша Node.js CRM
и какие webhook-события шлёт ей `voice-gateway`. В репо есть референсная
реализация — `mock-crm/server.js`. В проде вместо него подключается ваша CRM
с теми же сигнатурами.

Все примеры — JSON, `Content-Type: application/json`. Время — ISO-8601 UTC.
Авторизация в проде — через `Authorization: Bearer <token>` (опущена в PoC).

---

## 1. Endpoints, которые реализует CRM

### 1.1 `GET /accounts/lookup?phone=<E.164>`

Запрос от gateway при входящем звонке: «есть ли в CRM аккаунт с таким телефоном
и кто за ним закреплён».

- **200** — аккаунт найден

```json
{
  "phone": "+79991110001",
  "account_id": "ACC-1001",
  "pinned_manager_id": "1001",
  "last_seen_at": "2026-05-07T10:30:00Z"
}
```

`pinned_manager_id` может быть `null` — это значит «аккаунт есть, но
закреплённого менеджера ещё нет, можно назначить».

- **404** — телефон не найден. Gateway трактует как нового клиента: берёт
  любого свободного из пула и просит CRM закрепить его (см. §1.4).

### 1.2 `GET /managers/:id`

Snapshot статуса менеджера (online/busy/offline + on_shift). Используется gateway
как fallback, если WS-канал ещё не установлен.

```json
{ "manager_id": "1001", "status": "online", "on_shift": true }
```

### 1.3 `WS /ws/manager-status`

WebSocket-канал, по которому CRM **публикует** изменения статуса операторов.
Gateway открывает соединение и слушает. Снэпшот всех менеджеров CRM
рекомендуется отправить при подписке.

Формат событий:

```json
{
  "manager_id": "1001",
  "status": "online",
  "on_shift": true,
  "ts": "2026-05-08T10:00:00Z"
}
```

`status`: `online | busy | offline`.
Gateway держит локальный кэш этих статусов и использует его в
`AccountIsolation.isManagerAvailable()`.

### 1.4 `POST /accounts/:id/pin`

```json
{ "manager_id": "1001" }
```

→ `204 No Content`. Закрепляет аккаунт за менеджером после ответа на звонок
от нового клиента (тот, у кого `pinned_manager_id` был `null` или 404 на lookup).

---

## 2. Webhook-события, которые шлёт gateway в CRM

`POST <CRM>/calls/events` → `204 No Content`.

Общая схема payload:

```json
{
  "event": "call.incoming",
  "channel_id": "1715166000.42",
  "caller": "+79991110001",
  "account_id": "ACC-1001",
  "manager_id": "1001",
  "reason": "pinned-available",
  "ts": "2026-05-08T10:00:00.123Z"
}
```

### События

| event           | когда                                                 | manager_id      | reason значения                                                                                                  |
| --------------- | ----------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `call.incoming` | поступил входящий, gateway принял решение             | возможен `null` | `pinned-available`, `pinned-busy`, `no-pin-pick-free`, `no-pin-all-busy`, `new-account-pick-free`, `unknown-...` |
| `call.bridged`  | менеджер ответил, RTP пошёл                           | всегда заполнен | —                                                                                                                |
| `call.missed`   | менеджер был занят/не ответил, либо вообще никого нет | возможен `null` | `pinned-busy`, `no-answer`, `unknown-account-all-busy`, `no-pin-all-busy`                                        |
| `call.ended`    | разговор завершён (любая сторона положила трубку)     | заполнен        | —                                                                                                                |

### Гарантии и идемпотентность

- `channel_id` — уникальный идентификатор звонка в Asterisk. Используйте его
  как идемпотентный ключ при записи в CRM.
- Порядок: для одного `channel_id` может быть `incoming → bridged → ended`
  ИЛИ `incoming → missed`. `missed` и `bridged` взаимоисключающие.
- В проде webhook-доставка через outbox-таблицу + retry; в PoC fire-and-forget с логом ошибки.

---

## 3. Поток входящего звонка

```
   PSTN/SIP-trunk → Asterisk (dialplan from-trunk) → Stasis(poc-stasis, "inbound", DID, callerId)
                                                                 │
                                                                 ▼
                                          voice-gateway StasisStart handler
                                                                 │
                                          1) GET CRM /accounts/lookup?phone=...
                                          2) AccountIsolation.route(phone)
                                          3) webhook call.incoming
                                                                 │
                            ┌────────────────────────────────────┴────────────────────────────────────┐
                            ▼                                                                          ▼
                   decision = "bridge"                                                       decision = "busy"
                            │                                                                          │
              originate PJSIP/<manager>                                                playback "all-busy" → hangup
                            │                                                                          │
                  on StasisStart outbound:                                                webhook call.missed
                  - mixing bridge (in + out)
                  - если account_id и менеджер взят из пула:
                      POST CRM /accounts/:id/pin
                  - webhook call.bridged
                            │
                  on StasisEnd inbound:
                  - hangup outbound, destroy bridge
                  - webhook call.ended
```

---

## 4. Что НЕ входит в контракт (по требованию заказчика)

- Нет очередей. CRM не получает события `call.queued`, gateway не делает
  round-robin/longest-idle. Только прямая привязка `account_id → manager_id`.
- Нет переводов между операторами. Нет endpoint'а `transfer`, нет события
  `call.transferred`. Если менеджер закреплён за аккаунтом — звонок идёт
  только к нему, иначе busy.
- Нет IVR-веток. Только короткое busy-сообщение для занятых случаев.

---

## 5. Расширение в проде (вне рамок PoC, для контекста)

- Запись разговоров: `call.bridged.recording_path` или отдельный webhook
  `call.recording_ready` со ссылкой на S3-объект.
- Метрики качества (MOS, drop_rate) — отдельный канал в Prometheus, не в CRM.
- Авторизация webhooks — HMAC-SHA256 подпись в заголовке.
- Outbox-таблица для гарантии доставки webhook'ов при недоступности CRM.
