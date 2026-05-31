import { useState, type SubmitEvent } from "react";
import { useAuth } from "./useAuth";

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function AccountSwitcher({ open, onClose }: Props) {
  const { accounts, activeAccount, switchAccount, login } = useAuth();
  const [adding, setAdding] = useState(false);
  const [newNick, setNewNick] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleAdd(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = newNick.trim();
    if (trimmed.length === 0) { return; }

    setLoading(true);
    setError("");
    try {
      await login(trimmed);
      setAdding(false);
      setNewNick("");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setLoading(false);
    }
  }

  function handleAccountClick(token: string) {
    if (token !== activeAccount?.token) {
      switchAccount(token);
      onClose();
    }
  }

  return (
    <>
      {open && <div className="switcher-overlay" onClick={onClose} />}
      <div className={`switcher-panel ${open ? "open" : ""}`}>
        <div className="switcher-header">
          <h2>Accounts</h2>
        </div>

        <div className="switcher-list">
          {accounts.map((acc) => (
            <button
              key={acc.token}
              className={`switcher-item ${acc.token === activeAccount?.token ? "active" : ""}`}
              onClick={() => { handleAccountClick(acc.token); }}
            >
              <span className="switcher-avatar">
                {(acc.user.nick[0] ?? "").toUpperCase()}
              </span>
              <span className="switcher-nick">@{acc.user.nick}</span>
              {acc.token === activeAccount?.token && (
                <span className="switcher-check">✓</span>
              )}
            </button>
          ))}
        </div>

        <div className="switcher-bottom">
          {adding ? (
            <form className="switcher-add-form" onSubmit={handleAdd}>
              <input
                type="text"
                placeholder="Nickname"
                maxLength={20}
                value={newNick}
                onChange={(e) => { setNewNick(e.target.value); }}
                autoFocus
              />
              {error.length > 0 && <p className="error">{error}</p>}
              <div className="switcher-add-actions">
                <button type="submit" disabled={loading || newNick.trim().length === 0}>
                  {loading ? "Adding..." : "Add"}
                </button>
                <button type="button" onClick={() => { setAdding(false); setError(""); }}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <button className="switcher-add-btn" onClick={() => { setAdding(true); }}>
              + Add Account
            </button>
          )}
        </div>
      </div>
    </>
  );
}
