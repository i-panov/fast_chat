# SESSION-STATE.md

Живое состояние работ по fast_chat. Нужен, чтобы состояние проекта не жило только
в истории чата: новая сессия поднимается за один ход по этому файлу.

- Обновлено: 2026-11-24 по сессии `session-8fb56747-ca57-4c4b-9ac4-811811d0d838`
  (2026-11-07 → 2026-11-24, 195 ходов, 16 МБ лога).
- База: `master` @ `0e58fc8` (последний коммит; bot-правки ниже ещё не закоммичены).
- Правила работы — `AGENTS.md`. Проверки — `make lint`, `make test`, `make frontend:e2e`.
- Обновлять при изменении состава остатка, а не после каждого шага.

## Цель

Довести fast_chat до состояния «можно деплоить»: закрыть остаток ниже, прогнать
финальные проверки и read-only ревью, исправить все валидные findings. Коммит и
пуш — только после этого и только по явной команде (см. `AGENTS.md`). Деплой
делает пользователь.

## Сделано

Закрытые крупные этапы (по goal-раундам и коммитам):

- **Пункт 5 плана** — аватары, реакции, голосовые, закрепление, блокировки,
  пересылка, поиск. Закрыт goal-раундами 10/12 (11-11).
- **Пункт 6 плана** — coturn в Docker, политика файлового кэша, индекс SSE-хаба,
  legacy cleanup. Там же.
- **Phase B E2EE** — per-device backup/restore, совместимость старых клиентов,
  пере-регистрация восстановленного ключа. Goal 8/10 (11-12), коммиты `3297bb7`,
  `a402fbe`.
- **Федерация** — группы и membership, проксирование шифрованных вложений,
  переговоры версии протокола, снятие лимита в 100 участников. Коммиты
  `38b6019`, `685df3c`, `5397271`, `33b1242`, `6447fa6`.
- **Боты** — серверная и клиентская часть, bot-чаты 1-1, Bot API, кнопки,
  callbacks, federated bot chats, E2EE bot files, Python SDK. Коммиты `b9662f6`,
  `518bd54`, `d2ece5e`, `78fd85b`, `781a123`, `73d11e7`, `c7317dd`.

## Остаток (обновлено 2026-11-24)

Сделано в этой сессии (не закоммичено, база `c7317dd`):

1. Карты: OSM разрешён в `img-src` и `connect-src`; Service Worker больше не
   перехватывает cross-origin. Классификация запросов — `frontend/src/sw/routing.ts`.
2. Navigation fallback: SW отдаёт precache и кэшированный `index.html` для SPA,
   `NetworkOnly` остался только для `/api/`.
3. Голосовая запись: requesting/таймаут 15 c, `isSecureContext`, понятные ошибки
   по `DOMException`, выбор MIME, обработка `onerror`, уведомление о короткой
   записи.
4. `SessionsModal`: `size="lg"`, fullScreen на телефоне, badges и действия
   разнесены, дубль «Restore key» удалён.
5. Runtime-зависимости: TanStack Router 1.170.46 / router-core 1.171.39 /
   router-plugin 1.169.0, seroval 1.8.2 / plugins 1.8.0.
6. Build-зависимости: Vite 8.3.8, vite-plugin-pwa 2.0.0, vitest/coverage 4.1.12,
   postcss 8.5.33, typescript-eslint 8.74.0.
7. Dependabot: добавлен `/sdk/typescript`; CI: `make frontend:audit`
   (`npm audit --omit=dev --audit-level=moderate`). Production-аудит чист.
8. Background outbox: SW выполняет очередь без окна по Background Sync и
   Periodic Sync, токен зеркалится в IndexedDB (`backgroundSession.ts`), при
   401 креды удаляются, transient ошибка пробрасывается для ретрая браузера.
9. Conflict resolution: tombstone удаляет queued edit/reaction/pin и staged
   blobs; 404 на edit убирает op/локальную строку/блобы; unauthorized больше
   не помечает операцию failed.
10. Persistent decrypted cache: стор `decryptedFiles` (DB_VERSION 4), LRU,
    ключ включает file key; `useDecryptedFileUrl` читает кэш до сети.
11. Тесты: SW routing, CSP, voice permissions, SessionsModal layout, offline
    reaction/pin/read rollback, federated bot files, background outbox,
    admin service/transport/page.
12. Hermes/DSH adapter-тесты и clean-install — `[manual]`: нужна установка
    Hermes и отдельный DSH-профиль.
