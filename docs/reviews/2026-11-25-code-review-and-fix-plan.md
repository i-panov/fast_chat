# Полное ревью fast_chat и план фиксов

- Дата: 2026-11-25
- База: `master` @ `816db60` (рабочее дерево без изменений)
- Область: backend (Go), frontend (React/TS PWA), SDK (TypeScript, Python), интеграции Hermes/DSH
- Метод: 17 узких зон, две независимые волны ревью; отчёты сведены, дубликаты объединены
- Код не менялся: документ фиксирует результаты read-only ревью

> **Итог (2026-11-26).** Ревью и серия раундов исправлений завершены; v3
> мастер-ключа реализован, документация обновлена, проверки зелёные.
> Актуальные детали — в разделах «Четвертый заход — v3» и далее, а итоговые
> команды/цифры — в «Проверки на итоговом дереве».

## Легенда

| Статус | Значение |
|--------|----------|
| ✅ | Проверено по конкретным строкам кода |
| ◐ | Замечание из отчёта, построчно не проверялось; перед фиксом подтвердить |
| ⚠ | Валидно с оговоркой: осознанный компромисс, продуктовое решение или редкий сценарий |

Severity:

- **Critical** — эксплуатируемая уязвимость, необратимая потеря данных/ключей или полная поломка ключевого сценария.
- **Important** — реальная функциональная/security-дыра, потеря данных в достижимом сценарии, заметная деградация.
- **Minor** — некорректный edge case, утечка ресурсов, плохая диагностика, UX/доступность.

## Сводка

| Severity | Кол-во |
|----------|--------|
| Critical | 10 |
| Important | ~92 |
| Minor | ~105 |

Главные кластеры:

1. **E2EE-аутентичность и ключи** — нет подписи отправителя/AAD, «разотзываемые» device-ключи, plaintext-имя вложения, удаление БД с ключом по 401.
2. **Потеря данных в sync/композере** — `ServerNow` после выборок, курсор на каждой странице, `missingIDs` → 400, состояние композера без привязки к чату.
3. **Федерация** — группы не покрыты catch-up, правки/удаления/typing не релеятся, lifecycle мимо outbox.
4. **Доступность** — SSE-кап без per-user квоты, `ReadTimeout` против 50 МБ, файлы без GC/квоты.
5. **Модерация/боты** — утечка `isAdmin`, Bot API без лимитов, `bot_chats` после удаления чата.

---

# Часть I. Полный список findings

## 1. Backend: Auth / Sessions / Devices / Keys / Rate limit

| ID | Sev | Проблема | Где | Статус |
|----|-----|----------|-----|--------|
| AUTH-01 | Important | Перебор 6-значного OTP: нет бюджета попыток на email/код, лимит только по IP | `store/codes.go:50-71`, `service/auth.go:96` | ✅ |
| AUTH-02 | Important | `email.debug_mode` возвращает код входа в HTTP-ответе (`debugCode`), а не только в лог | `transport/auth.go:113-117` | ✅ |
| AUTH-03 | Important | Setup-token сжигается до `CreateUserWithSession`: занятый ник/ошибка БД оставляют регистрацию в тупике | `service/auth.go:166-187` | ✅ |
| AUTH-04 | Important | Device backup/revoke отвечают 200 на no-op: `RowsAffected` не проверяется | `store/devices.go:39-62` | ✅ |
| AUTH-05 | Important | Logout/trim ревокирует device-ключ и скрывает его backup: восстановить историю устройства нельзя | `store/sessions.go:248`, `store/devices.go:54` | ✅ |
| AUTH-06 | Minor | `send-code` без лимита на email: бомбардировка чужого ящика и перезапись живого кода | `service/auth.go:74`, `store/codes.go:43` | ✅ |
| AUTH-07 | Minor | Неверный текст правил username («1-20 characters» вместо 3-32 и regex) | `transport/errors.go:212` | ✅ |
| AUTH-08 | Minor | При `debug_mode:false` без SMTP молча выбирается `DebugSender`: «sent», но письма нет | `service/service.go:136` | ✅ |
| AUTH-09 | Minor | `ids.Generate` при сбое CSPRNG отдаёт предсказуемый fallback; им создаются bearer-токены | `internal/ids/ids.go:24,57-64` | ✅ |
| AUTH-10 | Minor | `allowed_emails` сравнивается без нормализации (в отличие от `admins`) | `service/auth.go:58` | ✅ |
| AUTH-11 | Minor | SMTP-диалог без read-дедлайна: `send-code` может висеть неограниченно | `email/smtp.go:44` | ✅ |
| AUTH-12 | Minor | Ошибка CSPRNG при выдаче setup-token проглатывается, клиент получает `isNew:true` без токена | `store/codes.go:73-81`, `service/auth.go:136` | ✅ |
| AUTH-13 | Minor | `/api/users/{id}/device-keys` отдаёт метаданные устройств любого аккаунта любому авторизованному | `transport/devices.go:152-169` | ✅ |

## 2. Backend: Admin / Users / Blocks

| ID | Sev | Проблема | Где | Статус |
|----|-----|----------|-----|--------|
| ADM-01 | Important | Disable `root_bot` админом ни на что не влияет: in-process путь не проверяет `is_active` | `service/bot_father.go:128`, `service/bots.go:548` | ✅ |
| ADM-02 | Important | Выключение бота админом обратимо владельцем; забаненный владелец со сохранённым токеном получает Bot API после включения | `service/admin.go:316`, `service/bots.go:613`, `store/bots.go:87` | ✅ |
| ADM-03 | Important | `isAdmin` утекает в `/users/search`, блокировки и федеративный поиск | `model/types.go:34-47`, `transport/users.go:77` | ✅ |
| ADM-04 | Important | `SearchUsers` без `LIMIT`: один запрос отдаёт весь каталог (LIKE без индекса) | `store/users.go:268-277` | ✅ |
| ADM-05 | Important | Админская модерация федеративных сообщений/чатов не уходит на пир | `service/admin.go:214,258` | ✅ |
| ADM-06 | Important | Удаление бот-чата оставляет `bot_chats` и ломает переписку с ботом навсегда | `service/admin.go:224`, `store/chats.go:561`, `store/bots.go:132` | ✅ |
| ADM-07 | Important | Нет аудита чтения чужих сообщений/чатов админом (аудит только мутаций) | `service/admin.go:241-255` | ⚠ |
| ADM-08 | Minor | `limit` в ответе админ-списков не равен фактическому (clamp 1..100) | `service/admin.go:128,196` | ✅ |
| ADM-09 | Minor | Поиск режет по `:` до trim и проверки длины: display name с `:` ломает поиск | `transport/users.go:66-77` | ✅ |
| ADM-10 | Minor | В федеративных результатах `nick` перезаписывается username | `transport/users.go:389-395` | ✅ |
| ADM-11 | Minor | Ответ федеративного поиска не валидируется: peer задаёт `id`, `isAdmin`, `avatarUrl` | `transport/users.go:372-395` | ✅ |
| ADM-12 | Minor | PATCH пользователя — две транзакции/два аудита; частичный сбой оставляет половину | `transport/admin.go:132-141` | ✅ |
| ADM-13 | Minor | Блокировки: цель не проверяется; фильтр fail-open при ошибке БД | `transport/blocks.go:51-57,94-122` | ✅ |
| ADM-14 | Minor | Unban не возвращает выключенных ботов владельца | `store/admin.go:132-141` | ✅ |

## 3. Backend: Messages / Reactions / Pins / Read statuses

| ID | Sev | Проблема | Где | Статус |
|----|-----|----------|-----|--------|
| MSG-01 | Critical | Клиент шлёт все закэшированные id в `missingIDs`; сервер режет >100 → 400. После ~100 сообщений пагинация мертва навсегда | `transport/messages.go:83`, `useMessages.ts:181` | ✅ |
| MSG-02 | Important | Семантика `missingIDs` инвертирована: статусы не запрашиваются для только что подгруженных страниц | `service/messages.go:363-376` | ✅ |
| MSG-03 | Important | Edit-ответ не содержит `files`/`reactions`; клиент делает полную замену строки и затирает их | `service/messages.go:707-715`, `messagesRepo.ts:75` | ✅ |
| MSG-04 | Important | Реакции не федераруются и не входят в дельту — офлайн-клиент теряет их навсегда | `service/reactions.go:52-66`, `service/sync.go:118` | ✅ |
| MSG-05 | Important | Повторная отправка с тем же id снова шлёт push и федеративный POST (флаг `created` не доходит) | `service/messages.go:534`, `transport/messages.go:479` | ✅ |
| MSG-06 | Important | Повторный приём федеративного сообщения снова рассылает SSE, форвардит и создаёт bot update | `store/messages.go:394`, `service/federation.go:345-396` | ✅ |
| MSG-07 | Important | Нет лимита на число разных эмодзи/реакций — амплификация на всех участников | `service/reactions.go:45`, `store/reactions.go:30` | ✅ |
| MSG-08 | Important | Курсор пагинации на удалённое сообщение молча завершает историю | `store/messages.go:592-596` | ✅ |
| MSG-09 | Important | `threads.message_count` не уменьшается при удалении и не растёт на федеративных сообщениях | `store/messages.go:318,445-482` | ✅ |
| MSG-10 | Important | Треды не федеративны: live-отправка не уходит, `thread_created` не рассылается, приём отбрасывает | `transport/messages.go:484`, `service/messages.go:850` | ✅ |
| MSG-11 | Minor | `DeleteRawMessage`/`deleteChatTx` не чистят реакции, пины, `bot_chats` | `store/messages.go:532-560`, `store/chats.go:561-589` | ✅ |
| MSG-12 | Minor | Любая ошибка store при удалении превращается в 403 (включая 404 и ошибку БД) | `service/messages.go:758` | ✅ |
| MSG-13 | Minor | `GET /pins` требует owner в группе, хотя пины видны всем участникам | `transport/pins.go:55,81` | ✅ |
| MSG-14 | Minor | Заблокированный может слать typing и ставить реакции | `service/typing.go:34-48`, `service/reactions.go:44-66` | ✅ |
| MSG-15 | Minor | Удалённый текст остаётся в снапшотах `replyTo` и `threads.parent_message_text` | `store/messages.go:275-281` | ✅ |

## 4. Backend: Chats / Membership / Sync

| ID | Sev | Проблема | Где | Статус |
|----|-----|----------|-----|--------|
| CHAT-01 | Critical | `withUserIsBot` из тела не сверяется с реальным ботом: приватный чат с человеком становится «бот-чатом» с plaintext | `service/chat.go:255-267`, `transport/chats.go:74` | ✅ |
| CHAT-02 | Critical | `ServerNow` снимается после всех выборок: записи, закоммиченные во время sync, теряются навсегда | `service/sync.go:134` | ✅ |
| CHAT-03 | Critical | Федеративное входящее сообщение не вызывает `ClearChatDeletes`: скрытый чат не возвращается и не синкается | `service/federation.go:373-401` vs `messages.go:563` | ✅ |
| CHAT-04 | Important | `GetUserChats` глотает ошибки БД: успешный sync с пустым списком и ушедшим курсором | `store/chats.go:665-722` | ✅ |
| CHAT-05 | Important | `NextSince` в `RFC3339` без наносекунд: >limit строк в одну секунду — keyset не двигается | `service/sync.go:159-176` | ✅ |
| CHAT-06 | Important | Изменения состава на реплике федеративной группы не доезжают до владельца (leave/локальный add) | `service/chat.go:478-491,522-538` | ✅ |
| CHAT-07 | Important | `notifyMessageSent` чистит tombstone по устаревшему снимку участников и может стереть свежий tombstone исключённого | `service/messages.go:567` | ✅ |
| CHAT-08 | Minor | `RemoveChatMember` игнорирует ошибку `GetChat` и разыменовывает nil `before` — паника | `service/chat.go:499,522` | ✅ |
| CHAT-09 | Minor | `AddChatMember` не репликует состав пирам, если добавлен локальный участник | `service/chat.go:478-491` | ✅ |
| CHAT-10 | Minor | `AddChatMember` обходит проверку блокировки, которая есть в `CreateGroupChat` | `service/chat.go:446-462` | ✅ |
| CHAT-11 | Minor | No-op добавление/удаление участника отвечает 200 и рассылает события | `store/chats.go:258,328`, `service/chat.go:460-520` | ✅ |
| CHAT-12 | Minor | `deleteChatTx` не чистит `chat_pins`/`message_reactions`/`bot_chats`; у «Избранного» детерминированный id возвращает старые пины | `store/chats.go:561-589` | ✅ |
| CHAT-13 | Minor | Окно между tombstone'ами и списком чатов: ответ содержит и tombstone, и вернувшийся чат | `service/sync.go:82-91`, `deltaApplier.ts:30-36` | ✅ |
| CHAT-14 | Minor | Повторное открытие приватного чата одной стороной снимает tombstone у второй, даже без сообщения | `service/chat.go:251` | ✅ |
| CHAT-15 | Minor | Длина названия группы считается в байтах, UI — в символах | `service/chat.go:21,283,352` | ✅ |

