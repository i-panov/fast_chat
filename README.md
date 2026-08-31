# Fast Chat

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

| Метод   | Путь | Auth | Описание |
|---------|------|------|----------|
| `GET`   | `/api/config` | нет | TTL редактирования/удаления |
| `GET`   | `/healthz` | нет | Liveness probe |
| `GET`   | `/readyz` | нет | Readiness probe (DB) |
| `POST`  | `/api/auth/send-code` | нет | Отправить код на email |
| `POST`  | `/api/auth/verify-code` | нет | Подтвердить код, получить временный токен |
| `POST`  | `/api/auth/complete-registration` | Bearer | Завершить регистрацию (`{ nick }`) |
| `POST`  | `/api/auth/sse-auth` | Bearer | Аутентифицировать SSE-соединение |
| `POST`  | `/api/auth/refresh-token` | Bearer | Обновить access-токен |
| `GET`   | `/api/events` | sse-auth | SSE-поток |
| `GET`   | `/api/users/search` | Bearer | Поиск пользователей (локальный или федеративный) |
| `PUT`   | `/api/users/public-key` | Bearer | Загрузить свой публичный ключ |
| `GET`   | `/api/users/{userId}/public-key` | Bearer | Получить публичный ключ пользователя |
| `PUT`   | `/api/users/key-backup` | Bearer | Сохранить бэкап ключей |
| `GET`   | `/api/users/key-backup` | Bearer | Получить бэкап ключей |
| `DELETE`| `/api/users/key-backup` | Bearer | Удалить бэкап ключей |
| `GET`   | `/api/chats` | Bearer | Список чатов |
| `GET`   | `/api/sync` | Bearer | Инкрементальная синхронизация (`?since=`) |
| `POST`  | `/api/chats` | Bearer | Создать чат (`{withUserId}` приватный, `{type:"group",name,memberIds}` групповой) |
| `GET`   | `/api/chats/{id}` | Bearer | Метаданные чата (только для участников) |
| `PATCH` | `/api/chats/{id}` | Bearer | Обновить название (только owner группы) |
| `DELETE`| `/api/chats/{id}` | Bearer | Удалить группу (только owner) |
| `POST`  | `/api/chats/{id}/members` | Bearer | Добавить участника (только owner) |
| `DELETE`| `/api/chats/{id}/members/{userId}` | Bearer | Удалить/leave (owner или сам) |
| `POST`  | `/api/chats/{id}/avatar` | Bearer | Загрузить аватар (только owner) |
| `GET`   | `/api/chats/{id}/messages` | Bearer | Сообщения чата (с пагинацией) |
| `POST`  | `/api/chats/{id}/messages` | Bearer | Отправить сообщение |
| `PATCH` | `/api/chats/{id}/messages/{mid}` | Bearer | Редактировать |
| `DELETE`| `/api/chats/{id}/messages/{mid}` | Bearer | Удалить |
| `POST`  | `/api/messages/read` | Bearer | Отметить сообщения как прочитанные |
| `POST`  | `/api/chats/{id}/messages/{mid}/thread` | Bearer | Создать/отправить в тред |
| `GET`   | `/api/chats/{id}/threads` | Bearer | Список тредов чата |
| `GET`   | `/api/chats/{id}/threads/{tid}/messages` | Bearer | Сообщения треда (с пагинацией) |
| `POST`  | `/api/chats/{id}/threads/{tid}/messages` | Bearer | Отправить сообщение в тред |
| `PATCH` | `/api/chats/{id}/threads/{tid}/messages/{mid}` | Bearer | Редактировать сообщение в треде |
| `POST`  | `/api/files/upload` | Bearer | Загрузить файл |
| `GET`   | `/api/files/{fileId}` | Bearer | Скачать файл |
| `POST`  | `/api/chats/{id}/typing` | Bearer | Отправить событие набора текста |
| `GET`   | `/api/push/vapid-public-key` | нет | VAPID публичный ключ для WebPush |
| `POST`  | `/api/push/subscribe` | Bearer | Подписаться на push-уведомления |

**Федеративные (сервер-сервер):**

