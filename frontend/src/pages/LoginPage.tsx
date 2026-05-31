import { useState, type SubmitEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../useAuth";

export default function LoginPage() {
  const [nick, setNick] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const { login, accounts } = useAuth();

  if (accounts.length > 0) {
    void navigate("/chat", { replace: true });
    return null;
  }

  async function handleSubmit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = nick.trim();
    if (trimmed.length === 0) {
      return;
    }

    setLoading(true);
    setError("");
    try {
      await login(trimmed);
      void navigate("/chat", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-page">
      <form className="login-form" onSubmit={handleSubmit}>
        <h1>Fast Chat</h1>
        <p className="login-hint">Enter your nickname to join</p>
        <input
          type="text"
          placeholder="Nickname"
          maxLength={20}
          value={nick}
          onChange={(e) => { setNick(e.target.value); }}
          autoFocus
        />
        {error.length > 0 && <p className="error">{error}</p>}
        <button type="submit" disabled={loading || nick.trim().length === 0}>
          {loading ? "Joining..." : "Join"}
        </button>
      </form>
    </div>
  );
}