## 5. Backend: Bots / Bot API / Root bot

| ID | Sev | Проблема | Где | Статус |
|----|-----|----------|-----|--------|
| BOT-01 | Important | Подтверждённые апдейты не удаляются: рестарт бота переигрывает до 7 дней сообщений и callback'ов (SDK стартует с `offset=0`) | `store/bots.go:145-152`, SDK `initialOffset=0` | ✅ |
| BOT-02 | Important | `OpenBotChat` не транзакционен, `CreateBotChat` — `DoNothing`: чат с ботом может стать мёртвым навсегда | `service/bots.go:163-181`, `store/bots.go:132` | ✅ |
| BOT-03 | Important | Создание бота не атомарно: осиротевший `_bot`-пользователь навсегда занимает имя | `service/bots.go:118-129` | ✅ |
| BOT-04 | Important | Блокировка бота не останавливает его сообщения/typing/push | `service/bots.go:298,370-396` | ✅ |
| BOT-05 | Important | Смена E2EE-режима бота не федераруется: сообщения удалённых пользователей теряются | `service/bots.go:219-238` | ✅ |
| BOT-06 | Important | `sendFile`/`sendMessage` молча выбрасывают чужие файлы и отвечают 201 | `service/bots.go:348-357` | ✅ |
| BOT-07 | Important | Bot API: нет раннего лимита `files[]` — десятки тысяч SQL-запросов из одного тела | `transport/bots.go:279-284` | ✅ |
| BOT-08 | Minor | Сообщение бота не снимает tombstone `deleted_chats`: чат скрыт, push пришёл | `service/bots.go:388` | ✅ |
| BOT-09 | Minor | Бота можно добавить в группу: писать не может, но скачивает любые вложения группы | `service/chat.go:446`, `transport/bots.go:162` | ✅ |
| BOT-10 | Minor | `ParseBotUsername` не применяет общие правила username — возможны `pay__bot` рядом с `pay_bot` | `service/bots.go:49`, `username.go:17` | ✅ |
| BOT-11 | Minor | Нет квоты на число ботов; `DeleteBot` не вызывается, имена не освобождаются | `service/bots.go:89`, `store/bots.go:99` | ✅ (квота 20; API удаления нет) |
| BOT-12 | Minor | Токен root-бота уходит в текст сообщения и в push-превью | `service/bot_father.go:181`, `service/push.go:184` | ✅ |
| BOT-13 | Minor | Чистка `bot_updates` запускается только из `getUpdates`: очереди root/федеративных/отключённых не истекают | `service/bots.go:195` | ✅ |
| BOT-14 | Minor | Повторный `answerCallbackQuery` → 500 вместо идемпотентного ok/4xx | `service/bots.go:584`, `store/bots.go:175` | ✅ |
| BOT-15 | Minor | `button.URL` в inline-клавиатуре без лимита длины | `service/bots.go:458-473` | ✅ |
| BOT-16 | Minor | Display name бота без лимита (у людей 64 руны) | `service/bots.go:106` | ✅ |
| BOT-17 | Minor | Бота нельзя удалить: `/delete` обещан, `DeleteBot` — мёртвый код | `service/bot_father_commands.go:18-20`, `store/bots.go:99-112` | ✅ |
| BOT-18 | Minor | Токен пишется в историю сообщений, хотя подписан «shown once» | `service/bot_father_commands.go:52-59` | ✅ |

## 6. Backend: Federation

| ID | Sev | Проблема | Где | Статус |
|----|-----|----------|-----|--------|
| FED-01 | Critical | Catch-up не покрывает группы, которыми владеем мы: `remote_server = peer` вместо членства; потеря сообщений/renames/tombstone'ов невосстановима | `store/chats.go:754`, `service/federation.go:649` | ✅ |
| FED-02 | Critical | Правки/удаления/typing в федеративных группах не доходят до третьих серверов | `transport/messages.go:171,384,584`, `service/federation.go:503,564,593` | ✅ |
| FED-03 | Important | Lifecycle групп и релей сообщений идут мимо durable-outbox, на контексте входящего запроса | `service/federation.go:830-850`, `service/chat.go:340-402` | ✅ |
| FED-04 | Important | `federatedChatForPeerAction` подменяет `RemoteServer` на пира, из-за чего relay-гарды отключаются | `transport/federated.go:402-411` | ✅ |
| FED-05 | Important | Catch-up двигает курсор даже при неудачном применении дельты — сообщение теряется навсегда | `service/federation_catchup.go:95-130` | ✅ |
| FED-06 | Important | Catch-up теряет исходное `CreatedAt` федеративного сообщения (ставит `now`), ломая хронологию и TTL | `service/federation.go:329` | ✅ |
| FED-07 | Important | Проверка автора в federated edit/delete отвергает сообщения, пересланные третьим сервером | `service/federation.go:426,545` | ✅ |
| FED-08 | Important | Кэши публичных ключей и негативного кэша растут без вытеснения; заполняются до проверки подписи | `federation/federation.go:415-455` | ✅ |
| FED-09 | Important | Состав private-чата принимается от пира без валидации типа/размера | `service/federation_catchup.go:295-320` | ✅ |
| FED-10 | Minor | Outbox без аренды операций: несколько инстансов дублируют доставку и ломают порядок | `store/federation.go:53` | ✅ |
| FED-11 | Minor | Подписанные запросы ходят по редиректам, унося заголовки подписи | `federation/client.go:216` | ✅ |
| FED-12 | Minor | Постановка в outbox использует контекст входящего запроса: операция теряется при обрыве | `federation/outbox.go:102` | ✅ |
| FED-13 | Minor | На федеративном приёме нет `MaxMessageFiles` — амплификация строк из одного тела | `service/federation.go:349` | ✅ |
| FED-14 | Minor | Курсор catch-up доверяет `ServerNow` пира и не откатывается назад | `service/federation_catchup.go:110,130` | ✅ |
| FED-15 | Minor | Повтор сообщения с существующим id: 201, фантомный SSE и перезапись вложений | `service/federation.go:345-381` | ✅ |
| FED-16 | Minor | `ErrFileConflict` отдаётся как 500 и блокирует очередь пира на часы | `service/federation.go:345-374` | ✅ |
| FED-17 | Minor | Federated edit не сверяет thread сообщения с thread из URL | `transport/federated.go:435-440` | ✅ |
| FED-18 | Minor | Блокировка одного участника глушит автора во всей группе | `service/federation.go:310-314` | ✅ |
| FED-19 | Minor | `CreateFederatedGroup`/`ensureRemoteChat` не валидируют type/name/состав | `service/federation.go:756-797` | ✅ |

## 7. Backend: Files / SSE / Calls / Push

| ID | Sev | Проблема | Где | Статус |
|----|-----|----------|-----|--------|
| MED-01 | Important | Федеративное вложение >10 МиБ не скачивается (502) и читается целиком в память | `transport/files.go:80`, `federation/client.go:28,233` | ✅ |
| MED-02 | Important | `SendIce` в локальной ветке не проверяет размер кандидата (до 1 МБ в SSE-буферы) | `service/calls.go:229-248` | ✅ |
| MED-03 | Important | Нет GC/квоты файлов: байты и записи `File` не удаляются никогда | `store/messages.go:447`, `store/chats.go:660` | ✅ |
| MED-04 | Important | Битый/нечитаемый `vapid_keys.json` молча перегенерирует VAPID-пару — все push-подписки умирают | `push/push.go:196-215` | ✅ |
| MED-05 | Important | Нет квоты SSE на пользователя/IP: один аккаунт открывает ~1024 потока и гасит реалтайм всем | `transport/transport.go:357-360,436-441`, `sse/hub.go:15-19` | ✅ |
| MED-06 | Important | Превышение SDP/ICE-лимитов возвращает 500: sentinel'ы не замаплены | `transport/errors.go:417-454` | ✅ |
| MED-07 | Minor | Для E2EE-вложений на сервере хранится SHA-256 плейнтекста | `internal/filestage/filestage.go:218` | ⚠ |
| MED-08 | Minor | `encrypted`/`hash` читаются через `FormValue` и подменяются query-строкой | `internal/filestage/filestage.go:61` | ✅ |
| MED-09 | Minor | Индексы хаба не чистятся при перерегистрации/перепривязке — закрывается чужой стрим | `sse/hub.go:107-119` | ✅ |
| MED-10 | Minor | `Hub.Send` молча дропает событие при полном буфере, включая `call_incoming` | `sse/hub.go:358` | ✅ |
| MED-11 | Minor | Отказ пира 403/422 на федеративный invite превращается в 500 | `service/calls_federated.go:55` | ✅ |
| MED-12 | Minor | Синхронный федеративный HTTP в запросе звонка и до drain-бюджета при shutdown | `service/calls.go:352` | ⚠ |
| MED-13 | Minor | Push-endpoint (capability URL) логируется в `main.go` открытым текстом | `main.go:487` | ✅ |
| MED-14 | Minor | Любая ошибка `ParseMultipartForm` отдаётся как 413 | `transport/files.go:167` | ✅ |

## 8. Backend: main / config / transport core / model

| ID | Sev | Проблема | Где | Статус |
|----|-----|----------|-----|--------|
| INF-01 | Important | `ReadTimeout: 30s` обрывает загрузки до 50 МБ на медленном канале; ошибка маскируется под 413 «file too large» | `main.go:599`, `filestage.go:34` | ✅ |
| INF-02 | Important | SPA-fallback перехватывает `/openapi.json` — `/docs` получает HTML | `main.go:920-925`, `transport/docs.go:32` | ✅ |
| INF-03 | Important | Пустой `trusted_proxies` схлопывает все лимиты в один общий и ломает HSTS | `config/config.go:89`, `ratelimit.go:89` | ✅ |
| INF-04 | Important | YAML парсится без `KnownFields`: опечатки в security-ключах игнорируются | `config/config.go:470` | ✅ |
| INF-05 | Important | При исчерпанном drain-бюджете `store.Close()` выполняется под работающими воркерами | `main.go:816-856` | ✅ |
| INF-06 | Important | `MkdirAll` не исправляет права существующего каталога; файл SQLite создаётся 0644 — локальные пользователи читают БД | `main.go:442-454` | ✅ |
| INF-07 | Minor | Дублирование заголовков в `fallbackBuffer.decide()` (`Add` вместо `Set`) | `transport/transport.go:296-300` | ✅ |
| INF-08 | Minor | Нет panic-recovery: обрыв соединения и стек без `request_id` | `main.go:585-602` | ✅ |
| INF-09 | Minor | `static_dir` не резолвится от каталога конфига; HEAD на статику → 404 | `config/config.go:657`, `main.go:909` | ✅ |
| INF-10 | Minor | Явный `message_*_ttl: 0` молча превращается в 300 с | `config/config.go:539-545` | ✅ |
| INF-11 | Minor | `cors.origin: "*"` проходит валидацию без предупреждения | `config/config.go:694` | ✅ |
| INF-12 | Minor | Неизвестные маршруты и 405 под `/api` отдают plaintext 404, 405 теряется | `transport/transport.go:64-65,195-213` | ✅ |
| INF-13 | Minor | 429 от лимитеров — `text/plain` без `Retry-After` и вне JSON-контракта | `main.go:190`, `transport/transport.go:142,164` | ✅ |
| INF-14 | Minor | `federation.key_path` без дефолта и валидации: пустое значение убивает старт невнятной ошибкой | `config/config.go:111` | ✅ |
| INF-15 | Minor | `X-Forwarded-Proto` берётся слева (клиентский), `X-Forwarded-For` — справа | `main.go:177-182` | ✅ |

## 9. Frontend: E2EE

