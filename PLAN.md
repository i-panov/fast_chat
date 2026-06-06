# План рефакторинга бэкенда `fast_chat`

## Цели

1. **Безопасность federation на prod-уровне.**
2. **Корректность и устранение race conditions.**
3. **Производительность БД (убираем N+1).**
4. **Структура кода и тесты.**

## Принципы

- Каждый этап — самостоятельный коммит с зелёным `golangci-lint` и тестами.
- Минимум публичных API-изменений (фронт не должен ломаться).
- Линт и тесты после каждого этапа: `~/go/bin/golangci-lint run ./...` и `go test -race ./...`.

---

## Этап 1 — P0 безопасность: токены и базовая защита

**Цель:** устранить утечки токенов и XSS на отдаче файлов.

### 1.1. Скрыть `Token` от любых API-ответов кроме `/api/register`

**Проблема:** `model.User` сериализуется в JSON-ответы `/api/users/search`, `/api/federated/users/search` с непустым полем `Token`. Тег `omitempty` не помогает — поле никогда не zero.

**Решение:**
- Ввести `model.PublicUser` (без `Token`):
  ```go
  type PublicUser struct {
      ID     string `json:"id"`
      Nick   string `json:"nick"`
      Online bool   `json:"online"`
  }
  func (u *User) Public() PublicUser { ... }
  ```
- В `handler.SearchUsers` и `FederatedSearchUsers` мапить `[]User` → `[]PublicUser`.
- В `Register` отдавать `{ user: PublicUser, token: string }` (не менять API — структура та же, просто Token не дублируется).
- Удалить `Token` из JSON-тега в `User` или поставить `json:"-"` (вариант: оставить структуру для БД, но никогда не сериализовать).

**Файлы:** `model/types.go`, `handler/handler.go` (3 места).

**Тесты:** добавить регрессионный — `TestSearchUsersDoesNotLeakToken`.

### 1.2. XSS-защита `ServeFile`

**Проблема:** `Content-Disposition: inline` + любой `Content-Type` от клиента → можно загрузить `.html` и получить XSS на том же origin.

**Решение:**
- При сохранении: переопределять `Content-Type` через `http.DetectContentType` от первых 512 байт (не доверять заголовку клиента).
- Whitelist для `inline`: `image/*`, `video/*`, `audio/*`, `application/pdf`. Остальное — `attachment`.
- Всегда ставить `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'`.
- В имени файла на диске не использовать клиентское расширение (только UUID).

**Файлы:** `handler/handler.go` (`UploadFile`, `ServeFile`).

**Тесты:** `TestServeFileForcesAttachmentForHTML`, `TestUploadFileSanitizesContentType`.

### 1.3. Уменьшить rate-limit для `/api/register`

**Решение:** отдельный `rateLimiter` для `/api/register` (например, 5 регистраций с одного IP за 10 минут).

**Файлы:** `main.go`.

### 1.4. Защита `X-Forwarded-For` (опционально, документировать)

**Решение:** в `rateLimiter.allow(ip)` опционально учитывать `X-Forwarded-For` при наличии `TRUST_PROXY` env var.

---

## Этап 2 — P0 безопасность federation: server-binding, replay, авторизация

**Цель:** federation становится prod-готовой.

### 2.1. Подпись покрывает `X-Federation-Server`

**Решение:** в `Sign`/`Verify` добавить `serverDomain` в payload:
```go
data := serverDomain + "\n" + method + "\n" + requestURI + "\n" + body + "\n" + timestamp
```
- Обе стороны должны обновиться синхронно — **breaking change для federation**, но проект on solo, так что норм.

**Файлы:** `federation/federation.go` (`Sign`, `Verify`), `handler.go` (`doFederatedRequest`).

### 2.2. Replay-защита

**Решение:**
- В `federation.Manager` добавить `seenNonces sync.Map` с `key = serverDomain + ":" + signature`, TTL 10 минут (то есть >> 5-минутного окна).
- В `Verify` после успешной проверки подписи — проверять и записывать nonce. Если уже видели — `false`.
- Очистка старых nonce через ticker (как у `rateLimiter`).

**Файлы:** `federation/federation.go`.

**Тесты:** `TestVerifyRejectsReplay`.

### 2.3. Авторизация: federation handler должен проверять источник

**Решение:** добавить хелпер:
```go
func (h *Handler) authorizeFederatedSource(chat *model.Chat, r *http.Request) bool {
    return chat.RemoteServer != "" && chat.RemoteServer == r.Header.Get("X-Federation-Server")
}
```
- Применить в `FederatedSendMessage`, `FederatedEditMessage`, `FederatedEditThreadMessage`, `FederatedDeleteMessage`. `FederatedHandleTyping` уже это делает.