| Метод   | Путь |
|---------|------|
| `GET`   | `/api/federated/users/search` |
| `GET`   | `/api/federated/users/{userId}/public-key` |
| `POST`  | `/api/federated/chats` |
| `POST`  | `/api/federated/chats/{id}/messages` |
| `PATCH` | `/api/federated/chats/{id}/messages/{mid}` |
| `PATCH` | `/api/federated/chats/{id}/threads/{tid}/messages/{mid}` |
| `DELETE`| `/api/federated/chats/{id}/messages/{mid}` |
| `POST`  | `/api/federated/chats/{id}/typing` |
| `GET`   | `/api/federated/sync` |
| `GET`   | `/.well-known/fast-chat` |

## Наблюдаемость

### Health probes

- `GET /healthz` — liveness probe (всегда 200, процесс жив).
- `GET /readyz` — readiness probe (проверяет DB, 503 если недоступна).

Используются оркестраторами (k8s, Docker) для проверки состояния.

### Request logging

Каждый HTTP-запрос логируется через `slog` с полями: `method`, `path`, `status`, `duration`, `remote_addr`, `request_id`. Уровень `Info` для успешных (<400), `Warn` для ошибок.

### Request ID

Сервер принимает/генерирует `X-Request-ID` и:
- возвращает его в response headers;
- пробрасывает во все логи запроса;
- передаёт в федеративные запросы для сквозной трассировки между серверами.

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

Приложение работает как PWA: Service Worker (injectManifest) с workbox кэширует API-запросы (NetworkFirst) и файлы (CacheFirst). В production-сборке SW регистрируется автоматически; в dev-режиме отключён (`devOptions.enabled: false`).

**Offline-first:**
- Сообщения, файлы и треды сохраняются в IndexedDB.
- Отправка через outbox: при офлайне сообщение ставится в очередь и отправляется при восстановлении соединения.
- Можно отменить отправку (cancel-send) для сообщений в очереди.
- Авто-повтор неудачных отправок при реконнекте.

## WebPush

Push-уведомления для офлайн-пользователей. VAPID-ключи генерируются автоматически при первом запуске (хранятся в `push.key_path`, по умолчанию `./keys`).

**Сценарий:**
1. Пользователь логинится → браузер запрашивает разрешение на уведомления.
2. Браузер подписывается → endpoint сохраняется на сервере (`POST /api/push/subscribe`).
3. При отправке сообщения сервер проверяет, онлайн ли получатель.
4. Если получатель офлайн — отправляет push через его браузерный push-сервис.
5. При клике на уведомление открывается чат (или фокусируется существующее окно).

**Триггеры:** `new_message` и `thread_message_new`. Push отправляется только не-отправителю, только если получатель офлайн.

## Конфигурация

Бэкенд читает YAML-конфигурацию из файла, переданного через `--config`.

Пример для production: `config/prod.yaml.example` (скопировать в `config/prod.yaml` и заполнить).

### Основные параметры

| Параметр YAML | По умолчанию | Описание |
|---------------|--------------|----------|
| `server.host` | `localhost` | Адрес для бинда |
| `server.port` | `8080` | Порт сервера |
| `server.static_dir` | `../frontend/dist` | Путь к собранному фронтенду |
| `database.path` | — (required) | Путь к SQLite файлу |
| `cors.origin` | — | Разрешённый origin для CORS |
| `federation.scheme` | `http` | Протокол для федерации (`http`/`https`) |
| `federation.timeout` | `10` | Таймаут федеративных запросов (сек) |
| `auth.token_expiry` | `24h` | Время жизни JWT токена |
| `auth.token_expiry_warning` | `5m` | Когда предупреждать об истечении |
| `email.debug_mode` | `true` | `true` = писать письма в логи, `false` = отправлять через SMTP |
| `push.vapid_subject` | — | VAPID subject (обычно `mailto:`) |

Переменные окружения для фронта (dev):

| Переменная | По умолчанию | Описание |
|------------|--------------|----------|
| `VITE_API_PROXY` | `http://localhost:8080` | Адрес бэкенда для Vite proxy |

## Сборка и линт

```bash
make build              # Собрать бэкенд + фронтенд
make lint               # Линты (backend + frontend)
make test               # Тесты (backend + frontend)
make coverage           # Покрытие тестами
make dead-code          # Поиск неиспользуемого кода (knip)
make frontend:size      # Проверка размера бандла (size-limit)
```

### Статический анализ

```bash
make analyze            # Semgrep (security + best-practice)
make analyze:deep       # Полный semgrep-скан
make codeql             # CodeQL анализ (требует CodeQL CLI)
```

## Автоматизация

- **Dependabot** (`.github/dependabot.yml`) — еженедельные обновления зависимостей (Go + npm).