| ID | Sev | Проблема | Где | Статус |
|----|-----|----------|-----|--------|
| E2E-01 | Critical | Нет аутентификации отправителя: анонимные sealed-конверты, `fromId` из серверной записи. Сервер может подделать сообщение от любого имени | `e2ee/crypto.ts:55`, `message.ts:237` | ✅ |
| E2E-02 | Important | Нет AAD: `chatId`/`messageId`/`fromId`/`createdAt` не аутентифицированы — перенос шифртекста в другой чат/тред и реплей | `e2ee/crypto.ts:131`, `message.ts:293` | ✅ |
| E2E-03 | Important | Имя зашифрованного файла уходит на сервер открытым текстом (multipart filename) | `chat-encrypt.ts:206`, `outboxProcessor.ts:343` | ✅ |
| E2E-04 | Important | Восстановление ключа пишет в БД/скоуп, активные после `await`: при смене аккаунта ключ A попадает в B | `keys.ts:263-304` | ✅ |
| E2E-05 | Important | Отправка не проверяет собственный конверт; отзыв ключа текущего устройства не сбрасывает кэш регистрации | `chat-encrypt.ts:52-97`, `keys.ts:111-118` | ✅ |
| E2E-06 | Critical | Отозванный device-ключ «разотзывается» при повторной регистрации (`revoked_at` пишется NULL) | `backend/store/devices.go:16-25` | ✅ |
| E2E-07 | Important | `file.hash = "__proto__"` обходит фильтр аутентификации вложений | `e2ee/message.ts:190,299` | ✅ |
| E2E-08 | Important | Restore device-бэкапа перезаписывает локальную пару и вешает чужой ключ на текущую сессию | `keys.ts:291-304` | ✅ |
| E2E-09 | Important | Проверка «есть другие активные устройства» не подключена — multi-device модалка недостижима | `keys.ts:164` | ✅ |
| E2E-10 | Minor | Fail-open: `encrypted:true` без payload показывает base64-шифртекст как текст | `e2ee/message.ts:129` | ✅ |
| E2E-11 | Minor | Версия протокола игнорируется; v1/v2 различаются эвристикой «распарсился ли JSON» | `crypto.ts:116`, `message.ts:159` | ✅ |
| E2E-12 | Minor | Дубликат вложения в одной отправке роняет всю отправку без понятного уведомления | `chat-encrypt.ts:160` | ✅ |
| E2E-13 | Minor | PBKDF2 310k (ниже актуальной рекомендации), пароль только «≥8 символов» | `backup.ts:8`, `BackupSettingsModal.tsx:59` | ✅ |
| E2E-14 | Minor | «Нет бэкапа» определяется по подстроке в тексте ошибки; `unknown` блокирует генерацию ключа | `keys.ts:152-161` | ✅ |
| E2E-15 | Minor | Флаг «ключ загружен» навсегда отключает самовосстановление публичного ключа на сервере | `keys.ts:96-97` | ✅ |
| E2E-16 | Minor | Сбой запроса device-keys молча деградирует до аккаунт-ключа — часть устройств не прочитает сообщение | `keys.ts:488` | ✅ |
| E2E-17 | Minor | `keyVersion` вычисляется и кешируется, но никогда не сравнивается | `keys.ts:450` | ✅ |
| E2E-18 | Minor | `clearServerKeyBackup` игнорирует `deviceID`; `discardRecoveryAndGenerate` не чистит блоб устройства | `keys.ts:278,317` | ✅ |

## 10. Frontend: Sync / Outbox / Service Worker / Media

| ID | Sev | Проблема | Где | Статус |
|----|-----|----------|-----|--------|
| SYN-01 | Critical | Курсор пишется после каждой страницы (`serverNow`), хотя есть `nextSince`: обрыв на странице ≥2 теряет остаток бэклога навсегда | `deltaApplier.ts:54`, `syncEngine.ts:280-292` | ✅ |
| SYN-02 | Important | `processOutbox` возвращает `false`, но движок это игнорирует — сообщение висит в queued без ретрая | `syncEngine.ts:253`, `outboxProcessor.ts:44-53` | ✅ |
| SYN-03 | Important | Изменения реакций/read-статусов не входят в дельту — офлайн-клиент не увидит их | `service/sync.go:118`, `store/reactions.go:13-26` | ✅ |
| SYN-04 | Important | `delay(Retry-After)` до 5 минут выполняется внутри Web Lock: вкладки висят в «syncing», сон не прерывается logout | `outboxProcessor.ts:48-52` | ✅ |
| SYN-05 | Important | `skipWaiting()` + чистка runtime-кэша ломает открытую старую вкладку после деплоя (старые чанки удалены) | `sw.ts:49-60,124` | ✅ |
| SYN-06 | Important | `backgroundOutbox` мутирует глобальный `activeAccountKey` без лока: запись в чужую (pre-account) БД | `backgroundOutbox.ts:30-47` | ✅ |
| SYN-07 | Important | `useDecryptedFileUrl` не сбрасывает URL при смене файла, а cleanup уже отозвал его — битый lightbox без лоадера | `useDecryptedFileUrl.ts:56-61,139-142` | ✅ |
| SYN-08 | Important | Смена аккаунта во время `applyDelta` пишет данные A в БД B: проверка только до `await` | `syncEngine.ts:279-281`, `deltaApplier.ts:18-55` | ✅ |
| SYN-09 | Important | `tokenProvider` не сбрасывается при logout: вышедший аккаунт досинхронизируется в общую pre-account БД | `useChatInteraction.ts:53-55` | ✅ |
| SYN-10 | Important | Устаревшая страница дельты затирает более новое SSE-состояние: в DTO нет `updatedAt`, upsert полный | `messagesRepo.ts:131-139`, `model/types.go:188` | ✅ |
| SYN-11 | Important | Клик по push ищет ровно `pathname === "/chat"`; канонические пути `/chat/*`, `/group/*` — фокус не работает | `sw.ts:169-172` | ✅ |
| SYN-12 | Minor | Токен в зависимостях перезапускает всё медиа: MSE с нуля, повторная загрузка, обрыв плеера | `useMediaUrl.ts:246` | ✅ |
| SYN-13 | Minor | Неудачная загрузка кэшируется как rejected promise — после возврата сети файл сам не перезагрузится | `utils/fileCache.ts:52-65` | ✅ |
| SYN-14 | Minor | Не-HTTP ошибки (квота IDB, DataError) считаются сетевыми → бесконечный тихий ретрай | `syncEngine.ts:191-206` | ✅ |
| SYN-15 | Minor | `useMediaUrl` не проверяет `resp.ok`: тело 401/404 уходит в плеер как «медиа» | `useMediaUrl.ts:115-119` | ✅ |
| SYN-16 | Minor | `CLEAR_SW_CACHES` фильтрует несуществующие имена кэшей — очистка из SW no-op | `sw.ts:113-118` | ✅ |
| SYN-17 | Minor | `useDecryptedFileUrl` всегда качает шифртекст, даже когда плейнтекст уже в кэше | `useDecryptedFileUrl.ts:41-45` | ✅ |
| SYN-18 | Minor | Один `cancelledRef` на все запуски `useMediaUrl`: поздний результат прошлого запуска считается актуальным | `useMediaUrl.ts:49-55` | ✅ |
| SYN-19 | Minor | Транзиентный сбой outbox игнорируется, и та же дельта откатывает оптимистичный pin | `syncEngine.ts:253`, `deltaApplier.ts:34-36` | ✅ |

## 11. Frontend: IndexedDB / Repositories

| ID | Sev | Проблема | Где | Статус |
|----|-----|----------|-----|--------|
| DB-01 | Important | Нет `blocked`/`blocking`/`terminated`; reject открытия кэшируется навсегда — приложение может навсегда повиснуть на пустом списке | `db/init.ts:40,103-111` | ✅ |
| DB-02 | Important | Каскад удаления чата — 5+ транзакций, строка чата удаляется первой: обрыв оставляет сообщения/outbox | `chatsRepo.ts:52-68` | ✅ |
| DB-03 | Important | `clearAllData` не останавливает sync и не сбрасывает активный аккаунт: БД удаляется и тут же наполняется заново | `clearAllData.ts:84-103`, `init.ts:144-181` | ✅ |
| DB-04 | Important | `get()` в кэшах пишет в БД: клонирует до 100 МБ и ломает чтение при ошибке записи | `fileCacheRepo.ts:28-35`, `decryptedFilesRepo.ts:27-33` | ✅ |
| DB-05 | Important | Эвикция читает весь стор (`getAll`) на каждый `put` — материализация 100–200 МБ | `decryptedFilesRepo.ts:71-96` | ✅ |
| DB-06 | Important | «Сохранить офлайн» для файла больше лимита сразу удаляет собственную запись, UI рапортует успех | `fileCacheRepo.ts:44-57,80-85` | ✅ |
| DB-07 | Important | `useLiveQuery` не отсекает устаревший результат — данные прошлого аккаунта после switch | `useLiveQuery.ts:28-42` | ✅ |
| DB-08 | Important | `clearAllData` не удаляет БД других аккаунтов там, где нет `indexedDB.databases()` | `init.ts:158-180` | ✅ |
| DB-09 | Important | Запись в файловый кэш не привязана к аккаунту, начавшему загрузку | `fileCacheRepo.ts:38-57`, `utils/fileCache.ts:183` | ✅ |
| DB-10 | Minor | Presence: `getAll("chats")` и запись на каждого пользователя из `onlineStatus` | `chatsRepo.ts:70-87` | ✅ |
| DB-11 | Minor | `upsertMany` по умолчанию ставит `sent` и снимает optimistic `queued`/`failed` | `messagesRepo.ts:104-145` | ✅ |
| DB-12 | Minor | `useLiveQuery` на монтировании делает лишнее чтение и оставляет необработанный reject | `useLiveQuery.ts:10-21` | ✅ |

## 12. Frontend: API client / Auth / SSE / Calls

| ID | Sev | Проблема | Где | Статус |
|----|-----|----------|-----|--------|
| API-01 | Critical | Любой 401 или сбой refresh удаляет аккаунт вместе с IndexedDB и приватным E2EE-ключом | `useAuth.tsx:233,478-492`, `useChatInteraction.ts:79-92` | ✅ |
| API-02 | Critical | Клиент не подписан на `message_reactions_updated`, `chat_pinned`, `thread_message_updated` — живые реакции/пины/правки в тредах не доходят | `useSse.ts:111-134` | ✅ |
| API-03 | Important | `sse-auth` 401 не эмитит `unauthorized`; `connected` сбрасывает backoff — бесконечный реконнект мёртвой сессии | `api.ts:184-189`, `useSse.ts:152-203` | ✅ |
| API-04 | Important | После reconnect нет догоняющего sync — события за окно разрыва теряются | `useSseEvents.ts:323`, `useSse.ts:152` | ✅ |
| API-05 | Important | `updateAccountUser` перезаписывает user целиком — теряются `isAdmin`/`isBot` | `useAuth.tsx:439-445` | ✅ |
| API-06 | Important | `hangup` ждёт HTTP без таймаута и только потом отпускает микрофон/камеру | `calls/callManager.ts:179-187` | ✅ |
| API-07 | Minor | Чтения storage защищены `try/catch`, записи — нет: при заблокированном storage логин/switch падают | `useAuth.tsx:121-171` | ✅ |
| API-08 | Minor | Панель исходящего звонка показывает пустое имя собеседника до ответа сервера | `callManager.ts:412-414` | ✅ |
| API-09 | Minor | `/calls/current` не отдаёт `chatId`/`iceServers`; восстановленный федеративный звонок теряет TURN и чат | `useCall.ts:141-166`, `transport/calls.go:213-226` | ✅ |
| API-10 | Minor | Фантомное «звонок завершён» в вкладках, которые в звонке не участвовали | `callManager.ts:254-267` | ✅ |
| API-11 | Minor | `pushsubscriptionchange` не обработан: после ротации endpoint push тихо умирает | `sw.ts:126-147` | ✅ |
| API-12 | Minor | `CallStore` не освобождается при смене аккаунта — утечка подписки/менеджера | `useCall.ts:245-248` | ✅ |
| API-13 | Minor | Нет контроля живости SSE: heartbeat-комментарии невидимы JS, полуоткрытый поток не детектируется | `useSse.ts:205-222` | ✅ |

## 13. Frontend: Hooks — sending / interaction / threads

| ID | Sev | Проблема | Где | Статус |
|----|-----|----------|-----|--------|
| HK-01 | Critical | Состояние композера не привязано к чату/аккаунту: вложения, локация, reply и edit «переезжают» в другой чат | `useChatInteraction.ts:393`, `useChatSubmit.ts:219-243` | ✅ |
| HK-02 | Critical | Режим правки не заполняет композер: `editingMessage.text` нигде не читается; Save недоступен или затирает текст черновиком | `useMessageEditor.ts:49-58`, `useChatSubmit.ts:169-196` | ✅ |
| HK-03 | Important | `activeThreadId` не сбрасывается при смене чата: отправка уходит в тред прошлого чата и теряется | `useThreads.ts:167`, `useChatSubmit.ts:236` | ✅ |
| HK-04 | Important | Удаление queued-сообщения не отменяет send-op: оно сначала уходит получателям, потом удаляется | `useMessageSender.ts:493-517` | ✅ |
| HK-05 | Important | Сообщения треда теряют `status`: failed/queued выглядят отправленными, retry/cancel недоступны | `useThreads.ts:79-86` | ✅ |
| HK-06 | Important | `filesToRemove` нигде не передаётся — удаление существующего вложения при правке не работает | `useChatSubmit.ts:179-187` | ✅ |
| HK-07 | Important | Ошибки всех мутаций группы проглатываются: rename/delete/leave/add/remove/создание без уведомления | `useGroupSettings.ts:100-165` | ✅ |
| HK-08 | Minor | Правку нельзя сохранить с пустым текстом, даже если у сообщения есть вложения/локация | `useChatSubmit.ts:169-170` | ✅ |
| HK-09 | Minor | «Ответить» на сообщение внутри треда — no-op | `useMessageEditor.ts:79-89` | ✅ |
| HK-10 | Minor | Очистка поиска не отменяет отложенный запрос — дропдаун открывается для пустого поля | `useMessageSearch.ts:38-46` | ✅ |
| HK-11 | Minor | Очередь read-квитанций не привязана к чату; после ошибки не перепланируется | `useMessageReadStatuses.ts:26-102` | ✅ |
| HK-12 | Minor | Локальный поиск в произвольном порядке и без сообщений тредов | `useLocalMessageSearch.ts:36-57` | ✅ |
| HK-13 | Minor | Вложение, добавленное во время отправки, теряется, его blob URL утекает | `usePendingFiles.ts:65-97` | ✅ |