**Файлы:** `handler/handler.go` (5 хендлеров).

### 2.4. `FederatedEditMessage` / `FederatedDeleteMessage` — проверка авторства FromID

**Решение:** перед `EditRawMessage`/`DeleteRawMessage` — загрузить существующее сообщение, проверить `msg.FromID` принадлежит серверу `X-Federation-Server` (т.е. ID заканчивается на `:domain`).

**Файлы:** `handler/handler.go`.

### 2.5. `FederatedCreateChat` проверки

**Решение:** убедиться, что один из членов чата принадлежит `X-Federation-Server`, другой — нашему. Сейчас проверка только `len(Members) != 2`.

**Файлы:** `handler/handler.go:1266`.

### 2.6. `FederatedSearchUsers` (опционально) — требовать federation auth

**Уже есть** — обёрнут в `fedAuth` (`main.go:198`), ок. Только убедиться, что после 1.1 токены не утекают.

### 2.7. Тесты federation

**Файл:** `federation/federation_test.go` (новый).
- `TestSignVerifyRoundtrip`
- `TestVerifyRejectsWrongServer`
- `TestVerifyRejectsExpiredTimestamp`
- `TestVerifyRejectsReplay`
- `TestPublicKeyPEMRoundtrip`
- `TestFetchWellKnownTimeout`
- `TestParsePublicKeyPEMBadInput`

**Интеграционные** в `handler/handler_test.go`:
- Поднимать два `Handler`-а с разными ключами, делать federated-запросы между ними.
- `TestFederatedSendMessageRejectsForeignChat`
- `TestFederatedEditMessageRejectsForeignAuthor`

---

## Этап 3 — P1 корректность: idempotency, races, мелкие баги

### 3.1. `AddRawMessage` идемпотентность

**Решение:** `tx.Clauses(clause.OnConflict{DoNothing: true}).Create(msg)`. Если не вставили — вернуть nil без ошибки.

**Файлы:** `store/store.go:554`.

### 3.2. Race в `Add/RemoveConnection`

**Решение:** перенести БД-UPDATE под общий мьютекс (плохо, БД медленная), либо использовать атомарный сериализатор:
- Простейшее: оставить inc/dec под мьютексом, а БД-UPDATE — только при transition 0↔1, под отдельной generation-блокировкой.
- Альтернатива: вместо `online bool` в БД — считать online по `len(conns) > 0` в памяти, отдавать через API.

**Решение, рекомендуемое:** убрать `online` из БД, держать в памяти. При старте все офлайн, при коннекте `AddConnection` — сразу онлайн.

**Файлы:** `store/store.go`, `model/types.go`.

### 3.3. `lastTyping sync.Map` cleanup

**Решение:** в `NewSSEHub` запускать горутину-чистильщик (раз в 5 минут вычищать записи старше 30 секунд).

**Файлы:** `handler/handler.go:53`.

### 3.4. `Register`: проверка длины ника по runes

**Решение:** `utf8.RuneCountInString(req.Nick) > 20`.

**Файлы:** `handler/handler.go:320`.

### 3.5. `SearchUsers`: требовать минимум 2 символа

**Файлы:** `handler/handler.go`, `store/store.go`.

### 3.6. `Sign` возвращает ошибку

**Решение:** изменить сигнатуру на `Sign(...) (string, error)`. Caller `doFederatedRequest` пробрасывает ошибку. Хендлеры — логируют и идут дальше (как сейчас).

**Файлы:** `federation/federation.go`, `handler/handler.go`.

### 3.7. `FederatedSendMessage` reply lookup через `GetMessage` вместо `GetMessages`

**Файлы:** `handler/handler.go:1355` → использовать `s.GetMessage(chatID, replyToID)`.

### 3.8. `UploadFile`: атомарность (БД-запись → файл)

**Решение:** сначала записать файл в `tempDir + uuid`, потом транзакционно `SaveFile` + `os.Rename`. Если rename упал — откатить БД (или наоборот). Для SQLite + локальной ФС: проще писать всё во временную таблицу + temp file, потом fsync + rename, потом commit БД. Существенный рефактор `UploadFile`.

**Файлы:** `handler/handler.go:1096`.

### 3.9. `copyFile` + `fsync`

**Решение:** после `io.Copy` — `dst.Sync()` перед `Close`.

**Файлы:** `handler/handler.go:1224`.

---

## Этап 4 — P1 производительность: убрать N+1

### 4.1. `GetUserChats` — батчевая загрузка членов

