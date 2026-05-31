# Fast Chat Go React

Минималистичный мессенджер с федеративной архитектурой (как email). Go-бэкенд + React-фронтенд, real-time через SSE.

## Быстрый старт

```bash
make backend:run    # Go сервер на :8080
make frontend:run   # Vite dev-сервер на :5173
```

Открыть `http://localhost:5173`, ввести ник — готово.

## Стек

**Бэкенд:** Go 1.26, `net/http` (без сторонних роутеров), in-memory store, SSE для реалтайма.

**Фронтенд:** React 19 + Mantine v9 + TanStack Router (file-based) + Tailwind v4 + react-i18next.

## Архитектура

### Федерация (nick:domain)

Пользователь регистрируется как `alice:localhost:8080`. Сервер автоматически дописывает домен при регистрации.

**Поиск удалённого пользователя:** ввести `bob:other.com` в строку поиска — запрос уходит на свой сервер, тот проксирует на `other.com`.

**Создание чата / отправка:** клиент всегда общается со своим сервером. Сервер дублирует действия на удалённый сервер по HTTP (создание чата, отправка/редактирование/удаление сообщений).

**Федеративные эндпоинты** (`/api/federated/*`) — без авторизации, вызов только между серверами.

### Реалтайм (SSE)

- Каждый клиент держит SSE-соединение со своим сервером.
- Сервер отправляет события: `new_message`, `message_updated`, `message_deleted`, `chat_created`.
- Heartbeat каждые 30 секунд.

### API

| Метод | Путь | Auth | Описание |
|---|---|---|---|
| `GET` | `/api/config` | нет | TTL редактирования/удаления |
| `POST` | `/api/register` | нет | Регистрация (`{ nick }`) |
| `GET` | `/api/events` | token | SSE-поток |
| `GET` | `/api/users/search` | Bearer | Поиск пользователей (локальный или федеративный) |
| `GET` | `/api/chats` | Bearer | Список чатов |
| `POST` | `/api/chats` | Bearer | Создать чат (`{ withUserId }`) |
| `GET` | `/api/chats/{id}/messages` | Bearer | Сообщения чата (с пагинацией) |
| `POST` | `/api/chats/{id}/messages` | Bearer | Отправить сообщение |
| `PATCH` | `/api/chats/{id}/messages/{mid}` | Bearer | Редактировать |
| `DELETE` | `/api/chats/{id}/messages/{mid}` | Bearer | Удалить |

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

## Конфигурация

Переменные окружения (backend):

| Переменная | По умолчанию | Описание |
|---|---|---|
| `PORT` | `8080` | Порт сервера |
| `SERVER_DOMAIN` | `localhost:8080` | Домен для federation ID |
| `MESSAGE_EDIT_TTL` | `300` | Секунд для редактирования (0=всегда, <0=никогда) |
| `MESSAGE_DELETE_TTL` | `0` | Секунд для удаления |

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