## 14. Frontend: ChatPage / ChatList / MessageList / Bubbles

| ID | Sev | Проблема | Где | Статус |
|----|-----|----------|-----|--------|
| UI-01 | Important | Меню действий сообщения недоступно на touch: только `onContextMenu`, long-press нет | `MessageBubble.tsx:462-466` | ✅ |
| UI-02 | Important | `MessageList` без `key` по чату: Virtuoso переиспользуется, остаются скролл и окно прошлого чата | `ChatPage.tsx:617-620` | ✅ |
| UI-03 | Important | Переход к сообщению по цитате/из поиска не работает: `scrollToMessageId` нигде не передаётся, скролл только в видимом диапазоне | `MessageList.tsx:161-187`, `ChatPage.tsx:944` | ✅ |
| UI-04 | Important | В треде группового чата не показываются авторы сообщений | `ThreadView.tsx:114-132` | ✅ |
| UI-05 | Minor | Ложные отметки «прочитано»: диапазон прошлого чата и special-case `{0,0}` | `MessageList.tsx:351-388` | ✅ |
| UI-06 | Minor | Ошибки закрепления/загрузки закреплённых не обрабатываются — модалка показывает «пусто» | `ChatPage.tsx:454-499` | ✅ |
| UI-07 | Minor | Ошибка скачивания вложения не сообщается; blob ревокается сразу после клика | `FileDownloadAttachment.tsx:32-43` | ✅ |
| UI-08 | Minor | «Копировать» падает без feedback при отсутствии Clipboard API (HTTP) | `MessageBubbleMenu.tsx:100-103` | ✅ |
| UI-09 | Minor | Глобальный keydown поиска перехватывает стрелки/Enter вне поля | `SearchBox.tsx:46-77` | ✅ |
| UI-10 | Minor | В группе после разделителя даты не повторяется автор | `MessageList.tsx:122-144` | ✅ |
| UI-11 | Minor | `//host` и `/\host` считаются внутренними ссылками | `MessageBody.tsx:30-36` | ✅ |
| UI-12 | Minor | Мини-карта грузит тайлы OSM при рендере — координаты уходят третьей стороне без действия | `LocationMiniMapLeaflet.tsx:36` | ⚠ |
| UI-13 | Minor | После закрытия контекстного меню теряется клавиатурный фокус | `MessageBubble.tsx:445-485` | ✅ |
| UI-14 | Minor | Закрепления в E2EE-чатах показывают заглушку вместо текста | `PinnedMessagesModal.tsx:23-29` | ✅ |
| UI-15 | Minor | Офлайн-реакция в треде пишется в `messagesRepo` вместо `threadMessagesRepo` | `ThreadView.tsx`, `ReactionBar.tsx:91-99` | ✅ |

## 15. Frontend: Composer / Attachments / Voice / Location

| ID | Sev | Проблема | Где | Статус |
|----|-----|----------|-----|--------|
| CMP-01 | Important | Дубликат содержимого в одной отправке тихо отменяет отправку | `chat-encrypt.ts:161`, `useChatSubmit.ts:239-241` | ✅ |
| CMP-02 | Important | Последняя геолокация из кэша подставляется как текущая позиция и переживает смену аккаунта | `LocationPickerModal.tsx:104-109` | ✅ |
| CMP-03 | Minor | Поздний ответ геолокации перебивает ручную позицию; пустая координата → 0; таймаут выдаётся за отказ | `LocationPickerModal.tsx:111-150` | ✅ |
| CMP-04 | Minor | После `MediaRecorder.onerror` остаётся `onstop` — может прикрепиться обрезанная запись | `VoiceRecorderButton.tsx:215-253` | ✅ |
| CMP-05 | Minor | Blob-URL аудио ревокается при размонтировании пузыря, а трек живёт в глобальном плеере | `AudioAttachment.tsx:56-58` | ✅ |
| CMP-06 | Minor | Превью существующего E2EE-фото в режиме правки показывает шифртекст | `ExistingFilePreview.tsx:20-23` | ✅ |
| CMP-07 | Minor | `CodeBlock` падает синхронно без `navigator.clipboard` | `CodeBlock.tsx:59-69` | ✅ |
| CMP-08 | Minor | Неудачная пересылка закрывает модалку молча | `ChatPage.tsx:707-708` | ✅ |
| CMP-09 | Minor | Нет валидации размера/типа при выборе файла; `onLargeFile` не подключён (500 MiB vs 50 MiB) | `useChatInteraction.ts:393` | ✅ |
| CMP-10 | Minor | «Сохранить офлайн» у видео: необработанный reject и молчаливый провал | `VideoAttachment.tsx:86-91` | ✅ |
| CMP-11 | Minor | Вставка из буфера даёт мусорное расширение и теряет имя файла | `InputBar.tsx:80` | ✅ |
| CMP-12 | Minor | Waveform декодирует аудио целиком на каждое вложение, кэш не ограничен | `useAudioWaveform.ts:11` | ✅ |
| CMP-13 | Minor | Кнопка «Отправить» при записи только останавливает запись и прикрепляет файл | `VoiceRecorderButton.tsx:342` | ✅ |
| CMP-14 | Minor | `ForwardModal` возвращает приставку `@` к display name | `ForwardModal.tsx:59` | ✅ |
| CMP-15 | Minor | На мобильной клавиатуре Return отправляет вместо перевода строки | `InputBar.tsx:476` | ✅ |

## 16. Frontend: Modals / Settings / Admin UI

| ID | Sev | Проблема | Где | Статус |
|----|-----|----------|-----|--------|
| MOD-01 | Important | Гонка `openGroupSettings`: в модалке данные A, а rename/add/remove/delete бьют по B | `useGroupSettings.ts:67-83` | ✅ |
| MOD-02 | Important | Деструктивные действия в «Устройствах» без подтверждения; revoke key обнуляет `key_backup` устройства | `SessionsModal.tsx:222-272`, `store/devices.go:37-42` | ✅ |
| MOD-03 | Important | «Удалить бэкап» и отказ от восстановления не удаляют per-device блобы других сессий — старый ключ продолжает восстанавливаться | `BackupSettingsModal.tsx:78-90`, `keys.ts:278-320` | ✅ |
| MOD-04 | Important | Выдача/снятие админ-роли одним кликом без подтверждения | `admin/UsersTab.tsx:150-161` | ✅ |
| MOD-05 | Important | «New token» у бота мгновенно инвалидирует рабочий токен без предупреждения | `BotsModal.tsx:79-91` | ✅ |
| MOD-06 | Important | Владелец исключает участника одним кликом без подтверждения | `GroupMembersList.tsx:62-71` | ✅ |
| MOD-07 | Minor | Пароль бэкапа остаётся в форме после закрытия/повторного открытия | `BackupSettingsModal.tsx:41-57` | ✅ |
| MOD-08 | Minor | Токен бота показывается повторно, хотя UI обещает «shown once» | `BotsModal.tsx:32-56` | ✅ |
| MOD-09 | Minor | Удаление серверного бэкапа без подтверждения | `BackupSettingsModal.tsx:142-154` | ✅ |
| MOD-10 | Minor | Кнопка подтверждения удаления/выхода из группы подписана «Save» | `GroupSettingsModal.tsx:170-177` | ✅ |
| MOD-11 | Minor | `BlockedUsersModal`: ошибки не обрабатываются, пустой список врёт | `BlockedUsersModal.tsx:20-45` | ✅ |
| MOD-12 | Minor | В админке боту предлагают «Make admin» (сервер всегда 400); снятие админа без подтверждения | `admin/UsersTab.tsx:150-179` | ✅ |
| MOD-13 | Minor | Доступ к админке завязан на `isAdmin` из логина, который никогда не обновляется | `useAuth.tsx:37-45`, `AdminPage.tsx:32` | ✅ |
| MOD-14 | Minor | `BotsTab`: «залипший» Alert об ошибке, disable без подтверждения | `admin/BotsTab.tsx:27-92` | ✅ |
| MOD-15 | Minor | Доступность: безымянные иконки удаления, неверный `aria-label`, модалка звонка без title | `GroupMembersList.tsx:63`, `CreateGroupModal.tsx:188`, `IncomingCallOverlay.tsx:28` | ✅ |
| MOD-16 | Minor | Отклонённый звонок не показывает вызывающему ничего | `EndedCallNotice.tsx:26-42` | ✅ |
| MOD-17 | Minor | LoginPage: после отправки кода нельзя исправить e-mail или запросить код заново | `LoginPage.tsx:179-211` | ✅ |
| MOD-18 | Minor | Админ-таблицы без empty-state | `admin/UsersTab.tsx`, `ChatsTab.tsx`, `BotsTab.tsx` | ✅ |

## 17. SDK / Integrations

| ID | Sev | Проблема | Где | Статус |
|----|-----|----------|-----|--------|
| SDK-01 | Important | Hermes SSRF-проверка обходится DNS rebinding (TOCTOU между проверкой и загрузкой) | `integrations/hermes-fastchat/adapter.py:228` | ✅ |
| SDK-02 | Important | `getMe()` не обновляет `modeCheckedAt`: режим перезапрашивается перед каждой отправкой | `sdk/typescript/src/index.ts:214-244` | ✅ |
| SDK-03 | Important | Каждое входящее E2EE-сообщение делает `getMe()`, а сбой `getMe` маскируется под `undecryptable` | `sdk/typescript/src/index.ts:701-748` | ✅ |
| SDK-04 | Important | Hermes: `continue` при ошибке диспетчеризации сдвигает offset и теряет сообщение | `integrations/hermes-fastchat/adapter.py:355-370` | ✅ |
| SDK-05 | Minor | Callback data не аутентифицирована (sealed box на публичный ключ бота) — бот должен проверять действия сам | `sdk/typescript/src/crypto.ts:161` | ⚠ |
| SDK-06 | Minor | `downloadFile(maxBytes)` проверяет размер после полной загрузки в память | `sdk/typescript/src/index.ts:477-486` | ✅ |
| SDK-07 | Minor | `answerCallbackQuery` выбирает шифрование по наличию ключа, а не по режиму бота → 400 на server-боте | `index.ts:533-544`, `client.py:335-347` | ✅ |
| SDK-08 | Minor | DSH: `writeFile(..., {flag:"wx"})` теряет повторно отправленный файл | `integrations/dsh-fastchat/lib/index.js:96` | ✅ |
| SDK-09 | Minor | `start()` считает 401/403 транзиентными и вечно молча ретраит | `index.ts:642-646` | ✅ |
| SDK-10 | Minor | Hermes `connect()` не останавливает прежний poll-таск — два параллельных поллера | `adapter.py:129` | ✅ |
| SDK-11 | Minor | Python SDK кэширует режим бота навсегда: после включения E2EE продолжает слать plaintext | `client.py:116` | ✅ |
| SDK-12 | Minor | DSH читает `present`-файл целиком без проверки размера | `lib/index.js:254` | ✅ |
| SDK-13 | Minor | Проактивная отправка в E2EE невозможна, ошибка не `BotApiError`, в TS README не описано | `index.ts:300-301` | ✅ |
| SDK-14 | Minor | `getUpdates` в примерах README не двигает offset — бесконечный повтор пачки | `client.py:100-114` | ✅ |
| SDK-15 | Minor | Hermes: глобальные `_CHAT_CREDENTIALS`/`_LAST_CHAT_ID` и блокирующий tool в loop | `adapter.py:55-56,487-507` | ✅ (реестр bounded+TTL, но процесс-глобальный) |
| SDK-16 | Minor | `sleep()` в TS не снимает abort-listener — накопление подписок | `index.ts:822-838` | ✅ |
| SDK-17 | Minor | DSH ключует сессии/offset по токену: ротация переигрывает старые апдейты в новую сессию | `lib/index.js:44-50` | ✅ |