**Решение:** заменить цикл-по-чатам на один JOIN или один `WHERE chat_id IN (...)`:
```go
var allMembers []ChatMember
s.db.Where("chat_id IN ?", chatIDs).Find(&allMembers)
membersByChat := make(map[string][]string)
for _, m := range allMembers { membersByChat[m.ChatID] = append(...) }
```

**Файлы:** `store/store.go:355`.

### 4.2. `enrichChat` — батчевая загрузка ников

**Решение:** перед мапингом всех чатов — один `WHERE id IN (allMemberIDs)`. Передать карту `userID → User` в `enrichChat`.
- Меняет сигнатуру `enrichChat`, придётся обновить вызовы.

**Файлы:** `handler/handler.go:146`, все вызывающие места.

### 4.3. `GetMessages` — батчевая загрузка файлов

**Решение:** `GetMessageFilesBatch(messageIDs []string) map[string][]FileInfo`. Один запрос к `message_files`, один — к `files`. Раздать по messageID.

**Файлы:** `store/store.go`, `handler/handler.go:899-902`.

### 4.4. Индексы

**Добавить:**
- `ChatMember.UserID` — добавить через тег `gorm:"index"`.
- `MessageFile.FileID` — добавить.
- `Thread (ChatID, ParentMessageID)` — composite.

**Файлы:** `store/db.go` (через GORM теги в `model` / `store.ChatMember`).

### 4.5. `paginateMessages` — убрать `Count` через `limit+1`

**Файлы:** `store/store.go:711`.

### 4.6. `SetMessageFiles` — batch INSERT

**Файлы:** `store/store.go:489`.

### 4.7. Бенчмарки (optional)

**Файлы:** `store/store_bench_test.go`. Базовые бенчмарки на `GetUserChats` с 50 чатами, `GetMessages` с 500 сообщениями.

---

## Этап 5 — P2 структура кода: разнести файлы, хелперы

### 5.1. Разбить `handler/handler.go`

Новая структура:
```
handler/
├── handler.go          // Handler struct, New, утилиты (writeJSON, writeError, decodeBody, getUser, isMember, isOwner, validCoords, parseLocationPatch, generateID)
├── middleware.go        // AuthMiddleware, FederatedAuthMiddleware
├── chats.go            // GetChats, CreateChat, GetChat, UpdateChat, DeleteChat, AddChatMember, RemoveChatMember, UpdateChatAvatar
├── messages.go         // GetMessages, SendMessage, EditMessage, DeleteMessage
├── threads.go          // CreateThread, GetThreads, GetThreadMessages, SendThreadMessage, EditThreadMessage
├── files.go            // UploadFile, ServeFile, userCanAccessFile, copyFile
├── typing.go           // HandleTyping
├── sse.go              // SSE, SSEHub, SSEEvent
├── federated.go        // FederatedSearchUsers, FederatedCreateChat, FederatedSendMessage, FederatedEditMessage, FederatedEditThreadMessage, FederatedDeleteMessage, FederatedHandleTyping
├── users.go            // Register, SearchUsers, searchFederated, GetConfig
├── enrich.go           // chatResponse, memberInfo, enrichChat
└── handler_test.go     // (или разнести по соответствующим)
```

**Без изменения public API** — только перемещение функций.

### 5.2. Разбить `store/store.go`

```
store/
├── store.go        // Store, New, DB, Close, generateID, errors
├── user.go         // CreateUser, GetUserByToken, GetUserByID, SearchUsers, AddConnection, RemoveConnection
├── chat.go         // CreateChat, CreateGroupChat, AddChatMember, RemoveChatMember, UpdateChatName, UpdateChatAvatar, GetChatsByAvatarFileID, DeleteChat, GetUserChats, GetChat, CreateRemoteChat
├── message.go      // GetMessage, AddMessage, AddRawMessage, GetMessages, GetMessagesPaginated, DeleteMessage, EditMessage, EditRawMessage, DeleteRawMessage, paginateMessages
├── thread.go       // CreateThread, GetThread, GetThreadByParentMessage, GetThreadsForChat, GetThreadMessagesPaginated, AddThreadMessage, EditThreadMessage
├── file.go         // SaveFile, FindFileByHash, GetFile, AddMessageFiles, SetMessageFiles, GetMessageFiles, GetMessageFilesForReply, GetFileChats
├── db.go           // InitDB, ChatMember
└── *_test.go       // соответственно
```

### 5.3. Хелперы в `handler/`

```go
func writeError(w http.ResponseWriter, status int, msg string)
func decodeBody(r *http.Request, v interface{}) error
func requireMember(h, r) (*model.Chat, *model.User, bool) // вернёт chat или 404/403
func requireOwner(h, r) (*model.Chat, *model.User, bool)
```
Убрать дубли `defer r.Body.Close()`, дубли проверок member/owner в каждом хендлере.

