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

function otherNick(members: MemberInfo[], myId: string): string {
  return members.find((m) => m.id !== myId)?.nick ?? "Unknown";
}

export default function ChatPage() {
  const navigate = useNavigate();
  const token = sessionStorage.getItem("token");
  const rawUser = sessionStorage.getItem("user");

  const [user] = useState<User | null>(
    rawUser !== null ? (JSON.parse(rawUser) as User) : null,
  );
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<User[]>([]);
  const [inputText, setInputText] = useState("");

  const [pendingChatWith, setPendingChatWith] = useState<string | null>(null);
  const [pendingChatNick, setPendingChatNick] = useState<string | null>(null);

  const seenMessageIds = useRef(new Set<string>());

  function handleLogout() {
    sessionStorage.removeItem("token");
    sessionStorage.removeItem("user");
    void navigate("/login", { replace: true });
  }

  useEffect(() => {
    if (token === null || user === null) {
      void navigate("/login", { replace: true });
    }
  }, [token, user, navigate]);

  useEffect(() => {
    if (token === null) {
      return;
    }
    void getChats(token).then(({ chats: fetchedChats }) => {
      setChats(fetchedChats);
    });
  }, [token]);

  const handleSSEEvent = useCallback(
    (event: string, data: unknown) => {
      if (event === "new_message") {
        const msg = data as Message;
        if (seenMessageIds.current.has(msg.id)) {
          return;
        }
        seenMessageIds.current.add(msg.id);
        setMessages((prev) => ({
          ...prev,
          [msg.chat_id]: [...(prev[msg.chat_id] ?? []), msg],
        }));
      } else if (event === "chat_created") {
        const chat = data as Chat;
        setChats((prev) => {
          if (prev.some((c) => c.id === chat.id)) {
            return prev;
          }
          return [...prev, chat];
        });
      }
    },
    [],
  );

  useSSE(token ?? "", handleSSEEvent);

  useEffect(() => {
    if (searchQuery.length < 1 || token === null) {
      return;
    }
    const timer = setTimeout(() => {
      void searchUsers(token, searchQuery).then(({ users }) => {
        setSearchResults(users);
      });
    }, 300);
    return () => {
      clearTimeout(timer);
    };
  }, [searchQuery, token]);

  function selectChat(chatId: string) {
    if (token === null) {
      return;
    }
    setPendingChatWith(null);
    setPendingChatNick(null);
    setActiveChatId(chatId);

    if (messages[chatId] === undefined) {
      void getMessages(token, chatId).then(({ messages: msgs }) => {
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
    if (token === null || inputText.trim().length === 0) {
      return;
    }

    const text = inputText;
    setInputText("");

    if (pendingChatWith !== null) {
      try {
        const { chat } = await createChat(token, pendingChatWith);
        setChats((prev) =>
          prev.some((c) => c.id === chat.id) ? prev : [...prev, chat],
        );
        setActiveChatId(chat.id);
        setPendingChatWith(null);
        setPendingChatNick(null);

        await sendMessage(token, chat.id, text);
      } catch {
        setInputText(text);
      }
      return;
    }

    if (activeChatId === null) {
      return;
    }

    try {
      await sendMessage(token, activeChatId, text);
    } catch {
      setInputText(text);
    }
  }

  const activeChat =
    pendingChatWith !== null
      ? undefined
      : chats.find((c) => c.id === activeChatId);

  const activeMessages =
    activeChatId !== null ? (messages[activeChatId] ?? []) : [];

  const showSearchResults =
    searchQuery.length >= 1 && searchResults.length > 0;

  if (user === null || token === null) {
    return null;
  }

  return (
    <div className="chat-layout">
      <header className="app-header">
        <span className="user-info">@{user.nick}</span>
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
                if (e.target.value.length < 1) {
                  setSearchResults([]);
                }
              }}
              autoFocus
            />
            {showSearchResults && (
              <div className="search-results">
                {searchResults.map((u) => (
                  <button
                    key={u.id}
                    className="search-result-item"
                    onClick={() => {
                      selectPendingChat(u.id, u.nick);
                    }}
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
                className={`chat-list-item ${
                  chat.id === activeChatId ? "active" : ""
                }`}
                onClick={() => {
                  selectChat(chat.id);
                }}
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
                  onChange={(e) => {
                    setInputText(e.target.value);
                  }}
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
                    className={`message ${
                      msg.from_id === user.id ? "own" : ""
                    }`}
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
                  onChange={(e) => {
                    setInputText(e.target.value);
                  }}
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