---

# Часть II. План фиксов

Принципы:

1. Сначала остановить необратимые потери (ключи, сообщения, БД).
2. E2EE-протокол меняется только версионированно, с окном совместимости.
3. Каждый этап заканчивается `make lint`, `make test`, `make frontend:e2e` и новыми тестами на регрессию.
4. Пункты со статусом ◐ сначала подтверждаются по коду/репро, затем фиксятся.

## Этап 0 — аварийные фиксы (1–2 дня)

Цель: убрать необратимые потери и самые дешёвые дыры. Без миграций и изменения протокола.

| ID | Задача | Оценка |
|----|--------|--------|
| API-01 | На 401/неудачный refresh не удалять IndexedDB/ключи; удаление — только по явному logout/clear data. На 401 сначала одна попытка refresh | S |
| E2E-06 | Не включать `revoked_at` в `DoUpdates`; отозванный ключ не должен воскресать. Добавить тест | S |
| CHAT-01 | Валидировать `withUserIsBot` по `store.GetBot`/`user.IsBot`; не менять режим существующего чата | S |
| MSG-01 | Не отправлять >100 `missingIDs` (срез/только новые id); сервер не отвечать 400 на лишние | S |
| HK-02 | При старте правки заполнять композер текстом; разрешать Save при пустом вводе, если есть файлы/локация | S |
| HK-01 | Сбрасывать `editingMessage`/`replyToMessage`/`pendingFiles`/`pendingLocation` при смене чата, треда и аккаунта | M |
| CHAT-02 | Снимать `ServerNow` до первого запроса дельты | S |
| SYN-01 | Писать `serverNow` только при `next === null`; иначе персистить `nextSince/nextSinceId` | S |
| API-02 | Подписать три SSE-события; добавить ветку `thread_message_updated` | S |
| AUTH-02 | Запрещать/громко предупреждать `debug_mode` при публичном домене; убрать код из ответа вне loopback | S |
| ADM-03 | Убрать `IsAdmin` из `PublicUser`/`Public()`, отдавать только в auth-DTO/себе | S |
| INF-01 | Убрать/поднять `ReadTimeout`; точечный read-deadline на upload; различать таймаут и oversize | S |
| MED-05 | Per-user квота SSE в хабе; анонимные не должны вытеснять авторизованных | M |

Acceptance: воспроизведения из отчётов больше не воспроизводятся; новые тесты на каждый пункт.

## Этап 1 — целостность данных и sync (1–1.5 недели)

Цель: ни одно сообщение/чат/операция не теряются при обрывах, смене аккаунта и офлайне.

| ID | Задача | Зависимости |
|----|--------|-------------|
| SYN-01, CHAT-02, CHAT-05 | Единый keyset-курсор: `serverNow` до чтения, `RFC3339Nano`, отдельные id-тайбрейкеры | Этап 0 |
| CHAT-04 | `GetUserChatsE` с ошибкой; `Sync` пробрасывает 500, клиент ретраит | — |
| SYN-08, SYN-09, DB-07, DB-09 | Прокинуть `accountKey` во все записи/чтения; проверка после каждого await; cleanup `tokenProvider` | — |
| SYN-02, SYN-04, SYN-19 | Пауза outbox — не успех: армить retry вне Web Lock; не спать под локом | — |
| CHAT-03, BOT-08 | `ClearChatDeletes` на федеративном и ботовом путях | — |
| FED-01, FED-02, FED-04 | Catch-up по членству, а не `remote_server`; relay edit/delete/typing по доменам участников; не мутировать `RemoteServer` | FED-05 |
| FED-05, FED-06 | Применять дельту с ошибкой-позицией; курсор до первой неудачи; сохранять `CreatedAt` | — |
| FED-03, FED-07 | Lifecycle/relay через outbox; relay-исключение в проверке автора | FED-02 |
| MSG-10, MSG-04 | Федеративные треды и реакции: либо реализовать, либо явно запретить и задокументировать | FED-01 |
| DB-01, DB-02, DB-03 | `blocked/blocking/terminated`, одна транзакция каскада, остановка sync при clearAllData | — |
| DB-04, DB-05, DB-06 | Метаданные LRU отдельно от содержимого; не писать на чтении; не эвиктить только что сохранённое | — |
| MSG-02, MSG-03, MSG-08, MSG-09 | Статусы для новых страниц, полный edit-ответ, курсор по `(created_at,id)`, корректный `message_count` | — |
| HK-03, HK-04, HK-05, HK-06 | Закрывать тред при смене чата; queued delete = cancel send; сохранять `status` тредов; `filesToRemove` | — |
| UI-02, UI-03, UI-04 | `key` для MessageList; `scrollToMessageId` + догрузка; авторы в треде | — |

Acceptance: сценарии «обрыв на второй странице», «смена аккаунта во время sync», «правка/удаление в федеративной группе из 3 серверов», «офлайн-реакция» проходят в e2e/интеграционных тестах.

## Этап 2 — E2EE-протокол v3 (2–3 недели)

Цель: аутентичность и метаданные. Это breaking change, нужен version gate.

| ID | Задача | Примечание |
|----|--------|------------|
| E2E-01, E2E-02 | Подпись содержимого ключом отправителя + AAD (`chatId`, `messageId`, `fromId`, `createdAt`, `keyIds`); v3 payload | Старые v2 читаем; новые шлём v3 после подтверждения поддержки |
| E2E-03 | Для encrypted-upload отправлять нейтральное имя; `fileMeta.name` — только внутри шифртекста | Требует правки сервера/БД (не хранить original_name для encrypted) |
| E2E-04, E2E-08 | Захват `accountScope` до await, проверка после; хранить несколько ключей по `keyId` и пробовать все | Миграция локальных ключей |
| E2E-05 | Проверять наличие собственного конверта; при revoke текущего ключа сбрасывать регистрацию | — |
| E2E-07 | `Object.hasOwn`/`Map` для `fileMeta`; валидировать значения | — |
| E2E-09 | Подключить `getSessions` и `multi-device-key-required` | — |
| E2E-10, E2E-11 | Fail-closed без payload; версия в payload, явный отказ на неизвестную | — |
| E2E-13 | PBKDF2 600k или Argon2id; версия KDF в блобе | Миграция бэкапов |
| SDK-02, SDK-03, SDK-11 | Кэш режима/id бота; не маскировать сетевую ошибку под undecryptable; TTL режима | После серверного v3 |
| SDK-05 | Документировать, что callback data не аутентификатор; добавить nonce-хранилище в примерах | Продуктовое решение |

Acceptance: матрица совместимости v2↔v3 (старый клиент читает новые сообщения хотя бы текстом; новый проверяет подпись; подделка сервером не проходит).

## Этап 3 — безопасность и устойчивость backend (1.5–2 недели)

| ID | Задача |
|----|--------|
| AUTH-01 | Счётчик неудачных OTP на email/код + инвалидация после N; per-email лимит |
| AUTH-03 | `Peek`-валидация setup-token, потребление только после успешного создания (или в одной транзакции) |
| AUTH-04, AUTH-05 | `RowsAffected` → 404/409; политика backup для недавно отозванных устройств |
| AUTH-06..13 | Лимит на email, нормализация allowlist, SMTP-дедлайн, CSPRNG-ошибки, скрыть метаданные устройств |
| ADM-01, ADM-02 | `disabled_by_admin`; root-bot уважает `is_active`; проверка `owner.banned` в bot-auth |
| ADM-04, ADM-05, ADM-06, ADM-07 | `LIMIT` поиска; федеративная модерация; удаление `bot_chats`; аудит чтения |
| BOT-01 | Серверное подтверждение апдейтов (`DELETE id < offset`) или tail-only при offset=0 |
| BOT-02, BOT-03 | Одна транзакция create/chat; upsert `bot_chats`; откат осиротевшего user |
| BOT-04, BOT-06, BOT-07 | Блокировка бота; 400 на чужой file_id; ранний `MaxMessageFiles` |
| MED-01, MED-02, MED-03, MED-04 | Стриминговый прокси файлов; ICE-лимит; GC/квота файлов; фатальная ошибка VAPID + миграция подписок |
| MED-06, MED-08, MED-09, MED-10, MED-11, MED-13, MED-14 | 400 на oversize; `PostForm`; чистка индексов; закрытие/seq при drop; маппинг 403/422; хэш endpoint; различать multipart-ошибки |
| INF-02..06 | `/openapi.json`, `trusted_proxies` warning, `KnownFields`, shutdown-порядок, chmod БД/каталога |
| CHAT-06, CHAT-07 | Репликация состава при любом изменении; очистка tombstone по актуальным членам |
| FED-08, FED-09 | LRU/TTL+singleflight для ключей; валидация private-состава |
| MSG-05, MSG-06, MSG-07 | Не фанаутить повтор; `created` из `AddRawMessage`; cap реакций |

## Этап 4 — UX, доступность и Minor (1–1.5 недели)

| Группа | Что делать |
|--------|------------|
| Композер/медиа | CMP-01..15: дубликаты, геолокация, MediaRecorder, waveform, превью, clipboard, forward, mobile Enter |
| Чат-UI | UI-05..15: read-range, пины, скачивание, клавиатура, ссылки, OSM click-to-load, фокус, E2EE-пины |
| Модалки | MOD-01..18: confirm-диалоги, гонка groupSettings, per-device backup, пароль/токен, подписи кнопок, empty states, LoginPage |
| SDK | SDK-01, SDK-04, SDK-06..17: DNS-pinning, offset Hermes, стриминг, режимы, DSH, README |
| Мелочи backend | AUTH-07..13, ADM-08..14, MSG-11..15, CHAT-08..15, BOT-08..18, FED-10..19, INF-07..15, MED-07..14 |

## Продуктовые решения (до реализации)

1. **Реакции в федерации**: реализовывать delta-список или явно запретить/скрыть в федеративных чатах.
2. **Треды в федерации**: реализовывать создание/репликацию или запретить создание в чатах с удалёнными участниками.
3. **OSM-мини-карта**: click-to-load vs self-hosted tiles vs оставить (утечка координат).
4. **E2EE breaking v3**: окно совместимости и минимальная версия клиента.
5. **Backup после logout**: разрешать восстановление недавно отозванных устройств или считать logout окончательным.
6. **Квоты**: файлы на аккаунт/инстанс, число ботов на владельца, лимит SSE на пользователя.

## Проверки после каждого этапа

```bash
make lint
make test
make frontend:e2e
```

Дополнительно для затронутых зон:

- backend: `go test -race ./...` (входит в `make test`), новые тесты на курсоры, федерацию, ботов, файлы.
- frontend: новые тесты на composer state, SSE-подписки, IndexedDB-миграции, sync-курсоры.
- e2e: сценарии «офлайн → reconnect», «два аккаунта», «правка/удаление в группе», «вложение 20 МБ».
- E2EE: векторные тесты v2/v3, матрица совместимости, проверка подделки сервером.

## Ожидаемый порядок релизов

1. **Hotfix 0.x** — этап 0.
2. **0.x+1** — этап 1 (без E2EE-протокола).
3. **0.x+2** — этап 2 за feature flag/версией протокола, этап 3 параллельно.
4. **0.x+3** — этап 4 и закрытие Minor.

Коммиты и пуш — только по явной команде пользователя (см. `AGENTS.md`).

---

# Часть III. Статус реализации на 2026-11-25

## Этап 0 — выполнен

- API-01: 401/сбой refresh больше не удаляет IndexedDB и E2EE-ключ; `sessionExpired` снимает только токен. Явный logout/clear data по-прежнему удаляет данные.
- E2E-06: `UpsertUserDevice` не сбрасывает `revoked_at`; добавлен тест.
- CHAT-01: `withUserIsBot` подтверждается только локальным `user.IsBot` или ответом пира; флаг больше не может включить plaintext.
- MSG-01/MSG-02: клиент не отправляет весь кэш в `missingIDs`; статусы приходят для всей страницы.
- HK-01/HK-02: композер сбрасывает вложения/reply/edit при смене чата, треда и аккаунта; правка заполняет текст сообщения.
- CHAT-02/SYN-01: `ServerNow` снимается до выборок; курсор пишется только после полного дренажа дельты.
- API-02: подписаны `message_reactions_updated`, `chat_pinned`, `thread_message_updated`; добавлен обработчик правки тред-сообщения.
- AUTH-02: `debug_mode` при заданном `public_domain` останавливает старт; иначе выводится предупреждение.
- ADM-03: `isAdmin` убран из `PublicUser`/`Public()` и добавлен только в ответы входа; обновление профиля мержит поля.
- INF-01: `ReadTimeout` поднят до 5 минут (50 МиБ на медленном канале).
- MED-05: per-user лимит SSE (8 потоков, вытесняется самый старый) поверх глобального cap.

