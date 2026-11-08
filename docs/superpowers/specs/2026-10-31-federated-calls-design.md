# Федеративные звонки 1:1 — дизайн

Дата: 2026-10-31
Обновлено: 2026-11-08
Статус: реализовано (MVP 1:1). Известные ограничения и отклонения от
первой редакции — в §11.

## 1. Контекст и цель

Локальные звонки 1:1 реализованы (`backend/calls`, `backend/service/calls.go`,
`frontend/src/calls`, см. `2026-10-20-calls-1to1-design.md`).
Федерация сообщений/чатов реализована (`backend/federation/*`,
`backend/transport/federated.go`, outbox + catch-up).
Звонки между серверами теперь поддержаны: при удалённом callee
`StartCall` уходит в `startFederatedCall` (`backend/service/calls_federated.go`),
а не возвращает `ErrRemoteCallee`.

Цель — **аудио/видео звонок 1:1 в private-чате между пользователями разных
серверов**, с заделом на группы. Медиа остаётся P2P (`DTLS-SRTP`), серверы
только сигнализируют. Отдельный E2E-слой для медиа не вводится.

## 2. Границы MVP

Входит:

- звонок 1:1 между `nick:domainA` и `nick:domainB` в существующем
  federated private-чате (2 мембера);
- владение звонком сервером звонящего, тень на сервере callee;
- обмен ICE-конфигами (union short-lived TURN-кред);
- сигналинг поверх существующей federated-подписи (`fedSecurity`);
- `busy/timeout/offline/hangup`, идемпотентные `invite/ended`;
- SSE fan-out только локально, push `call_incoming` как сейчас;
- тесты backend + frontend + автоматический стенд из двух серверов.

Не входит:

- группы / SFU (задел — архитектура владельца; поля `sfuURL` в текущем
  протоколе нет);
- запись, транскрипция;
- звонки в self-чатах и группах;
- переиспользование outbox-очереди для сигналинга звонков;
- миграция/шардирование in-memory реестра.

## 3. Архитектура: сервер звонящего — владелец

```
caller (A)   server A (owner)              server B (proxy)   callee (B)
   |              |                              |                 |
   |--POST /calls |                              |                 |
   | {chat,offer} |                              |                 |
   |              |--POST /federated/calls/invite |                 |
   |              | {callID,chat,caller,callee,   |                 |
   |              |  offer,iceA}                  |--call_incoming->|
   |              |                         200/409                 |
   |              |                              |<--POST .../accept|
   |              |                              |  {answer,iceB}   |
   |              |<--POST /federated/calls/accept|                 |
   |<-call_accepted                              |                 |
   |========= медиа P2P (DTLS-SRTP, union ICE) ===================|
   |--trickle ice-->...-->POST /federated/calls/ice-->...-->B    |
```

Почему владелец, а не зеркало: один `calls.Manager` с таймерами
(`RingingTimeout=45s, ActiveTTL=4h, EndedTTL=10m`), один `OnEnded`,
нет сплит-брейна `hangup vs timeout`. Зеркало удваивало бы таймеры и
`busy`-гонки ради эфемерных 45 секунд. Прямой клиент→чужой сервер
отвергнут: у клиента нет federated-подписи, ломается auth-модель.

Сервер B хранит только тень inbound-звонка для `busy-callee` и
маршрутизации:
`FederatedInbound{CallID, Owner, ChatID, CallerID, CalleeID, Offer, ExpiresAt}`.
TTL тени = ringing window (45с). После `accept` прокси продлевает её на
`ActiveTTL`: без тени он не сможет маршрутизировать `ice/hangup/ended`
владельцу во время активного звонка. `ended` владельца удаляет тень.
Graceful shutdown владельца завершает его локальные звонки и присылает
`ended`; при краше `ended` не приходит, и тень живёт до `ActiveTTL`.

Маршрутизация есть: `chat.RemoteServer`, `RemoteServerFromIDFor`,
`UserIDBelongsToServer`. `StartCall` вместо `ErrRemoteCallee` делает
`signed Request` на `https://<remote>/api/federated/calls/invite`.

## 4. API сигналинга (все под `federationSignature`)

Общего конверта и `seq` нет: идентификатор звонка едет в пути, тела
описаны ниже. Идемпотентны только `invite` (повтор с теми же полями
возвращает 200 и повторяет нотификацию) и `ended` (повтор — 200 no-op).
Лимиты те же: `offer/answer ≤32KiB`, `candidate ≤16KiB`, тело federated
`≤1MiB`.

- `POST /api/federated/calls/invite {remoteServer, callId, chatId,
  callerId, calleeId, offer, iceServers?}` → `200 {ok}` /
  `409 busy-callee` / `403 wrong peer, unknown or foreign chat`.
  `remoteServer` обязателен и должен совпасть с подписантом. Проверки B:
  `chat.RemoteServer == X-Federation-Server`, оба — мемберы чата,
  `callee` локален, `caller` принадлежит отправителю, `ValidateOffer`,
  тень свободна. Успех: создать тень, `sendEvent(callee,
  call_incoming)`.
