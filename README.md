# Fast Chat Go React

Минималистичный мессенджер с федеративной архитектурой (как email). Go-бэкенд + React-фронтенд, real-time через SSE.

## Быстрый старт

```bash
make backend:run    # Go сервер на :8080
make frontend:run   # Vite dev-сервер на :5173
```

Открыть `http://localhost:5173`, зарегистрироваться по email с кодом подтверждения — готово.

## Стек

**Бэкенд:** Go 1.26, `net/http` (без сторонних роутеров), GORM + SQLite, SSE для реалтайма.

**Фронтенд:** React 19 + Mantine v9 + TanStack Router (file-based) + Tailwind v4 + react-i18next.

## Архитектура

### Федерация (nick:domain)

Пользователь регистрируется как `alice:localhost:8080`. Сервер автоматически дописывает домен при регистрации.

**Поиск удалённого пользователя:** ввести `bob:other.com` в строку поиска — запрос уходит на свой сервер, тот проксирует на `other.com`.

**Создание чата / отправка:** клиент всегда общается со своим сервером. Сервер дублирует действия на удалённый сервер по HTTP (создание чата, отправка/редактирование/удаление сообщений).

**Федеративные эндпоинты** (`/api/federated/*`) — без авторизации, вызов только между серверами.

### Чаты: приватные и групповые

Поддерживаются два типа:

- **Private** — чат между двумя пользователями, уникальный для пары (для той же пары всегда возвращается существующий).
- **Group** — чат с 3+ участниками, названием, владельцем (owner) и аватаркой. Групповые чаты с одинаковым составом **не уникальны** — можно создавать сколько угодно.

Группы создаются через `POST /api/chats` с payload `{type: "group", name, memberIds}`. **Создатель автоматически добавляется как owner** — указывать себя в `memberIds` не нужно. Минимальный состав — 1 (только owner); остальные добавляются позже через `POST /api/chats/{id}/members`. Все участники должны быть зарегистрированы на одном сервере (федеративные группы для MVP не поддерживаются). Владелец может переименовывать чат, добавлять/удалять участников, менять аватарку, удалять чат. Любой участник (кроме владельца) может выйти. Удаление/leave последнего участника запрещено — только `DELETE /api/chats/{id}` от владельца.

### Реалтайм (SSE)

- Каждый клиент держит SSE-соединение со своим сервером.
- Сервер отправляет события: `new_message`, `message_updated`, `message_deleted`, `chat_created`, `chat_updated`, `chat_deleted`, `chat_member_added`, `chat_member_removed`, `thread_created`, `thread_message_new`, `thread_message_updated`, `typing`, `typing_stop`.
- Heartbeat каждые 30 секунд.

### API

| Метод | Путь | Auth | Описание |
|---|---|---|---|---|
| `GET` | `/api/config` | нет | TTL редактирования/удаления |
| `POST` | `/api/auth/send-code` | нет | Отправить код на email |
| `POST` | `/api/auth/verify-code` | нет | Подтвердить код, получить временный токен |
| `POST` | `/api/auth/complete-registration` | Bearer | Завершить регистрацию (`{ nick }`) |
| `POST` | `/api/auth/sse-auth` | Bearer | Аутентифицировать SSE-соединение |
| `GET` | `/api/events` | sse-auth | SSE-поток |
| `GET` | `/api/users/search` | Bearer | Поиск пользователей (локальный или федеративный) |
| `GET` | `/api/chats` | Bearer | Список чатов |
| `POST` | `/api/chats` | Bearer | Создать чат (`{withUserId}` приватный, `{type:"group",name,memberIds}` групповой) |
| `GET` | `/api/chats/{id}` | Bearer | Метаданные чата (только для участников) |
| `PATCH` | `/api/chats/{id}` | Bearer | Обновить название (только owner группы) |
| `DELETE` | `/api/chats/{id}` | Bearer | Удалить группу (только owner) |
| `POST` | `/api/chats/{id}/members` | Bearer | Добавить участника (только owner) |
| `DELETE` | `/api/chats/{id}/members/{userId}` | Bearer | Удалить/leave (owner или сам) |
| `POST` | `/api/chats/{id}/avatar` | Bearer | Загрузить аватар (только owner) |
| `GET` | `/api/chats/{id}/messages` | Bearer | Сообщения чата (с пагинацией) |
| `POST` | `/api/chats/{id}/messages` | Bearer | Отправить сообщение |
| `PATCH` | `/api/chats/{id}/messages/{mid}` | Bearer | Редактировать |
| `DELETE` | `/api/chats/{id}/messages/{mid}` | Bearer | Удалить |
| `POST` | `/api/chats/{id}/messages/{mid}/thread` | Bearer | Создать/отправить в тред |
| `GET` | `/api/chats/{id}/threads/{tid}/messages` | Bearer | Сообщения треда (с пагинацией) |
| `PATCH` | `/api/chats/{id}/messages/{mid}` | Bearer | Редактировать сообщение (включая тред с `?threadId=`) |
| `DELETE` | `/api/chats/{id}/messages/{mid}` | Bearer | Удалить сообщение (включая тред с `?threadId=`) |
| `GET` | `/api/sync` | Bearer | Инкрементальная синхронизация (`?since=`) |
| `GET` | `/api/push/vapid-public-key` | нет | VAPID публичный ключ для WebPush |
| `POST` | `/api/push/subscribe` | Bearer | Подписаться на push-уведомления |
| `DELETE` | `/api/push/subscribe` | Bearer | Отписаться от push-уведомлений |