13. Админка: `users.is_admin`/`users.banned`, `server.admins` (e-mail,
    проверенный кодом) + `FASTCHAT_ADMINS`, audit log в той же транзакции,
    endpoints `/api/admin/*`, UI `/admin`. Бан ревокирует сессии/push/device
    keys, закрывает SSE и выключает ботов владельца; повторный вход запрещён.
14. Финальные проверки пройдены на итоговом дереве: `make lint` (0 ошибок,
    28 задокументированных warnings `react-hooks/set-state-in-effect`),
    `make test` (backend `-race`, 741 frontend-тест, TS SDK, Python SDK 14),
    `make frontend:e2e` (7 passed).
15. Read-only ревью: два круга. Первый — Critical по бану (verify-code,
    sse-auth, закрытие SSE/push) и bootstrap админа по username; Important по
    пустой странице сообщений, удалению private/self чатов, проглатыванию
    ошибок; Minor по pin/unpin, кэшу расшифрованных файлов, SW navigation,
    last-admin и аудиту. Все валидные findings исправлены, второй круг добавил
    unpin→delete, привязку записи кэша к аккаунту, порядок load-more,
    `response.type === "basic"`, тесты удаления чатов и каскад ботов; третий
    контрольный проход — all clear.
16. UI-полировка: меню вложений (Файл/Фото/Видео/Аудио/Местоположение),
    подтверждение удаления, режим выделения с групповым удалением, иконка
    отправки/сохранения, сессии (скрытие завершения текущего сеанса,
    «Завершить сеанс»), удаление кнопки «⋯» с keyboard-доступом.
17. Root-бот: `root_bot` / «Root Bot», транзакционная миграция
    `fastchat_bot:domain` (users, bots, chat_members, messages, files, pins,
    reactions, devices, push, blocks, deleted chats, read statuses,
    bot_father_states, bot_chats, bot_updates, bot_callback_queries, chats).
    Коллизии имени отклоняются, имена `root_bot`/`fastchat_bot`
    зарезервированы, миграция выполняется один раз.
18. Root-бот: английские ответы, inline-кнопки Create a bot / My bots / Help,
    локальная обработка callbacks без очереди, контекстный Cancel.
19. Presence: внешние боты онлайн 5 минут после любого Bot API запроса,
    `getUpdates` ограничен 2 минутами, root всегда онлайн, offline-переход
    рассылается через SSE.
20. Бот-чаты: в шапке `@username`, кнопка звонка скрыта; fallback на display
    name при пустом username.
21. Проверки на текущем дереве: `make lint` — 0 ошибок; `make test` — backend
    `-race`, 751 frontend, оба SDK; `make frontend:e2e` — 11 passed.
22. `[manual]` Commit и push — только по явной команде пользователя.

Перед финальными проверками влит `origin/master` (`6b0e8cd`,
`server.public_domain` + bind address): конфликты в `.gitignore` и
`backend/config/config.go` разрешены вручную, оба набора правок сохранены.
После слияния `make lint`, `make test` (741 frontend, backend `-race`, оба SDK)
и `make frontend:e2e` (7 passed) снова зелёные.

Исправлена отправка изображений в E2EE-чатах: `prepareFiles` теряла `fileMeta`
для зашифрованных файлов (баг с `c7317dd`), поэтому после синхронизации
вложение отбрасывалось фильтром аутентификации и сообщение выглядело пустым.
Добавлены unit-регресс (включая проверку, что подменённая сервером строка
отбрасывается) и e2e с перезагрузкой страницы. Старые сообщения, отправленные
пока баг был жив, восстановить нельзя: метаданных в шифртексте нет.

Commit/push — только по команде пользователя, деплой делает пользователь.

## Грабли, на которые уже наступали

- **Read-only режим.** Правка `AGENTS.md`/файлов отклоняется — сначала переключить
  permission preset на `workspace-write`, иначе агент тратит ход на объяснение.
- **Субагенты.** Не слать им сообщения и не прерывать, пока они работают; дождаться
  отчёта, затем самому проверить замечания.
- **Линтеры.** Частые падения: `varnamelen`, unused variables, duplicate strings,
  `react-hooks/set-state-in-effect` (последний — задокументированное исключение).
- **Финальные проверки.** `make lint` / `make test` по этапам, а не «final» один раз
  в конце: зелёные тесты — не повод заканчивать ход (см. «Границы хода» в `AGENTS.md`).
- **Goal-лимит.** Цель с `maxGoalRounds: 10` на 14 пунктов упирается в `round-limit`
  и блокируется. Лимит ставить с запасом: примерно 2 раунда на пункт.