### 5.4. Убрать дубли утилит

- `generateID()` — один в `store/`, удалить из `handler/`.
- `writeJSON()` — один общий в новый пакет `internal/httpx` или в `handler/`, удалить из `federation/`.
- `model.Chat.Members nil` → `make([]string, 0)` в местах создания.

### 5.5. Magic numbers в константы

`maxUploadSize`, `defaultPageSize`, `maxPageSize`, `sseChannelBuffer`, `typingThrottleInterval`, `federationCacheTTL`, `federationTimestampWindow` — все в config или константы пакета.

---

## Этап 6 — P2 тесты: federation, SSE, rateLimiter, UploadFile

### 6.1. `federation/federation_test.go` (см. 2.7)

### 6.2. `handler/sse_test.go` (новый)

- `TestSSEHubSubscribeSend`
- `TestSSEHubUnsubscribeClosesChannel`
- `TestSSEHubChannelFullDoesNotPanic`
- `TestSSEHandlerHeartbeat`
- `TestSSEHandlerSendsEvent`

### 6.3. `main_test.go` (новый, в пакете main)

- `TestRateLimiterAllowsUnderLimit`
- `TestRateLimiterBlocksOverLimit`
- `TestRateLimiterResetAfterWindow`
- `TestRateLimiterCleanup`

### 6.4. `handler/files_test.go` (новый)

- `TestUploadFileDeduplicatesByHash`
- `TestUploadFileRejectsTooLarge`
- `TestServeFileRequiresMember`
- `TestServeFileForcesAttachmentForHTML`

### 6.5. Race detector в CI

Добавить в `Makefile`:
```
backend\:test:
	cd backend && go test -race ./...
```

---

## Этап 7 — P3 косметика и улучшения (OPTIONAL)

- `interface{}` → `any`.
- `errResp` struct вместо `map[string]string`.
- Structured logging через `log/slog` (есть в std с 1.21).
- OpenTelemetry (опционально).
- Метрики (prometheus middleware).
- API-документация (Swagger или просто docs/api.md).
- Контейнеризация (Dockerfile) — если нужно.

---

## Порядок выполнения и ожидаемый размер

| Этап | Тема | Размер | Зависит от |
|-----|------|--------|------------|
| 1 | P0 базовая безопасность (токены, XSS) | ~4ч | — |
| 2 | P0 federation prod-safety | ~8ч | 1 |
| 3 | P1 корректность и races | ~4ч | — |
| 4 | P1 производительность БД | ~8ч | — |
| 5 | P2 структура кода | ~6ч | 1-4 (чтобы не было конфликтов) |
| 6 | P2 тесты | ~4ч | 1-5 |
| 7 | P3 косметика | ~? | по желанию |

**Итого:** ~30-40 часов работы.

После каждого этапа:
```bash
cd backend
~/go/bin/golangci-lint run ./...
go test -race ./...
```

---

## Риски и open questions

1. **Breaking changes для federation после Этапа 2.** Подпись и поля меняются — два сервера в смешанной версии не понимают друг друга. На solo-проде это норм, но стоит зафиксировать в CHANGELOG.
2. **`model.User.Online`** — убираем из БД (Этап 3.2). Это потенциально ломает любые внешние интеграции, читающие БД напрямую (вряд ли есть).
3. **GORM `OnConflict` для SQLite** — поддерживается ли в текущей версии? Надо проверить `gorm.io/gorm v1.31.1` + `gorm.io/driver/sqlite v1.6.0`.
4. **`AvatarFileID json:"-"`** — фронт получает только `AvatarURL`. Хорошо, не трогаем.
5. **MaxOpenConns=1 для SQLite** — на проде с реальной нагрузкой это bottleneck. Возможно, переходить на PostgreSQL? Это выходит за рамки этого плана, отдельный разговор.

---

## Текущий статус

- [ ] Этап 1 — P0 безопасность: токены и базовая защита
  - [ ] 1.1. Скрыть `Token` в API-ответах
  - [ ] 1.2. XSS-защита `ServeFile`
  - [ ] 1.3. Уменьшить rate-limit для `/api/register`
  - [ ] 1.4. `X-Forwarded-For` (опционально)
- [x] Этап 2 — P0 безопасность federation
- [x] Этап 3 — P1 корректность
- [ ] Этап 3 — P1 корректность и races
- [ ] Этап 4 — P1 производительность БД
- [ ] Этап 5 — P2 структура кода
- [ ] Этап 6 — P2 тесты
- [ ] Этап 7 — P3 косметика
