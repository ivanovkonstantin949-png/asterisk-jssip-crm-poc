# Масштабирование 20-30 → 200-300 операторов

Текущий прототип рассчитан на одну Asterisk-ноду — это комфортно держит 20-30 одновременных WebRTC-сессий с медиа через сам Asterisk. Дальше схема меняется: signalling, media и state разносятся по разным компонентам.

## Целевая топология

```
            Браузеры операторов
                    |
                   WSS
                    v
           Kamailio / OpenSIPS (LB)
           SIP-балансировщик + WSS-терминация,
           dispatcher, registrar в общем Redis
            /         |         \
           v          v          v
       Asterisk-1  Asterisk-2  ...  N узлов
       (Stasis)    (Stasis)
           |          |
           v          v
              RTPengine (cluster)
              отдельные хосты под media

       Node.js backend (N inst)
       ARI clients per node, общий Redis для state
                    |
                    v
              CRM (PostgreSQL)
```

## Компоненты и зачем

### Kamailio/OpenSIPS перед кластером Asterisk

- Терминирует WSS от браузеров, балансирует SIP-регистрации между Asterisk-узлами.
- Использует `dispatcher` модуль для round-robin/least-loaded.
- Общий registrar через Redis: любой Asterisk видит всех зарегистрированных операторов.
- Отдельная зона ответственности: signalling-балансировщик не делает media — это резко снижает CPU.

### Несколько Asterisk-узлов с одинаковым dialplan

- Идентичные конфиги (Ansible/Terraform), Stasis-приложение одно и то же имя.
- Каждый узел подключается своим ARI-клиентом к Node.js backend.
- При падении одного узла Kamailio перенаправляет регистрации на живые.

### RTPengine для отделения media от signalling

- Asterisk → RTPengine через `chan_pjsip` `media_address` или `rtp_engine`.
- Media-плоскость масштабируется отдельно: RTPengine на bare-metal или dedicated VM с большим egress.
- Эмпирика: 1 RTPengine-нода держит ~500-800 одновременных RTP-сессий при разумном кодеке (Opus/G.722).

### Redis для shared state

- Карта `account_id → manager_id` (та самая `account-isolation`-логика) выезжает из in-memory в Redis.
- Любой Node.js-инстанс на любом Asterisk-узле читает одинаковую правду.
- Стек пропущенных по менеджеру — Redis Streams или Sorted Set по timestamp.
- Replication + Sentinel для HA.

### Node.js backend (несколько инстансов)

- Каждый инстанс держит ARI WebSocket к одному из Asterisk-узлов.
- Stateless логика: всё чтение/запись маршрутизации идёт в Redis/PostgreSQL.
- За балансировщиком (nginx/HAProxy) для REST/WebSocket-каналов от CRM.

## Расчёт capacity

Грубая оценка под 200-300 одновременных активных разговоров (это уже плотный отдел продаж 250-400 операторов с учётом простоев):

| Слой           | Нод | На каждой              | Запас                  |
| -------------- | --- | ---------------------- | ---------------------- |
| Kamailio       | 2   | до 5000 регистраций    | HA-пара active/standby |
| Asterisk       | 3-4 | ~100 одноврем. сессий  | +1 запасная нода       |
| RTPengine      | 2-3 | ~600 RTP-потоков       | по нагрузке egress     |
| Node.js        | 3-4 | по одному на Asterisk  | поверх Redis           |
| Redis          | 3   | Sentinel               | RAM > rate × 24h       |
| PostgreSQL     | 1+1 | primary + replica      | для CRM-данных         |

## Миграция с прототипа в кластер

1. Вынести Asterisk-конфиги в Ansible-роль (одинаковый dialplan для всех узлов).
2. Заменить in-memory `Map` в `account-isolation.js` на Redis с теми же сигнатурами функций (`get/set/list missed`).
3. Поднять Kamailio с минимальным `dispatcher.list` → перенаправить WSS-домен на него.
4. Вынести media через RTPengine (`rtpengine.conf` на каждом Asterisk).
5. Развернуть N Asterisk-узлов, добавить в Kamailio dispatcher.
6. Node.js backend через PM2/systemd по N инстансов на инфра-нодах.

## Что сознательно НЕ растёт

- **Очереди (Queue)** — отсутствуют по требованию заказчика, изоляция account_id важнее равномерной нагрузки.
- **IVR-ветки** — только короткое busy-сообщение, никакого «нажмите 1 для отдела продаж».
- **Mobile-софтфоны** — все операторы только в браузере, не нужен NAT-traversal/STUN-фермы для абонентов.

## Что добавится в проде помимо scaling

- SBC (Session Border Controller) на стыке с провайдером — Kamailio в роли SBC или отдельный.
- Запись разговоров: Asterisk MixMonitor → S3-совместимое хранилище.
- Метрики: Prometheus exporters для Asterisk, RTPengine, Kamailio + Grafana.
- Алертинг по drop_rate, MOS, register_failures.
