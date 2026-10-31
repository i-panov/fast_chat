# Федеративные звонки 1:1 — дизайн

Дата: 2026-10-31
Статус: на ревью, после аппрува — к планированию реализации

## 1. Контекст и цель

Локальные звонки 1:1 реализованы (`backend/calls`, `backend/service/calls.go`,
`frontend/src/calls`, см. `2026-10-20-calls-1to1-design.md`).
Федерация сообщений/чатов реализована (`backend/federation/*`,
`backend/transport/federated.go`, outbox + catch-up).
Звонки между серверами запрещены: `service/calls.go:StartCall` возвращает
`ErrRemoteCallee` (403).

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
- `busy/timeout/offline/hangup`, идемпотентные повторы;
- SSE fan-out только локально, push `call_incoming` как сейчас;
- тесты backend + frontend + ручной стенд из двух серверов.

Не входит:

- группы / SFU (только задел: `owner`, `sfuURL?`);
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
   |              |                         201/409                 |
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
`FederatedInbound{CallID, Owner, ChatID, CallerID, CalleeID, ExpiresAt}`.
TTL = ringing timeout. Активный звонок тень не продлевает: `ended`
от владельца её стирает; рестарт владельца = `timeout` у обоих
(как сейчас при рестарте одного сервера).

Маршрутизация есть: `chat.RemoteServer`, `RemoteServerFromIDFor`,
`UserIDBelongsToServer`. `StartCall` вместо `ErrRemoteCallee` делает
`signed Request` на `https://<remote>/api/federated/calls/invite`.

## 4. API сигналинга (все под `federationSignature`)

Общий конверт: `{callId, chatId, callerId, calleeId, seq}` + специфичные
поля. `seq = callID + направление + счётчик` для идемпотентности повторов;
повтор = тот же ответ 200 без побочных эффектов. Лимиты те же:
`offer/answer ≤32KiB`, `candidate ≤16KiB`, тело federated `≤1MiB`.

- `POST /api/federated/calls/invite {callID, chatID, callerID, calleeID,
  offer, iceServers}` → `201 {ok}` / `409 busy-callee` / `404 no chat` /
  `403 wrong peer`. Проверки B: `chat.RemoteServer == X-Federation-Server`,
  оба — мемберы чата, `callee` локален, `caller` принадлежит отправителю,
  `ValidateOffer`, тень свободна. Успех: создать тень, `sendEvent(callee,
  call_incoming)`.
- `POST /api/federated/calls/{id}/accept {answer, iceServers}` (B→A):
  владелец `AcceptCall`, `sendEvent(caller, call_accepted)`. Ошибка:
  `404/410 expired`, `409 not ringing`.
- `POST /api/federated/calls/{id}/reject|hangup {reason}` (в обе стороны):
  владелец — терминальное состояние, рассылает `ended` обеим сторонам
  (`POST /api/federated/calls/{id}/ended {reason}` + локальный `sendEvent`).
  `reason ∈ {hangup, rejected, timeout, peer-left}`; из тела принимается
  только `peer-left`, остальное ставит сервер (как сейчас).
- `POST /api/federated/calls/{id}/ice {candidate}` (в обе стороны):
  `ValidateICECandidate`, форвард владельцу/прокси + `sendEvent(peer,
  call_ice)`. Без гарантии доставки: опоздавший кандидат дропается клиентом
  по `generation` (как сейчас).
- `POST /api/federated/calls/{id}/ended {reason}` (A→B): стереть тень,
  `sendEvent(callee, call_ended)`.

Владелец также шлёт `accepted/ended/ice` в сторону B тем же способом
(`Client.Request` на сервер B). Клиентский REST (`/api/calls/*`) не меняется;
`GET /api/calls/current` на каждом сервере отдаёт свою половину
(владелец — полное состояние, прокси — тень как `ringing`).

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

Задел на группы: в `invite/accept` резервное поле `sfuURL?` (пока всегда
пусто). Когда появится SFU, владелец станет хостом, клиенты пойдут на его
`sfuURL`, сигналинг не изменится.

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
| `B` callee busy | тень занята → `409 busy-callee` в ответ на `invite` → A: `Ended(busy)`, notice звонящему |
| callee офлайн | B отвечает `404/410` (нет SSE-доставки) → A: `timeout` |
| гонка `hangup vs accept` | решает владелец: кто первый дошёл до `Manager`, второй получает `404/ended` |
| дубли `invite/ice/ended` | идемпотентно по `callID+seq`, повтор = 200 |
| партиция A↔B mid-call | медиа P2P продолжает идти; `disconnected 10s grace` на клиенте, затем `peer-left`; `ActiveTTL` — страховка |
| рестарт A | звонок потерян, B-тень истекает за 45с → `timeout` у B |
| рестарт B | A получает `timeout`; тень пересоздастся при повторном `invite` |

Push: `call_incoming` через существующий `sendPushBounded`
(`tag=call-<id>`) на сервере B, как сейчас локально.

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

- `callManager.ts`: `start()` для federated-чата (`peer.domain != self`)
  ждёт тот же `POST /api/calls` — сервер сам решает federated или локально;
  клиент разницы не видит, кроме `iceServers = union(local, remote)`:
  `remote` приходит в `call_incoming/call_accepted` payload.
- `handleIncoming/Accepted`: сохранить `remoteIce`, при `createPeer`
  передать union. Поздний `accepted` дропается по `generation` (как сейчас).
- `useCall.ts reconcile`: `GET /current` на своём сервере уже отдаёт тень;
  поведение при F5/pagehide без изменений (`hangup peer-left`).
- UI без изменений: `CallButton` уже разрешён для private 1:1, надо снять
  проверку `domain(peer)==domain(self)` и показать `remote`-бейдж.

## 9. Тестирование и приёмка

- `service`: federated invite→shadow→busy-callee, форвард accept/hangup,
  `hangup vs timeout` решает владелец, тень истекает;
- `transport/federated_calls`: подпись/verify, `403 wrong peer`,
  `409 busy`, идемпотентность повторов, капы `32/16KiB`;
- `frontend`: union ICE, поздний `accepted` по `generation`, тень в `current`;
- ручной стенд: два сервера (`allow_private_addresses=true`), TURN на одном,
  звонок A→B и B→A, `hangup/reject/timeout`, убийство сети mid-call
  (медиа держится, затем `peer-left`);
- CI: расширить `e2e/calls.e2e.ts` federated-сценарием при наличии стенда.

## 10. Задел на группы (не реализуется сейчас)

`callID = {ownerDomain, localID}`, `owner` хранит реестр, участники —
тени. SFU поднимается у владельца, адрес раздаётся в `invite/accepted`
полем `sfuURL`. Сигналинг 1:1 без изменений переиспользуется для
`join/leave/ice` группового звонка.