## Этап 1 — выполнен в основной части

- Курсоры: `RFC3339Nano`, `GetUserChatsE`, cursor-формат `timestamp|id` (удаление граничного сообщения больше не обрывает историю).
- Федерация: catch-up включает локально созданные группы; ошибка применения страницы не двигает курсор; `CreatedAt` сохраняется; правки/удаления/typing релеятся по доменам участников; relay и lifecycle идут через outbox; при локальном чате `RemoteServer` больше не отключает relay.
- Треды/реакции/удаления: счётчик `thread.message_count`, полный edit-ответ с files/reactions, снятие tombstone на федеративном и ботовом путях, `ClearChatDeletesForChat`.
- Композер/UI: закрытие треда при смене чата, отмена queued-отправки, `status` в тредах, `filesToRemove`, авторы в групповом треде, `key` у MessageList, переход к сообщению по цитате/из поиска.
- IndexedDB: `blocked/blocking/terminated`, одна транзакция каскада, реестр БД для clear-all, остановка sync при очистке, `get` не пишет на путь чтения, LRU не удаляет только что сохранённый файл, `useLiveQuery` отсекает устаревшие результаты, файловый кэш привязан к аккаунту.
- Outbox: пауза очереди не считается успехом, `Retry-After` обрабатывается вне Web Lock, `tokenProvider` очищается при logout, `applyDelta` проверяет аккаунт перед каждой записью.

## Этап 2 — выполнена безопасная часть

- E2E-03: имя зашифрованного файла больше не уходит на сервер открытым текстом.
- E2E-04/E2E-08: восстановление ключа проверяет смену аккаунта после каждого await.
- E2E-05: отправка требует собственный конверт; иначе fail-closed.
- E2E-07: `Object.hasOwn` и валидация `fileMeta` закрывают `__proto__`.
- E2E-10/E2E-11: fail-closed без payload, проверка версии конверта.

**Не реализовано (требует отдельного решения):** E2E-01/E2E-02 — подпись отправителя и AAD в протоколе v3. Это breaking change с окном совместимости старых клиентов; делать его без согласования нельзя.

## Этап 3 — выполнена часть

- AUTH-01: 5 неудачных OTP-попыток удаляют код.
- AUTH-03: setup-token проверяется без потребления; потребляется после создания аккаунта.
- ADM-04: `SearchUsers` ограничен 50 результатами.
- ADM-06: удаление чата чистит `bot_chats`/`bot_callback_queries`.
- BOT-01: `getUpdates` подтверждает апдейты ниже offset.
- BOT-02: `CreateBotChat` обновляет `chat_id` при конфликте.
- BOT-04: заблокированный бот не может писать.
- BOT-07: ранний лимит `files[]` в Bot API.
- BOT-09: ботов нельзя добавлять в группы.
- MED-02/MED-06: ICE-кандидат проверяется до рассылки, oversize SDP/ICE → 413.
- MED-04: битый `vapid_keys.json` — фатальная ошибка, запись атомарная.
- INF-02: `/openapi.json` больше не перехватывается SPA.
- INF-04: YAML с неизвестными ключами не загружается.
- INF-05: store не закрывается под работающими воркерами.
- INF-06: права каталога и файла БД ужесточаются.
- AUTH-02/INF-03: предупреждения о debug-режиме и пустых `trusted_proxies`.
- Root-bot уважает `is_active`; забаненный владелец не получает Bot API после re-enable.
- MSG-05: повторная отправка с тем же id больше не дублирует федерацию и push (`SendMessageWithResult`).
- ADM-05 (частично): админское удаление сообщения рассылается пиру/доменам участников.
- MED-01: федеративные файлы стримятся с лимитом 64 МиБ и не более 4 одновременно; память не держит файл целиком.
- BOT-02/BOT-04/BOT-07/BOT-09/BOT-01: upsert `bot_chats`, блокировка бота, ранний лимит файлов, запрет ботов в группах, подтверждение апдейтов.
- FED-03/FED-04/FED-07: lifecycle и relay идут через outbox; relayed-author проверка разрешает владельцу пересылать чужие сообщения.
- FED-05/FED-06: неудачная страница catch-up не двигает курсор; сохраняется исходный `CreatedAt`.
- CHAT-06/CHAT-07: изменения состава реплики уходят владельцу; tombstone чистится по актуальному составу.
- MSG-08: курсор пагинации кодирует `created_at|id`, удаление граничного сообщения не обрывает историю.
- BOT-08, CHAT-03: федеративное/ботовое сообщение снимает tombstone скрытого чата.
- BOT-03: пользователь-бот и профиль бота создаются одной транзакцией.
- INF-11/INF-13: предупреждение о wildcard CORS; 429 отдаётся JSON с `Retry-After`.
- ADM-13: фильтр блокировок fail-closed при ошибке БД.
- UI-07/UI-08: ошибки скачивания и копирования текста показываются пользователю; blob не ревокается мгновенно.
- MED-01: федеративный файл до 64 МиБ, стриминг, не более 4 параллельных чтений.

## Осталось (требует решения или осознанно отложено)

- **MED-07**: для E2EE-вложений сервер хранит SHA-256 плейнтекста. Это нужно для дедупликации; убирать — ломает dedup и требует продуктового решения.
- **MED-12**: федеративные отчёты о звонке остаются синхронными с таймаутом 3 с; перевод в outbox может переупорядочить ICE.
- **UI-12**: мини-карта грузит тайлы OSM при рендере — координаты уходят третьей стороне без действия пользователя. Нужен click-to-load.
- **SDK-05**: callback data не аутентифицирована (sealed box на ключ бота); бот должен сам проверять действия. Нужно решение: nonce/подпись или только документация.
- **ADM-07**: аудит чтения чужих сообщений/чатов админом не добавлялся — по решению оставлено текущее поведение.
- **BOT-11**: квота 20 ботов на владельца добавлена; отдельного API удаления ботов нет, поэтому освобождение имён пока неприменимо.
- **Квоты файлов**: GC неотвязанных файлов есть, квоты на аккаунт/инстанс не вводились.
- **Identity key**: мультидевайс без парольного backup получает новую identity; для сохранения личности на новом устройстве нужен recovery. Это ограничение TOFU, а не незакрытый баг.
- **Старые вкладки**: v2 включается только когда все устройства получателей заявили `protocolVersion >= 2`; иначе используется v1.

## Вопросы, блокирующие остаток

1. **E2EE v3**: внедряем подпись отправителя и AAD? Это breaking change: нужен минимальный поддерживаемый клиент, окно совместимости и решение по v2 (читать, но не отправлять).
2. **Федерация реакций и тредов**: реализовывать полноценно (эндпоинты + delta) или явно запретить/скрыть в федеративных чатах?
3. **Файлы**: включаем GC неотвязанных файлов старше N часов и квоту на аккаунт? Нужно выбрать N и политику для дедуплицированных путей.
4. **Backup после logout**: оставляем возможность восстановления недавно отозванных устройств или считаем logout окончательным?
5. **Админ-модерация федеративных чатов**: разрешаем админу удалять реплику чужого чата (карантин + уведомление владельца) или отвечаем 409?
6. **SSE**: оставляем per-user лимит 8 или делаем настраиваемым?

### Ответы и решения

- **E2EE v3**: реализовано как payload v2 без новых таблиц: `crypto_box_easy`, AAD `chatId|messageId|fromId|threadId`, Ed25519 identity key и TOFU-пиннинг identity. `createdAt` в AAD не входит: его назначает сервер уже после шифрования. v1 по-прежнему читается; оба SDK читают v2.
- **Реакции и треды в федерации**: реализованы полностью. Реакции: live-relay, tombstone-таблица `reaction_deletions`, catch-up живых реакций и удалений, разрешение конфликтов по времени события. Треды: детерминированный id = id родительского сообщения, live-relay создания и сообщений треда, автосоздание строки треда при catch-up, счётчик сообщений.
- **Файлы**: «неотвязанные» — загруженные файлы без ссылки из сообщения/аватара. Реализован GC: ежедневно удаляются записи и байты старше 7 дней, не связанные с сообщением, аватаром пользователя или чата; федеративные плейсхолдеры не трогаются, общий blob удаляется только после последней ссылки. Квота не вводится.
- **Backup после logout**: оставить текущее поведение (logout окончателен), окно 30 дней не вводить без отдельного запроса.
- **Модерация реплик**: оставить текущее поведение; карантин не вводить без отдельного запроса.
- **SSE**: 8 потоков на аккаунт (не на пользователя: каждая вкладка/устройство — отдельный поток), глобальный cap 1024.

## Второй заход (закрытие оставшихся пунктов)

- Backend: валидация федеративного поиска (ADM-10/11), unban восстанавливает только отключённых баном ботов (ADM-14), tombstone приватного чата чистится только открывшему (CHAT-14), правила имён ботов (BOT-10), квота ботов (BOT-11), редактирование токена в push-превью (BOT-12), конфликт федеративного файла не роняет сообщение (FED-16), 413 для ICE (MED-06), таймаут отчёта о звонке (MED-12).
- Frontend: сериализация background outbox (SYN-06), live-сигнал SSE и watchdog (API-13), фокус после меню (UI-13), первый элемент read-range (UI-05), геолокация/запись/Enter на touch (CMP-03/04/15), refcount blob URL для аудиоплеера (CMP-05), LRU waveform-кэша (CMP-12), подтверждения опасных действий и empty-state (MOD-04/05/06/09/12/14/15/16/18), звонки (API-08/10/12), optimistic pin (SYN-19), push-навигация (SYN-11).
- SDK: единый поллер Hermes (SDK-10), BotApiError для proactive E2EE + README (SDK-13), async location tool (SDK-15), утечка abort-listener (SDK-16), стабильные ключи сессий/offset при ротации токена (SDK-17).

## Третий заход (правки по diff-ревью)

- **F1/F3:** оба SDK (TS/Python) читают payload v2: easy-box, проверка Ed25519-подписи и AAD. Web шифрует v2 только если все устройства получателей заявили `protocolVersion >= 2` (новое поле `user_devices.protocol_version`); иначе откат на v1, поэтому старая вкладка продолжает читать новые сообщения. Бот при включении E2EE регистрируется как v2-устройство.
- **F8:** добавлен долгоживущий Ed25519 identity key аккаунта. v2-сообщение подписывает `senderKey + AAD`; получатель пиновает identity (не device key), свои сообщения не пиноваются. Identity включён в парольный backup, поэтому восстановленное устройство сохраняет личность; мультидевайс без backup получает новую identity (документировано).
- **F2/F6/F9/F10:** catch-up различает permanent/transient ошибки и пропускает «отравленную» строку; реакции в своих чатах проверяют автора по пиру; `ServerNow` снимается до выборок; outbox пишется через `context.WithoutCancel`.
- **F4/F5:** добавлен endpoint добавления участника с реплики; удаление разрешено владельцу или серверу самого участника; typing проверяет автора с учётом relay от владельца.
- **F7:** при per-user лимите SSE сервер отвечает 429, живые стримы не вытесняются; клиент на 429 прекращает reconnect.
- **F11–F19:** реакции/tombstone чистятся при удалении сообщения/чата и по TTL; live-relay передаёт настоящий `threadParentId`; курсор реакций сравнивается кортежем; убран дубль ICE-маппинга; `blocked` IndexedDB отклоняет `getDB` и сбрасывает кэш; ошибка БД при создании бота больше не выдаётся за занятое имя; pull дельты больше не блокируется паузой outbox; отдельный aria-label для снятия выбора в группе; убраны дубли AutoMigrate в тестах.
- **Дополнительно:** федеративные файлы (и клиентский, и бот-путь) стримятся через `Client.OpenStream` с Range/206/416 и отдельным stream-таймаутом; Hermes больше не использует `_LAST_CHAT_ID` (реестр чатов с TTL/лимитом, tool привязан к текущему чату), документация приведена в соответствие с фактическим статусом.

## Четвертый заход — v3 (мастер-ключ аккаунта)

- Один мастер-ключ на аккаунт: пара ключей шифрования + пара ключей подписи.
- Один конверт на участника чата (`keyId` = id пользователя/бота), а не на устройство.
- В конверте есть `keyVersion`; в профиле пользователя — текущая версия.
- Сервер принимает только payload `v = 3`; v1/v2 отклоняются.
- Парольный бэкап содержит обе пары и версию; новое устройство восстанавливает тот же мастер-ключ.
- Боты: `enableE2EE` создаёт обе пары, Bot API принимает клиентский `id`, ответы и callback-ответы уходят v3.
- `protocolVersion` у устройств и legacy account-key конверт удалены.
- Кнопка бэкапа показывает состояние и ведёт в управление.
- Ротация ключей шифрования и подписи: история ключей, `keyVersion`, UI, подписанная цепочка identity; другие устройства получают новую версию через бэкап.
- Принудительный бэкап: после создания мастер-ключа отправка блокируется, пока не задан пароль.
- Бэкап v4: мастер-ключ завёрнут паролем и passkey PRF; восстановление любым способом.
- Настройки автоблокировки: бездействие/фон/заморозка/после сна, per-device.
- Старую БД нужно дропнуть: формат ключей и сообщений несовместим.