- `POST /api/federated/calls/{id}/accept {answer, iceServers?}` (B→A):
  владелец `AcceptCall`, `sendEvent(caller, call_accepted)`, отчёт
  прокси с `answer/iceServers`. Ошибка: `410 expired/not found`,
  `409 not ringing/already ended`.
- `POST /api/federated/calls/{id}/reject` (B→A) — пустое тело;
  `POST /api/federated/calls/{id}/hangup {reason?}` (в обе стороны).
  Владелец — терминальное состояние, рассылает `ended` обеим сторонам
  (`POST /api/federated/calls/{id}/ended {reason?}` + локальный
  `sendEvent`). `reason ∈ {hangup, rejected, timeout, peer-left}`; из
  тела `hangup` принимается только `peer-left`, остальное ставит сервер;
  `reject` всегда завершает как `rejected`.
- `POST /api/federated/calls/{id}/ice {candidate}` (в обе стороны):
  `ValidateICECandidate`, форвард владельцу/прокси + `sendEvent(peer,
  call_ice)`. Без гарантии доставки: опоздавший или дублирующий кандидат
  дропается клиентом по `generation` (как сейчас).
- `POST /api/federated/calls/{id}/ended {reason?}` (A→B): стереть тень,
  `sendEvent(callee, call_ended)`; повторный вызов — 200.

Владелец также шлёт `accepted/ended/ice` в сторону B тем же способом
(`Client.Request` на сервер B). Клиентский REST (`/api/calls/*`) не меняется;
`GET /api/calls/current` на владельце отдаёт полное состояние, на прокси —
тень как `ringing` (состояние `active` на прокси не хранится).

## 5. ICE-обмен и медиа

`ICEConfig = {stun[], turn[{urls, username, credential}]}` уже отдаётся
клиентам (`GET /api/ice`, `internal/turn.Generate`, TTL 1ч). Для федерации:

- A в `invite` кладёт свой `iceServers` (со свежими TURN-кредами под
  `callerID`), B в `accept` — свой (под `calleeID`);
- каждый клиент делает `union(stunA+stunB, turnA+turnB)` в
  `new RTCPeerConnection({iceServers: union})`;
- долгоживущие секреты не передаются, только short-lived `username/password`
  (перехват даёт ≤1ч relay, не доступ к аккаунту);
- нет TURN ни у кого — звонок всё равно пробуется через `host/srflx`.

Известное ограничение MVP: union применяется только у callee. Caller создаёт
`RTCPeerConnection` до получения `remoteIce` (offer нужен уже для `invite`),
поэтому ICE-серверы задаются только в конструкторе, а `remoteIce` из `accept`
лишь сохраняется без применения к running-соединению. Если relay callee
недоступен caller'у через его собственный TURN, медиа может не подняться.
Follow-up: re-offer endpoint / `restartIce` для пересоздания соединения
caller'а с полным union после получения `accept`.

Задел на группы: поля `sfuURL` в текущем протоколе нет. Когда появится
SFU, владелец станет хостом, клиенты пойдут на его `sfuURL`, сигналинг
не изменится.

## 6. Тайминги, гонки, ошибки

Транспорт сигналинга — только синхронный `federation.Client.Request`
(timeout 10с), НЕ `outbox`: drain 5с + exp-backoff до 5мин несовместимы
с ringing 45с и trickle ICE. Потеря пакета закрывается существующими
механизмами: звонящий висит до `timeout`, callee — `reconcile GET /current`,
`Sweep` чистит тени и висяки.

Таблица решений:

| Ситуация | Поведение |
|---|---|
| `A` caller busy | `409 busy-caller` локально, federated не ходим |
| `B` callee busy | тень занята → `409 busy-callee` в ответ на `invite` → A завершает звонок как `call_ended` с `reason=hangup` (отдельного `busy` reason нет) |
| callee офлайн | `invite` принимается, B шлёт push `call_incoming`, тень ждёт 45с → A: `timeout` |
| гонка `hangup vs accept` | решает владелец: кто первый дошёл до `Manager`, второй получает `409 not ringing` или `409 already ended` |
| дубли `invite/ended` | повтор не создаёт вторую тень: `invite` повторяет нотификацию, `ended` — no-op, оба отвечают 200 |
| дубли `ice` | без `seq`: повтор доставляется как есть, клиент дропает его по `generation` |
| партиция A↔B mid-call | медиа P2P продолжает идти; `disconnected 10s grace` на клиенте, затем `peer-left`; `ActiveTTL` — страховка |
| graceful shutdown A | локальные звонки завершаются, `ended` уходит на B, тень стирается |
| краш A | `ended` не приходит, тень B живёт до `ActiveTTL`; клиент B завершает звонок по `disconnected` grace, но `GET /current` может вернуть тень как `ringing` до истечения |
| рестарт B | A получает `timeout` через 45с; повторный `invite` создаст новую тень |

Push: `call_incoming` через существующий `sendPushBounded`
(`tag=call-<id>`) на сервере B, как сейчас локально.

