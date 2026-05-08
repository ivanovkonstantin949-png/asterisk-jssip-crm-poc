# asterisk-jssip-crm-poc

Прототип IP-телефонии под отдел продаж 20-30 операторов с горизонтальным расширением до 200-300: Asterisk + WebRTC (jsSIP) + Node.js voice-gateway, который интегрируется с CRM заказчика по REST + WebSocket.

Ключевая особенность — изоляция клиента по ответственному менеджеру. Очередей нет, переводов между операторами нет. Если клиент уже общался с менеджером — повторный входящий идёт строго ему. Менеджер занят/не на смене — клиенту проигрывается «все операторы заняты», звонок попадает в стек пропущенных конкретно этого менеджера в CRM.

## Архитектура

```
                         ┌────────────────────────────┐
                         │     Браузер оператора      │
                         │   (jsSIP, WSS, mic/spk)    │
                         └─────────────┬──────────────┘
                                       │ WSS (SIP over WebSocket)
                                       │ SRTP media
                                       ▼
                         ┌────────────────────────────┐
                         │          Asterisk          │
                         │   (PJSIP + WebRTC + ARI)   │
                         └──────┬───────────┬─────────┘
                                │           │
                       SIP/RTP  │           │ ARI (HTTP + WebSocket events)
                       к телеком│           │
                       провайдеру│          ▼
                                 │   ┌──────────────────────────┐
                                 │   │    voice-gateway         │
                                 │   │  ari-client + Express    │
                                 │   │  account-isolation.js ★  │
                                 │   └──────────┬───────────────┘
                                 │              │ REST + WebSocket
                                 │              │ (см. CONTRACT.md)
                                 │              ▼
                                 │   ┌──────────────────────────┐
                                 │   │   ВАША Node.js CRM       │
                                 │   │   (в репо — mock-crm,    │
                                 │   │    имитирует контракт)   │
                                 │   └──────────────────────────┘
                                 ▼
                          PSTN/SIP-trunk
                          (внешние номера)
```

Поток входящего звонка:

1. Asterisk принимает SIP с trunk-а провайдера → dialplan отправляет в Stasis-приложение (ARI).
2. `voice-gateway` получает событие `StasisStart` через WebSocket ARI.
3. `voice-gateway` дёргает `GET /accounts/lookup?phone=...` у CRM → возвращается `account_id` + `pinned_manager_id`.
4. `account-isolation.js` решает: bridge на закреплённого / busy + missed / новый — взять свободного.
5. Если bridge — `originate PJSIP/<manager>`, mixing bridge, `POST /accounts/:id/pin` если новый клиент, webhook `call.bridged`.
6. Если busy — playback «все заняты», webhook `call.missed`.
7. На завершение разговора — webhook `call.ended`.

Real-time статусы операторов (`online`/`busy`/`offline`) приходят в gateway по WebSocket из CRM (`/ws/manager-status`).

## Quick start

```bash
docker compose up
```

Поднимет четыре контейнера:

- `asterisk` — Asterisk 20 с WebRTC-конфигом (порты 8088/8089, 5060, 10000-10010 UDP)
- `mock-crm` — имитация Node.js CRM заказчика (порт 4000), реализует контракт из `CONTRACT.md`
- `voice-gateway` — шлюз ARI ↔ CRM (порт 3000)
- `browser-client` — nginx со статикой jsSIP (порт 8080)

Открыть `http://localhost:8080`, ввести `1001` / `demo-pass-1001`, нажать Register. Между двумя вкладками можно набрать друг друга по extension `1001`/`1002`.

Тест входящего с привязкой к account_id (из mock-crm seed-data):

```bash
# триггер inbound через ARI (не нужен реальный SIP-trunk):
curl -u poc-app:demo-ari-pass-2026 -X POST \
  "http://localhost:8088/ari/channels/externalMedia?app=poc-stasis&external_host=..." # пример

# или просто посмотреть состояния
curl http://localhost:3000/state | jq          # gateway-кэш статусов
curl http://localhost:4000/_debug/events | jq  # все webhook-события, прилетевшие в CRM
curl http://localhost:4000/_debug/accounts | jq # привязки account → manager
```

## Структура

```
asterisk/          конфиги: pjsip, http, ari, extensions, rtp, modules
voice-gateway/     Node.js: ARI-клиент + AccountIsolation + интеграция с CRM
mock-crm/          Имитация Node.js CRM заказчика (REST + WS), реализует CONTRACT.md
browser-client/    Статика: jsSIP-клиент с реконнектом
docker-compose.yml локальный стенд
SCALING.md         как растить с 20-30 до 200-300 операторов
CONTRACT.md        контракт интеграции voice-gateway ↔ CRM (endpoints, webhooks)
```

## Особенности реализации

- **`mock-crm` ≠ продакшен-CRM.** Это имитация контракта, чтобы стенд работал
  без реальной CRM. В проде заменяется на ноду заказчика с теми же endpoint'ами.
- **Изоляция аккаунтов** — `voice-gateway/account-isolation.js`. Семантика:
  `phone → CRM lookup → account_id → manager_id`. Не телефон, а `account_id` —
  единица изоляции (один клиент с разных номеров = тот же `account_id`).
- **Без очередей** — нет `queues.conf`, нет round-robin/longest-idle.
- **Без переводов** — диалплан не предусматривает `transfer` между внутренними экстеншенами.
- **Реконнект** — на jsSIP-клиенте (WSS), на ARI-клиенте gateway, на WS-канале к CRM (все три с экспоненциальным backoff).
- **WSS (TLS)** — продакшен-ready транспорт; для локального теста используется WS на 8088.

## Контракт интеграции

Полное описание endpoint'ов CRM, webhook-событий gateway, формата payload'ов и
гарантий доставки — в [CONTRACT.md](./CONTRACT.md).

## Масштабирование

См. [SCALING.md](./SCALING.md) — переход на кластер Asterisk за SIP-балансировщиком (Kamailio/OpenSIPS) + медиа-прокси (RTPengine) + общий стейт через Redis.

## Что входит в этот PoC и что нет

**Входит:** Asterisk WebRTC, jsSIP-клиент, ARI-интеграция, account-isolation, контракт REST+WS с CRM, доказательство что стенд поднимается end-to-end (см. логи `docker compose logs`).

**Не входит:** реальная регистрация WebRTC под HTTPS-сертификатом, нагрузочный тест 20-30 линий, запись разговоров, метрики Prometheus, продакшен-секреты — это входит в этапы 2-3 проекта по календарю.