## v3: второй раунд ревью и исправлений

Закрыто после read-only ревью незакоммиченного диффа:

- **Локальный lock.** PIN/passkey-бэкап теперь включает историю ключей, identity-историю и цепочку; в plaintext IndexedDB они не остаются. `lockLocalKeys` чистит и in-memory историю. «Забыл PIN» спрашивает подтверждение и предупреждает, если серверного бэкапа нет. Отключение PIN при активном passkey не пишет ключи в plaintext; отключение passkey без второго фактора требует разблокировки.
- **Мультидевайс и ротация.** Ротация запрещена при включённом локальном lock и при passkey-обёртке серверного бэкапа; пароль проверяется до изменений. Новый ключ сначала персистится локально, затем публикуется, и только потом пишется бэкап (сервер принимает бэкап только для опубликованной версии); ошибка публикации/бэкапа не глотается. `uploadKeyBackup` игнорирует устаревшую пару из UI и берёт текущую из хранилища.
- **Отправка.** Свой конверт всегда собирается из локального текущего ключа, а не из pubkey-кэша, поэтому отправка сразу после ротации не падает.
- **Расшифровка.** Создание/восстановление/разблокировка/ротация шлют событие изменения ключевого материала; `useMessages`/`useThreads` пересчитывают кэш «не расшифровано».
- **Бэкап-гейт.** Блокирует только подтверждённое отсутствие бэкапа (`none`); сетевая ошибка (`unknown`) не запирает приложение. После неудачного сохранения есть явный выход «продолжить без бэкапа».
- **Passkey-восстановление.** Восстанавливает ключи и историю в постоянное хранилище и перезагружает страницу; PRF-обёртка сохраняется при смене пароля.
- **Сервер.** `masterKeyVersion` монотонен: старый ключ с той же/меньшей версией получает 409, identity можно обновить при той же версии только с тем же encryption-ключом. Повторный `enableE2EE` бота с другой identity отклоняется; с той же identity версия растёт.
- **Федерация.** `CurrentProtocolVersion = 2`: v1-пир получает явный отказ вместо тихой потери v3-шифртекста. Это намеренный breaking change.
- **Legacy.** Удалён per-device restore во фронтенде и серверные `/device-key/backup`-эндпоинты: v2-блобы всё равно не читаются.
- **SDK/UX.** Python SDK принимает `identity_key`; ошибки ротации/локального lock локализованы; цепочка identity в сообщении ограничена 32 звеньями.

Третий раунд ревью (после этих правок):

- **«Начать заново».** `discardRecoveryAndGenerate` читает серверную версию и публикует замену на `serverVersion + 1`; иначе сервер навсегда оставался со старым ключом, а 409 молча глотался.
- **Версия бэкапа.** Контейнер/запрос бэкапа несёт `masterKeyVersion`; сервер принимает запись только при `users.key_version = version`, иначе 409 `stale-key-backup`. Устройство, пропустившее ротацию, больше не затирает бэкап актуального ключа.
- **Ротация.** Перед изменением сверяется серверный ключ/версия; при рассинхроне — `StaleKeyStateError` и требование recovery. Новый ключ сначала персистится локально, затем публикуется, и только потом пишется бэкап; ошибка публикации больше не глотается.
- **Монотонность на клиенте.** Разблокировка/PIN-блоб с меньшей версией отклоняется, версия не откатывается.
- **Lock и ключевой материал.** `ensureIdentityKeys` не создаёт identity при закрытом локе; `uploadKeyBackup` работает только с локальным ключом; закрытие лока чистит расшифрованные вложения (`decryptedFiles` + memory) и текстовый кэш хуков.
- **Федерация.** `ProtocolVersion` возвращает `ErrNoCommonProtocol` для пира без v2; запрос без заголовка протокола отклоняется (401).
- **UI.** Автолок вынесен в корневой layout (работает и на `/admin`); удалён мёртвый multi-device-сценарий; удалён «Revoke key» (per-device ключей больше нет).
- **Надёжность лока.** `enableLocalPin` проверяет, что записанный блоб расшифровывается, до удаления plaintext.
- **Расшифровка.** При промахе версии конверта пробуется и текущий ключ (частичный рассинхрон не превращается в полную потерю).
- **Тесты.** Добавлены: монотонность `keyVersion` и бэкапа (transport), `ProtocolVersion` для v1-пира, отказ федеративного запроса без заголовка, pinning identity и подмена AAD/messageId, discard поверх серверной версии.

Четвёртый раунд ревью:

- **Discard.** Перед заменой удаляется локальный мастер-ключ (полный reset), версия проверяется после генерации; «Начать заново» больше не возвращает старый ключ после уничтожения бэкапа/identity.
- **Версия в контейнере.** v4-бэкап несёт plaintext `masterKeyVersion`; гейт считает бэкап отсутствующим, если он старее локального ключа, и просит сохранить заново.
- **Чтение после чужой ротации.** Если конверт новее локальной версии и не открывается, клиент сверяет серверную версию и показывает recovery вместо вечного «не расшифровано».
- **Signing-ротация.** Тоже поднимает `masterKeyVersion` и сверяет серверную identity; сервер запрещает смену ключа/identity при равной версии (кроме точного повтора). Две «сестринские» identity больше не публикуются.
- **Удаление бэкапа.** DELETE требует `masterKeyVersion` и версию текущего ключа (409 иначе); put принимает только валидный v4-контейнер (password/passkey), v2-блоб не затрёт текущий.
- **Identity pin.** Пинится только после успешной расшифровки контента; поддельная нерасшифровываемая запись не захватывает identity пира.
- **Лок.** Генерация ключей/identity отменяется по epoch, если лок закрылся во время неё; recovery при активном локальном локе запрещён.
- **Боты/UI.** Повторный `enableE2EE` с другой identity — 409; ошибки `stale-*` локализованы; удалены мёртвые `device-keys`-обёртки и `verifyIdentityTransition`.

Пятый раунд ревью:

- **Смена аккаунта во время операции.** Ключевой материал пишется через `setNoNotifyFor` в БД захваченного аккаунта; перед записью проверяется `accountScope`. Ротации и `uploadKeyBackup` сериализованы `withKeyLock`.
- **Удаление бэкапа.** Один условный `UPDATE ... WHERE key_version = ?` без TOCTOU.
- **Запись бэкапа.** `uploadKeyBackup` сверяет локальный ключ с серверным, иначе не перезаписывает бэкап ключом-сиротой.
- **Восстановление.** Ключ из бэкапа должен совпадать с серверным и по версии, и по pubkey; иначе `StaleKeyStateError` без пометки «опубликован».
- **«Начать заново» с PIN.** Требует явного подтверждения снятия PIN/passkey, иначе отказ.
- **Passkey-бэкап.** Добавлено отключение серверной passkey-обёртки, UI-кнопка рядом со статусом.
- **SDK.** `botID` подгружается лениво (`getMe`) при E2EE-отправке в TS и Python; TS переносит `keyVersion` из `getUserDeviceKeys`.
- **Прочее.** Состояния бэкапа `none/legacy/stale/backup`; throttle stale-отчёта per-scope; catch в гейте/«забыл PIN»; бот получает 404 «recipient has no E2EE key» вместо 500.

Шестой раунд ревью:

- **Сквозной account scope.** Публичные операции захватывают scope и передают его в `*Locked`/`withKeyLock`; чтения идут через `metaRepo.getFor`, записи — `setNoNotifyFor`; `readServerKeyState(token, userId)` больше не берёт активный аккаунт. Это закрывает подмену ключа/identity при переключении аккаунта во время PBKDF2/WebAuthn/сети.
- **Lock-операции.** enable/disable/unlock PIN и passkey идут через тот же Web Lock, что и ротация; блоб пишется в БД захваченного аккаунта.
- **Бэкап-контейнер.** Passkey enable/disable сериализованы с ротацией и сменой пароля; `disableServerPasskey` перечитывает контейнер и обновляет `masterKeyVersion`.
- **История.** Кэшированные массивы истории копируются перед изменением; при сбое не остаются фантомные записи.
- **Ошибки.** `KeyPublishError`/`KeyBackupSaveError` сохраняют `code`, поэтому `stale-*` показывается как «восстановите ключ», а не общая ошибка.
- **Боты.** Коллизия клиентского `id` — 409; `SetBotEncryptionKey` использует условный `UPDATE` по identity (CAS).
- **SDK.** TS сохраняет обратные алиасы `publicKey/privateKey`; Python `E2EEKeys` распаковывается как кортеж и поддерживает старые атрибуты.
- **Тесты.** Добавлены отказ ротации при чужом серверном ключе и запрет discard при включённом локе.

Седьмой раунд ревью:

- **Восстановление.** `persistServerBackupData(data, scope)` проверяет активный scope перед записью; passkey/password restore передают захваченный scope.
- **Федерация.** Известный пир с well-known без `protocolVersions` считается v1 и получает `ErrNoCommonProtocol`, а не молчаливое согласование v2.
- **SDK.** Python `enable_e2ee` больше не вызывает `get_me` после публикации ключей; TS кеширует `botID` и не делает GET на каждое сообщение.
- **Recovery при локе.** Stale-событие не открывает тупиковое окно при включённом PIN/passkey; если оно всё же открыто, ошибка лока даёт кнопку закрытия.
- **Scope.** `getDBFor("")` больше не создаёт фантомную БД; pubkey-кеш пишется через `getFor/setNoNotifyFor`.
- **Боты.** CAS по `key_version` для повторного `enableE2EE`; удалённые ключи устройств валидируются; коллизия `id` — 409.
- **Лимиты.** История ключей/identity ограничена 64 записями, чтобы бэкап не упёрся в 64 KiB.
- **UI/тесты.** Ошибки настроек лока ловятся; тесты покрывают legacy-пира, успешный restore с совпадающим серверным ключом и identity-сверку signing-ротации.

Восьмой раунд ревью:

- **Bot API.** Зашифрованная отправка без клиентского `id` — 400 (AAD нельзя подписать на серверный id); идемпотентный повтор принимается только от того же отправителя, иначе 409.
- **Lock и расшифровка.** Завершающаяся расшифровка вложения проверяет закрытый лок перед записью/выдачей plaintext; аудиоплеер останавливается по лок-событию; результаты локального поиска очищаются.
- **Recovery UI.** `StaleKeyStateError` мапится в «восстановите ключ» и даёт кнопку восстановления; при ошибке локального лока recovery-окно можно закрыть.
- **Федерация.** Прокси публичного ключа принимает пустой `identityPublicKey` (identity не нужна для шифрования); 404 пира в Bot API — 404, а не 500; истёкший pubkey-кэш не считается legacy навсегда.
- **SDK.** Signing private key в TS хранится как 32-байтовый seed (совместим с PyNaCl), Python принимает и 64-байтовый вариант; README описывает breaking changes v3.
- **Прочее.** `getDBFor("")` не создаёт фантомную БД; identity-пины пишутся в захваченный scope; «блокировать в фоне: никогда» больше не срабатывает из-за sleep-порога; настройки лока валидируются и ловят ошибки; лимит истории работает.

Девятый раунд ревью:

- **Passkey.** Перед удалением plaintext-ключей проверяется, что записанный passkey-блоб открывается и совпадает с текущими ключами; при провале блоб откатывается.
- **PIN.** Неудачная верификация записанного PIN-блоба удаляет блоб, а не оставляет «замок без замка».
- **Автоблокировка.** Фоновый таймер больше не зависит от тумблера «после сна»; «блокировать в фоне» срабатывает и при замороженном таймере.
- **Cross-tab.** Автоблокировка в одной вкладке рассылает lock через `BroadcastChannel` и запирает остальные вкладки.
- **Identity trust.** В доверенный список попадают только криптографически проверенные звенья цепочки, а не весь присланный массив.
- **Поиск.** Локальный поиск пересчитывается по lock-revision и не возвращает plaintext после закрытия лока.
- **Бэкап.** Лимит поднят до 128 KiB (passkey+password+история), stale/legacy показываются отдельным предупреждением, а не «бэкапа нет».
- **Ошибки.** Неверный PIN отличается от сбоя БД/KDF; «Начать заново» при неудачной публикации перезагружает страницу и повторяет публикацию, не предлагая удалять ключи снова.
- **Федерация.** `AddRawMessage` сверяет chat/thread/from и возвращает конфликт id вместо ложного успеха.
- **UI/Mocks.** `GlobalLocalLock` под ErrorBoundary; кнопка server-passkey скрыта без парольного бэкапа; удалены мёртвые device-key моки и store-методы бэкапа устройства.