Офлайн callee — сознательное отличие от первой редакции: `404/410` не
возвращается. Присутствие по SSE ненадёжно (второй таб, задержка
переподключения), а push — единственный канал, которым офлайн-пользователь
узнаёт о звонке; локальные звонки ведут себя так же. Звонящий получает
`timeout` через 45с, если никто не ответил.

## 7. Безопасность

Переиспользуется всё существующее: `Manager.Sign/Verify`
(`RSA-SHA256`, `audience=host получателя`, `timestamp ±5мин`,
`nonce` антиреплей 10мин), `FederatedAuthMiddleware`,
`isValidFederationDomain`, `SafeHTTPClient` (SSRF). Дополнительно:

- `callerID` обязан принадлежать `X-Federation-Server` отправителя,
  `calleeID` — получателю (анти-подмена);
- `chat.RemoteServer` обязан совпасть с отправителем
  (паттерн `federatedChatForSource`);
- `ValidateOffer/Answer/ICECandidate` на обоих серверах (владелец доверяет,
  но проверяет: B уже проверил, A проверяет снова перед `CreateCall`);
- SDP содержит IP-кандидаты пиров — считается чувствительным, логируем
  только `callID/chatID/reason`, не тела.

Медиа-E2E отдельно не строится: P2P `DTLS-SRTP` уже E2E, TURN — только relay.

## 8. Frontend

- `callManager.ts`: `start()` для federated-чата ждёт тот же
  `POST /api/calls` — сервер сам решает federated или локально; клиент
  разницы не видит.
- `handleIncoming/Accepted`: `remoteIce` сохраняется, при `createPeer`
  передаётся union. Поздний `accepted` дропается по `generation`.
  Ограничение union у caller'а описано в §5.
- `useCall.ts reconcile`: `GET /current` на своём сервере отдаёт тень;
  поведение при F5/pagehide без изменений (`hangup peer-left`).
- UI: кнопка звонка доступна в private 1:1, в том числе собеседнику с
  другого сервера; у federated-чата показывается remote-бейдж.
- Audio-only fallback: если камера недоступна, звонок идёт с микрофоном;
  `cameraOn` выставляется по фактическому видеотреку, превью и кнопка
  камеры при его отсутствии не показываются.

## 9. Тестирование и приёмка

- `service`: federated invite→shadow→busy-callee, форвард accept/hangup,
  точные тела invite/accept/hangup/reject/ice/ended, тень истекает;
- `transport/federated_calls`: подпись/verify, `403 wrong peer`,
  `409 busy`, идемпотентность `invite/ended`, капы `32/16KiB`;
- `frontend`: union ICE, поздний `accepted` по `generation`, тень в
  `current`, audio-only fallback;
- стенд из двух серверов (`make frontend:e2e:federated`): медиа A→B и
  B→A, decline, reload звонящего (`peer-left`), audio-only, hangup callee;
- CI: отдельный прогон федеративного стенда: Playwright сам поднимает два
  бэкенда и два dev-сервера.

## 10. Задел на группы (не реализуется сейчас)

`callID = {ownerDomain, localID}`, `owner` хранит реестр, участники —
тени. SFU поднимается у владельца, адрес раздаётся в `invite/accepted`
полем `sfuURL` (в текущем протоколе поля нет). Сигналинг 1:1 без
изменений переиспользуется для `join/leave/ice` группового звонка.

## 11. Известные ограничения и отклонения от первой редакции

- **Нет `seq`-идемпотентности.** Идемпотентны `invite` и `ended`;
  дубли `ice` доставляются как есть и дропаются клиентом по `generation`.
- **`invite` отвечает `200`, не `201`.** Остальные федеративные ручки
  тоже отвечают `200 {ok}`.
- **Busy без отдельного reason.** При `409 busy-callee` звонящий получает
  `call_ended` с `reason=hangup`; отдельного `busy` в клиентском
  протоколе нет.
- **Гонка `hangup vs accept` — `409`.** Проигравший получает
  `409 not ringing` или `409 already ended`, а не `404/410`.
- **Офлайн callee получает push.** `404/410` не возвращается: presence по
  SSE ненадёжен, push — единственный канал офлайн-пользователю; звонящий
  получает `timeout` через 45с (см. §6).
- **Тень после `accept` живёт `ActiveTTL`.** Иначе прокси не сможет
  маршрутизировать `ice/hangup/ended` активного звонка. При краше
  владельца тень B не удаляется до `ActiveTTL`; `GET /current` на прокси
  может вернуть её как `ringing`, хотя клиент уже завершил звонок по
  `disconnected` grace.
- **`GET /current` на прокси всегда `ringing`.** Состояние `active` на
  прокси не хранится, только тень.
- **Union ICE только у callee.** Caller создаёт соединение до получения
  `remoteIce`; см. §5.
- **Нет `sfuURL`** — задел на группы описан в §10, но полем протокола
  ещё не стал.
- **TURN в автостенде не поднимается.** Стенд проверяет сигналинг и
  медиа на loopback; поведение через relay проверяется отдельно с
  настроенным coturn.
