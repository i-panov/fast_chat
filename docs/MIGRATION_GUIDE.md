# Руководство по миграции на модульные хуки

## 📋 Обзор

После рефакторинга фронтенд Fast Chat использует модульную архитектуру хуков вместо монолитного `useChatPage`.

---

## 🔄 Этапы миграции

### Этап 1: Базовые хуки

Замените старую логику на новые хуки:

#### Список чатов
```tsx
// Было
const [chats, setChats] = useState<Chat[]>([]);
useEffect(() => { /* загрузка чатов */ }, []);

// Стало
const { chats, activeChatId, selectChat, refreshChats } = useChatList({ token });
```

#### Сообщения
```tsx
// Было
const [messages, setMessages] = useState<Record<string, Message[]>>({});
const loadMore = useCallback(async () => { /* ... */ }, []);

// Стало
const { messages, hasMore, isLoadingMore, loadMore } = useMessages({ 
  token, 
  chatId: activeChatId 
});
```

#### Ветки
```tsx
// Было
const [threads, setThreads] = useState<Record<string, Thread>>({});
const [activeThreadId, setActiveThreadId] = useState<string | null>(null);

// Стало
const {
  threads,
  activeThreadId,
  activeThread,
  activeThreadMessages,
  createThread,
  openThread,
  closeThread,
  loadMoreThreadMessages,
} = useThreads({ token, chatId: activeChatId });
```

#### Индикаторы набора
```tsx
// Было
const [typingUsers, setTypingUsers] = useState<Record<string, TypingPayload[]>>({});
const typingTimersRef = useRef<Record<string, number>>({});

// Стало
const { typingUsers, handleTyping, clearTyping, addTypingUser } = useTyping({ token });
```

---

### Этап 2: Интеграция SSE

```tsx
// Было
useSseMessages(token, setChats, setMessages, /* ... */);

// Стало
useSseEvents({
  token,
  setChats,
  setMessages,
  setThreads,
  setThreadMessages,
  setMessageToThread,
  addTypingUser,
  clearTyping,
});
```

---

### Этап 3: Управление файлами

```tsx
// Было
const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
const handleAttachFiles = (files: File[]) => { /* ... */ };

// Стало
const { pendingFiles, handleAttachFiles, handleRemoveFile, handleClearAll } = 
  usePendingFiles();
```

---

### Этап 4: Отправка сообщений

```tsx
// Было
const handleSend = useCallback(async (e) => { /* 200+ строк */ }, [/* 20 зависимостей */]);

// Стало
const { sendMessage, editMessage, deleteMessage, retryMessage } = useMessageSender({
  token,
  userId: activeAccount.user.id,
  userNick: activeAccount.user.nick,
  onMessageSent: refreshMessages,
});
```

---

### Этап 5: Контекст ChatPage

Вместо передачи 70+ пропсов используйте контекст:

```tsx
// Было
<ChatInput
  inputText={inputText}
  setInputText={setInputText}
  handleSend={handleSend}
  handleAttachFiles={handleAttachFiles}
  pendingFiles={pendingFiles}
  /* ... ещё 60+ пропсов ... */
/>

// Стало
<ChatPageProvider value={chatPageState}>
  <ChatInput />
</ChatPageProvider>

// В компоненте ChatInput
const { inputText, setInputText, handleSend, handleAttachFiles, pendingFiles } = 
  useChatPageContext();
```

---

## 📁 Структура новых хуков

```
frontend/src/hooks/
├── index.ts                    # Централизованный экспорт
├── useChatList.ts              # Список чатов
├── useMessages.ts              # Сообщения
├── useThreads.ts               # Ветки
├── useTyping.ts                # Индикаторы набора
├── usePendingFiles.ts          # Файлы
├── useMessageSender.ts         # Отправка сообщений
├── useSseEvents.ts             # SSE события
├── useChatInteraction.ts       # Старый хук (постепенная миграция)
└── useChatPage.ts              # Временный файл
```

---

## 🧪 Тестирование

Для тестирования новых хуков:

```bash
cd frontend
pnpm test usePendingFiles.test.ts
```

---

## ⚠️ Известные проблемы

1. **Обратная совместимость**
   - Старый `useChatInteraction.ts` продолжает работать
   - Постепенно переносите логику в новые хуки

2. **Дублирование**
   - Временно может быть дублирование кода
   - Это нормально на этапе миграции

3. **Типизация**
   - Некоторые типы могут потребовать уточнения
   - Используйте type guards для SSE событий

---

## ✅ Чеклист миграции

- [ ] Заменить `useChatList` на новый хук
- [ ] Заменить `useMessages` на новый хук
- [ ] Заменить `useThreads` на новый хук
- [ ] Заменить `useTyping` на новый хук
- [ ] Заменить управление файлами на `usePendingFiles`
- [ ] Интегрировать `useMessageSender`
- [ ] Подключить `useSseEvents`
- [ ] Создать `ChatPageProvider`
- [ ] Обновить `ChatPage.tsx`
- [ ] Обновить дочерние компоненты
- [ ] Удалить старую логику из `useChatInteraction.ts`
- [ ] Покрыть тестами новые хуки

---

## 📚 Примеры использования

### Полный пример компонента

```tsx
import { useChatPageContext } from './context/ChatPageContext';

function ChatInput() {
  const {
    inputText,
    setInputText,
    handleSend,
    handleAttachFiles,
    pendingFiles,
    handleRemoveFile,
    replyToMessage,
    cancelReply,
  } = useChatPageContext();

  return (
    <form onSubmit={handleSend}>
      {replyToMessage && (
        <ReplyPreview onCancel={cancelReply} />
      )}
      
      {pendingFiles.map(file => (
        <FilePreview 
          key={file.id}
          file={file}
          onRemove={() => handleRemoveFile(file.id)}
        />
      ))}
      
      <input
        value={inputText}
        onChange={(e) => setInputText(e.target.value)}
      />
      
      <button type="button" onClick={() => handleAttachFiles(selectedFiles)}>
        Прикрепить файл
      </button>
      
      <button type="submit">Отправить</button>
    </form>
  );
}
```

---

## 🎯 Преимущества новой архитектуры

1. **Разделение ответственности**
   - Каждый хук решает одну задачу
   - Легче тестировать и поддерживать

2. **Производительность**
   - Меньше перерисовок
   - Оптимизированные зависимости

3. **Типизация**
   - Строгие интерфейсы
   - Меньше `any` и приведений

4. **Тестируемость**
   - Изолированные хуки
   - Проще мокировать

5. **Читаемость**
   - Понятные имена
   - Ясная структура

---

## 📞 Поддержка

При возникновении проблем обращайтесь к документации:
- [REFACTORING_REPORT.md](./REFACTORING_REPORT.md)
- [KODA.md](../KODA.md)