Десятый раунд ревью:

- **404 ключа.** `readServerKeyState` трактует 404 как «ключа на сервере нет»: бэкап можно сохранить, restore переопубликует ключ.
- **Восстановление.** Сверяется и identity (если сервер её отдаёт); stale/сетевые ошибки дают текст и кнопку закрытия, а не только «Начать заново».
- **Публикация.** `uploadKeyBackup` сначала повторяет публикацию локальной версии, если сервер отстал, и только потом пишет бэкап.
- **Производительность.** Расшифровка читает историю один раз и открывает только свои конверты, а не по IDB-чтению на каждого участника.
- **Lock.** Кэш шифртекста больше не ревокается; расшифрованные URL сбрасываются по lock-revision; аудио останавливается только при реально закрытом локе.
- **Бэкап-гейт.** Перепроверяется по `online`, если первый раз был `unknown`.
- **Уборка.** Удалены неиспользуемые `UpdateUserPublicKey/GetUserPublicKey`; legacy device-key API явно помечены legacy в README.

Одиннадцатый раунд ревью:

- **«Начать заново».** Если identity ещё есть локально, она сохраняется: контакты с запиненным старым Ed25519 продолжают принимать новые сообщения; меняется только ключ шифрования.
- **Passkey.** Перед удалением plaintext выполняется **вторая** PRF-ассерция и проверка блоба; нестабильный authenticator не уничтожает ключи.
- **Lock at rest.** Включение PIN/passkey и холодный старт с закрытым локом чистят расшифрованные вложения; кэш шифртекста не ломается.
- **Cross-tab.** Смена ключевого материала рассылается через `BroadcastChannel`; другие вкладки сбрасывают in-memory ключи/историю/версию.
- **Федерация.** `AddRawMessageOnce` не допускает повторный fan-out SSE/push/bot/peers при replay; `AddRawMessage` остаётся обёрткой.
- **Совместимость.** Версия PBKDF2 хранится в блобе (старые блобы читаются с 310k); сервер требует password-обёртку, passkey — только дополнительная; legacy device-keys отдаются только владельцу, федеративный endpoint удалён.
- **Прочее.** 404 ключа обрабатывается, restore сверяет identity, `uploadKeyBackup` перепубликует зависшую версию, история обрезается и при restore, pubkey-кэш переживает офлайн, `getMyKeyVersion` мемоизирован, `clearLocalKeys` под Web Lock, `SendBotEncryptedMessage` без id удалён, мёртвые локали/типы убраны.

Двенадцатый раунд ревью:

- **Discard identity.** Если локальной identity нет, подтверждение «Начать заново» явно предупреждает, что контактам придётся заново доверять новой identity; при наличии identity она сохраняется.
- **Passkey.** `enableServerPasskey` сверяет локальный ключ с серверным и не оборачивает ключ-сироту после проигранной гонки ротации.
- **Replay федерации.** `AddRawMessageOnce` использует только `RowsAffected` (атомарно), а replay-путь идемпотентно восстанавливает remote-файлы и `SetMessageFiles`, пропуская только SSE/push/bot/forward.
- **Бэкап.** `decodeServerBackup` терпит `passkey: null`; состояние `local-stale` закрывает случай «серверный бэкап новее локального»; passkey-only контейнер не принимается сервером.
- **Бот.** Повторный `enableE2EE` с теми же ключами идемпотентен и не поднимает версию; legacy-бот документированно мигрирует через PUT с существующим `publicKey`.
- **Lock.** Cached-ветка вложений проверяет закрытый лок; настройки автолока откатываются при ошибке записи; комментарии про лимит 128 KiB.

Тринадцатый раунд ревью:

- **Recovery на новом устройстве.** `local-stale` (серверный бэкап новее пустого IDB) трактуется как recovery, а не «создать новый ключ»; иначе обязательный гейт перезаписывал единственную копию старого ключа. Добавлен тест.
- **Федеративный catch-up.** Ошибки v3-payload, `ErrMessageIDConflict` и прочие постоянные отказы пропускают строку и двигают курсор, не заклинивая синк пира.
- **Ротация шифрования.** Перед публикацией проверяется и серверная identity, как в signing-ротации.
- **UI.** Добавлен `error.newKeyFailed`; «Забыл PIN» считает `local-stale` восстановимым; закрытие вкладки не рассылает lock в другие вкладки; аудио-хук ловит ошибку IDB.
- **Публикация identity.** `uploadKeyBackup` переопубликует ключ, если у сервера пустая identity (v2-апгрейд).

Четырнадцатый раунд ревью:

- **Кросс-вкладочный lock.** Включение/отключение PIN/passkey теперь идёт через общий `notifyKeyMaterialChanged`: другие вкладки сбрасывают ключи и взводят оверлей, а не остаются разблокированными.
- **Discard identity.** Если локальная identity отстала от серверной, discard отклоняется как rollback: сначала нужно восстановить текущий ключ, а не перезаписывать identity.
- **Бот.** Повтор зашифрованной отправки с тем же `id` идемпотентно доклеивает файлы и клавиатуру, а не возвращает 201 без вложений.
- **Lock at rest.** История/цепочка удаляются одновременно с plaintext-ключами; async-расшифровка вложений проверяет синхронный lock-epoch и не пишет кэш после блокировки.
- **Смена аккаунта.** Предыдущий аккаунт запирается по Web Lock при switch, его ключи не остаются в памяти.
- **Прочее.** `Object.hasOwn` в TS SDK, лимит encrypted payload поднят до 64 KiB, «Забыл PIN» синхронизирует UI с фактическим состоянием, добавлен `error.newKeyFailed`.

Пятнадцатый раунд ревью:

- **Recovery под локом.** Stale-событие эмитится и при разблокированном локе; restore в этом состоянии снимает старую PIN/passkey-обёртку и восстанавливает ключ (пользователь включает лок заново).
- **Гейт `local-stale`.** Вместо гарантированно провального «сохранить бэкап» открывается recovery; PIN/ротация скрыты в обязательном гейте.
- **Кросс-вкладки.** `notifyKeyMaterialChanged(scope)` передаёт захваченный scope, а не активный.
- **Passkey.** Проверяется именно записанный в IndexedDB блоб, а не локальная переменная.
- **Replay федерации.** При повторе существующие вложения не перезаписываются.
- **UI/данные.** `hasServerKeyBackup` учитывает stale/legacy; «Забыл PIN» различает устаревший бэкап; Bot API больше не отдаёт нулевой `createdAt`; протухший pubkey-кэш используется только при транспортных/5xx ошибках.

Шестнадцатый раунд ревью:

- **BroadcastChannel.** Per-tab id игнорирует собственные сообщения; `lockLocalKeys` больше не рассылает lock другим вкладкам, а enable/unlock PIN/passkey — рассылает.
- **Боты.** Legacy-бот не может заменить ключ на той же версии; ротация encryption key у ботов запрещена (нет истории ключей); SDK переиспользует пару после потерянного ответа PUT.
- **Discard.** При наличии серверной identity без локальной identity decline блокируется (нет подписанной цепи), чтобы не делать identity-rollback.
- **Sleep-lock.** Проверка «после сна» выполняется до `arm()` и больше не сбрасывается focus-событием.
- **Lock at rest.** После записи расшифрованного вложения при смене epoch запись удаляется; «Забыл PIN» при `unknown` не предлагает destructive wipe.
- **Федерация/bot replay.** Повтор не перезаписывает существующие вложения (create — Set, replay — Add).
- **Self messages.** Свои сообщения проверяются по локальной identity/истории, а не пропускаются.
- **Производительность.** Lock-статус для вложений берётся из синхронного кэша, без IDB-чтения на каждый файл.

Семнадцатый раунд ревью:

- **Версия ключа.** History-ветка `assertServerKeyMatchesLocal` разрешена только при отставании сервера; при равной версии ключ обязан совпадать.
- **Свои сообщения.** Own-ветка проверяет подписанную identity-цепочку (мультидевайсная signing-ротация).
- **Публикация.** `uploadPublicKeyIfNeeded` перечитывает текущую пару/версию, а не доверяет аргументу.
- **Восстановление/discard.** Оба под общим Web Lock; discard дополнительно проверяет scope перед подтверждением.
- **Wipe.** «Забыл PIN» рассылает инвалидацию ключей в другие вкладки.
- **Replay.** Федеративный replay вызывает unhide и возвращает `msg` с восстановленными файлами; bot-retry не падает на удалённом файле и не перезаписывает непустой markup.
- **Мелочи.** Лок-ветка вложений сбрасывает state; лимит payload проверяется на клиенте с понятной ошибкой; настройки автолока синхронизируются между вкладками; README SDK больше не отрицает шифрованные файлы/локации; документация порядка «publish → backup» исправлена.

Восемнадцатый раунд ревью:

- **Дедлок Web Lock.** Discard больше не берёт внешний `withKeyLock` (внутри он вызывает `clearLocalKeys`/`ensureAccountKeys` с тем же именем); recovery не зависает в браузере.
- **Легаси v2.** `UpdateUserMasterKey` разрешает замену ключа при равной версии, если `identity_public_key` пуст — v2-аккаунт можно обновить без дропа БД.
- **Destructive recovery.** Decline с явным подтверждением получает `allowIdentityRollback` и удаляет серверный бэкап по серверной версии; тупик «забыл PIN и пароль» закрыт.
- **Server passkey.** Перед записью выполняется вторая PRF-ассерция и проверка блоба.
- **Мелочи.** Online-обработчик гейта отменяется при размонтировании и сбрасывает `required`; документация/локали синхронизированы.

Девятнадцатый раунд ревью:

- **Смена аккаунта в RecoveryModal.** Окно сбрасывается при смене `activeToken`, все хендлеры проверяют, что токен всё ещё активен.
- **Текст подтверждения.** «Начать заново» с локальной identity показывает отдельное предупреждение об удалении серверного бэкапа/истории, а не подпись кнопки.
- **Забыл PIN.** `stale`/`legacy` всегда дают предупреждение об устаревшем бэкапе, даже если есть passkey-обёртка.
- **Форма бэкапа.** Пароль/подтверждение очищаются при каждом открытии.
- **SDK.** Callback-ответ выбирает шифрование по режиму бота (`requireMode`/`_require_mode`), а не по наличию ключа.
- **Федерация.** Истёкший pubkey-кэш перезапрашивает well-known, поэтому обновившийся пир перестаёт навсегда считаться v1.

Осознанно не делалось:

- Автоматическая фоновая ротация и массовая перешифровка истории.
- Pubkey-кэш живёт 5 минут. Ручную ротацию бота в этом окне могут не увидеть отправители; у людей спасает история ключей, у ботов истории нет — рекомендация ротировать бота в простое.
- Клиент не перепроверяет `publicKeyUploaded` при старте; если публичный ключ потерян на сервере, он восстановится при следующей ротации/переустановке, а не фоновым аудитом.
- Публичный ключ получателя не заверен его identity на уровне протокола: сервер раздаёт ключи, и его компрометация может подменить ключ получателя. Это зафиксировано в модели угроз README (TOFU защищает отправителя, не сервер).
- Заголовок `X-Federation-Protocol` не входит в подпись запроса: MITM может его снять и получить 401 (DoS), но не подделать содержимое.
- 6-значный PIN остаётся компромиссом UX/энтропии: PBKDF2 310k и отсутствие офлайн-лимита попыток означают, что PIN защищает от случайного доступа, а не от целевого перебора дампа IndexedDB.
- Смена identity без старого приватного ключа криптографически не может быть подтверждена цепочкой. «Начать заново» на новом устройстве предупреждает об этом; автоматического UI «доверять новому ключу контакта» пока нет — контакту нужен явный сброс пина (очистка локальных данных/переустановка).
- Обязательный бэкап-гейт реализован на уровне UI: `encryptForChat` не делает сетевую проверку бэкапа на каждое сообщение, поэтому в окне до открытия модалки отправка технически возможна.
- Квоты файлов и остальные пункты из списка ниже, требующие решения.
- Старую БД и IndexedDB нужно дропнуть вручную: формат v3 несовместим.

## Проверки на итоговом дереве (2026-11-26)

- `make lint`: backend `golangci-lint` — 0 issues; frontend biome/eslint — 0 ошибок, 33 задокументированных `react-hooks/set-state-in-effect`.
- `make test`: exit 0; backend `go test -race ./...` — все пакеты; frontend 101 файл / 784 теста; TypeScript SDK и Python SDK зелёные; unhandled rejections нет.
- `make frontend:e2e`: 11 passed.
- `git diff --check`: чисто.
- Коммит и пуш не выполнялись (по `AGENTS.md`).