**Федеративные (сервер-сервер):**

| Метод | Путь |
|---|---|
| `GET` | `/api/federated/users/search` |
| `POST` | `/api/federated/chats` |
| `POST` | `/api/federated/chats/{id}/messages` |
| `PATCH` | `/api/federated/chats/{id}/messages/{mid}` |
| `DELETE` | `/api/federated/chats/{id}/messages/{mid}` |

## Тестирование федерации

Два инстанса:

```bash
# Терминал 1 (alice@localhost:8080)
make backend:run
make frontend:run

# Терминал 2 (bob@localhost:8081)
make backend:run BACKEND_PORT=8081 SERVER_DOMAIN=localhost:8081
make frontend:run FRONTEND_PORT=5174 API_PROXY=http://localhost:8081
```

1. Зарегистрировать `alice` на `:5173`, `bob` на `:5174`.
2. На `:5173` найти `bob:localhost:8081`.
3. Создать чат — сообщения синхронизируются между серверами.

## PWA / Offline-first

Приложение работает как PWA: Service Worker (injectManifest) с workbox кэширует API-запросы
(NetworkFirst) и файлы (CacheFirst). В production-сборке SW регистрируется автоматически;
в dev-режиме (`npm run dev`) включён через `devOptions.enabled: true`.

**Offline-first:**
- Сообщения, файлы и треды сохраняются в IndexedDB
- Отправка через outbox: при офлайне сообщение ставится в очередь и отправляется при восстановлении соединения
- Можно отменить отправку (cancel-send) для сообщений в очереди
- Авто-повтор неудачных отправок при реконнекте

## WebPush

Push-уведомления для офлайн-пользователей. VAPID-ключи генерируются автоматически
при первом запуске (хранятся в `push.key_path`, по умолчанию `./keys`).

**Сценарий:**
1. Пользователь логинится → браузер запрашивает разрешение на уведомления
2. Браузер подписывается → endpoint сохраняется на сервере (`POST /api/push/subscribe`)
3. При отправке сообщения сервер проверяет, онлайн ли получатель
4. Если получатель офлайн — отправляет push через его браузерный push-сервис
5. При клике на уведомление открывается чат (или фокусируется существующее окно)

**Триггеры:** `new_message` и `thread_message_new`. Push отправляется только не-отправителю,
только если получатель офлайн.

## Конфигурация

Переменные окружения (backend):

| Переменная | По умолчанию | Описание |
|---|---|---|
| `PORT` | `8080` | Порт сервера |
| `SERVER_DOMAIN` | `localhost:8080` | Домен для federation ID |
| `MESSAGE_EDIT_TTL` | `300` | Секунд для редактирования (0=всегда, <0=никогда) |
| `MESSAGE_DELETE_TTL` | `0` | Секунд для удаления |
| `PUSH_KEY_PATH` | `./keys` | Путь к директории с VAPID-ключами |

Переменные для фронта (dev):

| Переменная | По умолчанию | Описание |
|---|---|---|
| `VITE_API_PROXY` | `http://localhost:8080` | Адрес бэкенда для Vite proxy |

## Форматирование и линт

```bash
make backend:lint
make frontend:lint
make frontend:format
```
