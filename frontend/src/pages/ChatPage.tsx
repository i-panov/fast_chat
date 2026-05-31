import { useEffect, useState, type SubmitEvent, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  getChats,
  searchUsers,
  createChat,
  getMessages,
  sendMessage,
} from "../api";
import type { User, Chat, Message, MemberInfo } from "../api";
import { useSSE } from "../useSSE";
import { useAuth } from "../useAuth";
import AccountSwitcher from "../AccountSwitcher";

function otherNick(members: MemberInfo[], myId: string): string {
  return members.find((m) => m.id !== myId)?.nick ?? "Unknown";
}

export default function ChatPage() {
  const navigate = useNavigate();
  const { activeAccount, accounts, logout } = useAuth();
  const [switcherOpen, setSwitcherOpen] = useState(false);

  const user = activeAccount !== null
    ? { id: activeAccount.user.id, nick: activeAccount.user.nick }
    : null;

  const [chats, setChats] = useState<Chat[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<User[]>([]);
  const [inputText, setInputText] = useState("");

  const [pendingChatWith, setPendingChatWith] = useState<string | null>(null);
  const [pendingChatNick, setPendingChatNick] = useState<string | null>(null);

  const seenMessageIds = useRef(new Set<string>());

  useEffect(() => {
    if (activeAccount === null) {
      void navigate("/login", { replace: true });
    }
  }, [activeAccount, navigate]);

  useEffect(() => {
    const token = activeAccount?.token;
    if (token === undefined || token === "") { return; }
    /* eslint-disable react-hooks/set-state-in-effect */
    setChats([]);
    setActiveChatId(null);
    setMessages({});
    setPendingChatWith(null);
    setPendingChatNick(null);
    setInputText("");
    setSearchQuery("");
    setSearchResults([]);
    seenMessageIds.current = new Set();

    void getChats(token).then(({ chats: fetchedChats }) => {
      setChats(fetchedChats);
    });
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [activeAccount?.token]);

  const handleSSEEvent = useCallback(
    (event: string, data: unknown) => {
      if (event === "new_message") {
        const msg = data as Message;
        if (seenMessageIds.current.has(msg.id)) { return; }
        seenMessageIds.current.add(msg.id);
        setMessages((prev) => ({
          ...prev,
          [msg.chat_id]: [...(prev[msg.chat_id] ?? []), msg],
        }));
      } else if (event === "chat_created") {
        const chat = data as Chat;
        setChats((prev) => {
          if (prev.some((c) => c.id === chat.id)) { return prev; }
          return [...prev, chat];
        });
      }
    },
    [],
  );

  useSSE(activeAccount?.token ?? "", handleSSEEvent);

  useEffect(() => {
    if (searchQuery.length < 1 || activeAccount === null) { return; }
    const timer = setTimeout(() => {
      void searchUsers(activeAccount.token, searchQuery).then(({ users }) => {
        setSearchResults(users);
      });
    }, 300);
    return () => { clearTimeout(timer); };
  }, [searchQuery, activeAccount]);

  function selectChat(chatId: string) {
    if (activeAccount === null) { return; }
    setPendingChatWith(null);
    setPendingChatNick(null);
    setActiveChatId(chatId);
    if (messages[chatId] === undefined) {
      void getMessages(activeAccount.token, chatId).then(({ messages: msgs }) => {
        setMessages((prev) => ({ ...prev, [chatId]: msgs }));
      });
    }
  }

  function selectPendingChat(withUserId: string, withUserNick: string) {
    setPendingChatWith(withUserId);
    setPendingChatNick(withUserNick);
    setActiveChatId(null);
    setSearchQuery("");
    setSearchResults([]);
  }

  async function handleSend(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    if (activeAccount === null || inputText.trim().length === 0) { return; }

    const text = inputText;
    setInputText("");

    if (pendingChatWith !== null) {
      try {
        const { chat } = await createChat(activeAccount.token, pendingChatWith);
        setChats((prev) =>
          prev.some((c) => c.id === chat.id) ? prev : [...prev, chat],
        );
        setActiveChatId(chat.id);
        setPendingChatWith(null);
        setPendingChatNick(null);
        await sendMessage(activeAccount.token, chat.id, text);
      } catch {
        setInputText(text);
      }
      return;
    }

    if (activeChatId === null) { return; }

    try {
      await sendMessage(activeAccount.token, activeChatId, text);
    } catch {
      setInputText(text);
    }
  }

  function handleLogout() {
    logout();
  }

  const activeChat =
    pendingChatWith !== null
      ? undefined
      : chats.find((c) => c.id === activeChatId);

  const activeMessages =
    activeChatId !== null ? (messages[activeChatId] ?? []) : [];

  const showSearchResults =
    searchQuery.length >= 1 && searchResults.length > 0;

  if (activeAccount === null || user === null) { return null; }

  return (
    <div className="chat-layout">
      <AccountSwitcher open={switcherOpen} onClose={() => { setSwitcherOpen(false); }} />
      <header className="app-header">
        <button className="switcher-toggle" onClick={() => { setSwitcherOpen(true); }}>
          ☰
        </button>
        <span className="user-info">
          @{activeAccount.user.nick}
          {accounts.length > 1 && (
            <span className="account-count">+{accounts.length - 1}</span>
          )}
        </span>
        <button className="logout-btn" onClick={handleLogout}>
          Logout
        </button>
      </header>

      <div className="chat-page">
        <aside className="sidebar">
          <div className="search-box">
            <input
              type="text"
              placeholder="Search users..."
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                if (e.target.value.length < 1) { setSearchResults([]); }
              }}
              autoFocus
            />
            {showSearchResults && (
              <div className="search-results">
                {searchResults.map((u) => (
                  <button
                    key={u.id}
                    className="search-result-item"
                    onClick={() => { selectPendingChat(u.id, u.nick); }}
                  >
                    @{u.nick} {u.online ? "(online)" : ""}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="chat-list">
            {chats.length === 0 && (
              <p className="empty-state">
                No chats yet. Search for a user above to start one.
              </p>
            )}
            {chats.map((chat) => (
              <button
                key={chat.id}
                className={`chat-list-item ${chat.id === activeChatId ? "active" : ""}`}
                onClick={() => { selectChat(chat.id); }}
              >
                @{otherNick(chat.members, user.id)}
              </button>
            ))}
          </div>
        </aside>

        <main className="chat-main">
          {pendingChatWith !== null ? (
            <>
              <header className="chat-header">
                @{pendingChatNick}
                <span className="chat-header-badge">New chat</span>
              </header>
              <div className="messages">
                <p className="empty-state">
                  Send a message to start a chat with @{pendingChatNick}
                </p>
              </div>
              <form className="input-bar" onSubmit={handleSend}>
                <input
                  type="text"
                  placeholder="Type a message..."
                  value={inputText}
                  onChange={(e) => { setInputText(e.target.value); }}
                  autoFocus
                />
                <button type="submit" disabled={inputText.trim().length === 0}>
                  Send
                </button>
              </form>
            </>
          ) : activeChat === undefined ? (
            <div className="no-chat">
              <p>Select a chat or search for a user to start messaging</p>
            </div>
          ) : (
            <>
              <header className="chat-header">
                @{otherNick(activeChat.members, user.id)}
              </header>
              <div className="messages">
                {activeMessages.length === 0 && (
                  <p className="empty-state">No messages yet</p>
                )}
                {activeMessages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`message ${msg.from_id === user.id ? "own" : ""}`}
                  >
                    <div className="message-nick">{msg.from_nick}</div>
                    <div className="message-text">{msg.text}</div>
                  </div>
                ))}
              </div>
              <form className="input-bar" onSubmit={handleSend}>
                <input
                  type="text"
                  placeholder="Type a message..."
                  value={inputText}
                  onChange={(e) => { setInputText(e.target.value); }}
                  autoFocus
                />
                <button type="submit" disabled={inputText.trim().length === 0}>
                  Send
                </button>
              </form>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
