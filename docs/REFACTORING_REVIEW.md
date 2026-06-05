# Ревью рефакторинга фронта

## Завершённость рефакторинга

Рефакторинг структурно завершён. Старый монолитный `useChatInteraction` (1902 → 520 строк) разбит на отдельные хуки:

- `useChatList` — список чатов
- `useMessages` — загрузка/подгрузка сообщений
- `useThreads` — ветки (threads)
- `useTyping` — индикаторы набора
- `usePendingFiles` — ожидающие файлы
- `useMessageSender` — отправка/редактирование/удаление сообщений
- `useSseEvents` — SSE-события

Компоненты (`InputBar`, `MessageBubble`, `MessageList`) принимают пропсы, не импортируют хуки напрямую. `ChatPage` получает всё состояние через один вызов `useChatPage()`.

## Удаление старого кода

Удалены:
- `useAuthGuard()` — перенесено в `__root.tsx`
- `useTokenChange()` — перенесено в `useChatList`/`useMessages`
- `useSseMessages()` — перенесено в `useSseEvents`
- `useSearch()` — заменено на debounced `handleSearchChange`
- `useSendMessage()` — заменено на `useMessageSender`
- `ChatInteraction` (интерфейс заменён на `ChatPageState`)
- Старая версия `useChatPage()` — заменена на новую

Никаких висячих ссылок на удалённые функции нет.

## Проблемы

| # | Серьёзность | Проблема | Место |
|---|---|---|---|
| 1 | **CRITICAL** | SSE-события игнорируются — в `useSseEvents` переданы `() => {}`-заглушки для всех сеттеров, кроме typing | `useChatInteraction.ts:253-262` |
| 2 | **High** | `handleCreateGroup` не закрывает модалку и не навигирует на новый чат | `useChatInteraction.ts:622-628` |
| 3 | Medium | `handleRemoveGroupMember` не обрабатывает self-removal | `useChatInteraction.ts:667-678` |
| 4 | Medium | `handleRetryThreadMessage` не использует `useMessageSender` | `useChatInteraction.ts:592-605` |
| 5 | Medium | `handleCancelEdit` не очищает `inputText`/`pendingFiles`/`pendingLocation` | `useChatInteraction.ts:539-541` |
| 6 | Low | `ChatPageProvider`/`useChatPageContext` — dead exports | `useChatInteraction.ts:163-166` |
| 7 | Low | `handleClearAll` в `usePendingFiles` не используется | `usePendingFiles.ts:72-84` |
