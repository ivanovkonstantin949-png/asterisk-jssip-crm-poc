# asterisk-jssip-crm-poc

Прототип IP-телефонии под отдел продаж 20-30 операторов: Asterisk + WebRTC (jsSIP) + Node.js-бэкенд с интеграцией CRM через Asterisk REST Interface (ARI).

Ключевая особенность: изоляция клиента по ответственному менеджеру. Очередей нет, переводов между операторами нет. Если клиент уже общался с менеджером — повторный входящий идёт строго ему. Менеджер занят/не на смене — клиенту проигрывается «все операторы заняты», звонок попадает в стек пропущенных конкретно этого аккаунта, перезванивает только закреплённый менеджер.

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
                                 │   │     Node.js backend      │
                                 │   │  ari-client + Express    │
                                 │   │  account-isolation.js ★  │
                                 │   └──────────┬───────────────┘
                                 │              │
                                 ▼              ▼
                          PSTN/SIP-trunk    CRM (PostgreSQL/REST)
                          (внешние номера)  account_id ↔ manager_id
```

Поток входящего звонка:

1. Asterisk принимает SIP с trunk-а провайдера → dialplan отправляет в Stasis-приложение (ARI).
2. Node.js получает событие `StasisStart` через WebSocket ARI.
3. `account-isolation.js` смотрит в CRM: за этим caller_id уже закреплён менеджер?
4. Если да и менеджер свободен — Bridge с его WebRTC-эндпоинтом. Если занят — proigrыvается busy-сообщение, звонок логируется в missed для этого менеджера.
5. Если менеджер не закреплён — берётся свободный из пула, закрепляется в CRM.

## Quick start

```bash
docker-compose up
```

Поднимет три контейнера:

- `asterisk` — Asterisk 20 с WebRTC-конфигом (порты 8088/8089, 5060, 10000-10100 UDP)
- `crm-backend` — Node.js + ARI client (порт 3000)
- `browser-client` — nginx со статикой jsSIP (порт 8080)

Открыть `http://localhost:8080`, ввести логин `1001` (или `1002`), пароль `webrtc-secret`, нажать Register. Между двумя вкладками можно набрать друг друга по extension.

## Структура

```
asterisk/          конфиги: pjsip, http, ari, extensions
crm-backend/       Node.js: Express + ws + ari-client + account-isolation
browser-client/    статика: jsSIP-клиент с реконнектом
docker-compose.yml локальный стенд за 5 минут
SCALING.md         как растить с 20-30 до 200-300 операторов
```

## Особенности реализации

- **Изоляция аккаунтов** — `crm-backend/account-isolation.js`. Маппинг `caller_id → manager_id` хранится в CRM (для демо — in-memory Map, в проде — PostgreSQL/Redis).
- **Без очередей** — нет `queues.conf`, нет распределения round-robin/longest-idle. Только прямая привязка.
- **Без переводов** — диалплан не предусматривает `transfer`/`attended_transfer` между внутренними экстеншенами.
- **Реконнект на клиенте** — jsSIP UA автоматически переподключается при разрыве WSS, состояние регистрации восстанавливается.
- **WSS (TLS)** — продакшен-ready транспорт; для локального теста используется WS на 8088.

## SCALING

См. [SCALING.md](./SCALING.md) — переход на кластер Asterisk за SIP-балансировщиком (Kamailio/OpenSIPS) + медиа-прокси (RTPengine) + общий стейт через Redis.

## Лицензия и использование

Демо-репозиторий для оценки архитектурного подхода. Production-вариант поставляется отдельно с учётом реальных интеграций (CRM, биллинг, провайдер telephony, SBC).
