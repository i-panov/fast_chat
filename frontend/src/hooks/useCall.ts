import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import {
	ApiError,
	acceptCall,
	getCurrentCall,
	getIceServers,
	hangupCall,
	hangupCallOnLeave,
	rejectCall,
	sendCallIce,
	startCall,
} from "../api.ts";
import { type CallManager, createCallManager } from "../calls/callManager.ts";
import { createCallStore } from "../calls/callState.ts";
import type { CallApi, CallView } from "../calls/callTypes.ts";
import { startRingtone } from "../calls/ringtone.ts";
import { emitNotification } from "../utils/notify.ts";

const IDLE_STATE: CallView = { phase: "idle", muted: false, cameraOn: true };

const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;

// FAILED_MESSAGE is shown when the server refuses the call.
const FAILED_MESSAGE = "call.failed";

// BUSY_MESSAGE is shown when the peer is already on the phone.
const BUSY_MESSAGE = "call.busy";

// SELF_BUSY_MESSAGE is shown when the user is on the phone themselves:
// another tab or another device holds the call this page does not know about.
const SELF_BUSY_MESSAGE = "call.selfBusy";

// CALLER_BUSY_CODE is the reason the server names when the user is the busy
// side: the 409 status is shared with a busy peer, so the code decides.
const CALLER_BUSY_CODE = "busy-caller";

// REMOTE_MESSAGE is shown when the peer lives on another server: the
// signaling has no route there.
const REMOTE_MESSAGE = "call.remote";

// CALL_STORAGE_KEY is the key of the identifier of the call in the session
// storage of the tab. A reloaded page ends the call it had.
const CALL_STORAGE_KEY = "fastchat.call";

// CALL_PENDING_KEY marks an outgoing call that waits for the identifier of
// the server. A reload in that window leaves no identifier behind, so the
// reconcile cancels the call on the server when it finds it.
const CALL_PENDING_KEY = "fastchat.callPending";

// CALL_NOTICE_KEY is the key of the call the page has already reported. The
// server keeps an ended call for ten minutes, so a reload would report the
// same missed call again.
const CALL_NOTICE_KEY = "fastchat.callNotice";

// startFailureMessage tells what to report when the server refused to start
// the call: a peer that is busy or lives on another server is not a broken
// call, and the user can act on it. The 409 status covers both sides of a
// busy call, so the reason decides: a call of the user's own device is not a
// call of the peer.
function startFailureMessage(error: unknown): string {
	if (!(error instanceof ApiError)) return FAILED_MESSAGE;

	if (error.code === CALLER_BUSY_CODE) return SELF_BUSY_MESSAGE;

	switch (error.status) {
		case HTTP_CONFLICT:
			return BUSY_MESSAGE;
		case HTTP_FORBIDDEN:
			return REMOTE_MESSAGE;
		default:
			return FAILED_MESSAGE;
	}
}

// isCallGone tells whether the call an action concerned is over: the ringing
// window ran out, or another tab took it. The events of the server tell the
// interface what happened, so the action itself reports nothing.
function isCallGone(error: unknown): boolean {
	if (!(error instanceof ApiError)) return false;

	return error.status === HTTP_NOT_FOUND || error.status === HTTP_CONFLICT;
}

// reconcileCall asks the server what call the user has: the events may have
// been lost while the user was away or the stream was broken. A call the
// client already tracks is left alone: the client knows more than the
// server does.
async function reconcileCall(
	manager: CallManager,
	token: string,
	pendingReloadRef: React.MutableRefObject<boolean>,
	isCancelled: () => boolean,
): Promise<void> {
	const current = await getCurrentCall(token).catch(() => null);

	if (isCancelled() || current === null) return;

	// The client is already in a call: it knows more than the
	// server does.
	if (manager.state().callId !== undefined) return;

	// This tab reloaded while it waited for the identifier: the call
	// the server created for it must not ring until the window runs
	// out. Only the own outgoing call is cancelled: a ringing call
	// of another tab is left alone.
	if (
		pendingReloadRef.current &&
		(current.state === "ringing" || current.state === "active") &&
		(current.role === "caller" || current.offer === undefined)
	) {
		pendingReloadRef.current = false;

		try {
			await hangupCall(token, current.callId);
		} catch {
			// The call is already gone.
		}

		return;
	}

	// The call waits for an answer and the user was away: it can be
	// taken again. A call that is going on is not touched: another
	// tab or another device may be in it.
	if (current.state === "ringing" && current.offer !== undefined) {
		const extra = current as unknown as {
			chatId?: unknown;
			chat?: unknown;
			peerNick?: unknown;
			nick?: unknown;
		};
		const chatId =
			typeof extra.chatId === "string" && extra.chatId !== ""
				? extra.chatId
				: typeof extra.chat === "string"
					? extra.chat
					: (manager.state().chatId ?? "");
		const nick =
			typeof extra.peerNick === "string" && extra.peerNick !== ""
				? extra.peerNick
				: typeof extra.nick === "string" && extra.nick !== ""
					? extra.nick
					: (current.peer.split(":")[0] ?? "");

		manager.handleIncoming({
			callId: current.callId,
			chatId,
			offer: current.offer,
			from: { id: current.peer, nick },
		});

		return;
	}

	// The call ended while the user was away: the interface reports
	// the missed call. The other endings stay silent: only the call
	// that rang out is a missed call, and only the first page that
	// learns about it reports.
	if (
		current.state === "ended" &&
		current.reason === "timeout" &&
		sessionStorage.getItem(CALL_NOTICE_KEY) !== current.callId
	) {
		manager.handleEnded({
			callId: current.callId,
			reason: current.reason,
			peerId: current.peer,
			role: current.role,
		});
	}
}

export interface UseCall {
	// manager owns the call: the signaling events of the server reach it.
	manager: CallManager | null;
	state: CallView;
	start: (chatId: string) => Promise<void>;
	accept: () => Promise<void>;
	reject: () => Promise<void>;
	hangup: () => Promise<void>;
	toggleMute: () => void;
	toggleCamera: () => void;
	dismiss: () => void;
}

// useCall keeps the call of the user: the manager owns the connection, the
// store tells the interface what changed.
//
// The manager belongs to the account, not to the token: the token of the
// session is refreshed every day, and a new manager would drop the call
// that is going on.
export function useCall(
	token: string | undefined,
	userId: string | undefined,
): UseCall {
	const { t } = useTranslation();

	const tokenRef = useRef(token);

	useEffect(() => {
		tokenRef.current = token;
	}, [token]);

	// pendingReload tells whether this tab reloaded while it waited for the
	// identifier of the server. It is captured before the storage effects
	// clear the marker.
	const pendingReloadRef = useRef(false);

	const manager = useMemo(() => {
		if (userId === undefined) return null;

		const api: CallApi = {
			// The token is read on every request: it changes when the
			// session is refreshed.
			get token() {
				return tokenRef.current ?? "";
			},
			getIceServers,
			startCall,
			acceptCall,
			rejectCall,
			hangupCall,
			sendCallIce,
		};

		return createCallManager(api);
	}, [userId]);

	const store = useMemo(
		() => (manager === null ? null : createCallStore(manager)),
		[manager],
	);

	const subscribe = useCallback(
		(listener: () => void) => store?.subscribe(listener) ?? (() => {}),
		[store],
	);

	const getSnapshot = useCallback(
		() => store?.getSnapshot() ?? IDLE_STATE,
		[store],
	);

	const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

	// A reloaded page ends the call it had: the identifier of the call
	// lives in the session storage of the tab. Another tab has its own
	// storage, so it never ends the call of this one.
	useEffect(() => {
		if (manager === null) return;

		const callId = sessionStorage.getItem(CALL_STORAGE_KEY);
		if (callId !== null) {
			sessionStorage.removeItem(CALL_STORAGE_KEY);
			void hangupCallOnLeave(tokenRef.current ?? "", callId);
		}

		if (sessionStorage.getItem(CALL_PENDING_KEY) !== null) {
			pendingReloadRef.current = true;
			sessionStorage.removeItem(CALL_PENDING_KEY);
		}
	}, [manager]);

	// The identifier of the call lives in the session storage while the
	// call is going on, and the call whose ending the page has reported
	// stays there: the ending is news only once.
	useEffect(() => {
		if (state.phase === "idle" || state.phase === "ended") {
			sessionStorage.removeItem(CALL_STORAGE_KEY);
			sessionStorage.removeItem(CALL_PENDING_KEY);

			if (state.phase === "ended" && state.callId !== undefined) {
				sessionStorage.setItem(CALL_NOTICE_KEY, state.callId);
			}

			return;
		}

		if (state.callId !== undefined) {
			sessionStorage.setItem(CALL_STORAGE_KEY, state.callId);
			sessionStorage.removeItem(CALL_PENDING_KEY);
		} else if (state.phase === "outgoing") {
			sessionStorage.setItem(CALL_PENDING_KEY, "1");
		}
	}, [state.phase, state.callId]);

	// The camera of a call must not outlive the account it belongs to, and
	// the server must not keep a call of a page that goes away.
	useEffect(() => {
		if (manager === null) return;

		const leave = () => {
			const current = manager.state();
			if (current.callId === undefined || current.phase === "ended") return;

			void hangupCallOnLeave(tokenRef.current ?? "", current.callId);
		};

		window.addEventListener("pagehide", leave);

		return () => {
			window.removeEventListener("pagehide", leave);

			// The account changed or the page went away: the server must
			// not keep the call, and the media of the old account must not
			// outlive it.
			leave();
			manager.end();
		};
	}, [manager]);

	// The server may still hold a call that waited for an answer while the
	// user was away. Such a call is taken again.
	useEffect(() => {
		if (manager === null || token === undefined) return;

		let cancelled = false;

		const reconcile = () => {
			if (cancelled) return;

			void reconcileCall(manager, token, pendingReloadRef, () => cancelled);
		};

		reconcile();

		// A break in the stream may have lost the events: reconcile again
		// when the network is back.
		window.addEventListener("online", reconcile);

		return () => {
			cancelled = true;
			window.removeEventListener("online", reconcile);
		};
	}, [manager, token]);

	// The incoming call rings until it is taken or declined.
	const ringing = state.phase === "incoming";

	useEffect(() => {
		if (!ringing) return;

		const ringtone = startRingtone();

		return () => {
			ringtone.stop();
		};
	}, [ringing]);

	// reportActionFailure reports an action that did not go through. A call
	// that is already over is not an error: the ringing window ran out, or
	// another tab took it, and the events of the server close the interface.
	const reportActionFailure = useCallback(
		(error: unknown) => {
			if (isCallGone(error)) return;

			emitNotification(t(FAILED_MESSAGE), "error");
		},
		[t],
	);

	const start = useCallback(
		async (chatId: string) => {
			if (manager === null) return;

			try {
				await manager.start(chatId);
			} catch (error) {
				emitNotification(t(startFailureMessage(error)), "error");
			}
		},
		[manager, t],
	);

	const accept = useCallback(async () => {
		if (manager === null) return;

		try {
			await manager.accept();
		} catch (error) {
			reportActionFailure(error);
		}
	}, [manager, reportActionFailure]);

	const reject = useCallback(async () => {
		if (manager === null) return;

		try {
			await manager.reject();
		} catch (error) {
			reportActionFailure(error);
		}
	}, [manager, reportActionFailure]);

	const hangup = useCallback(async () => {
		if (manager === null) return;

		try {
			await manager.hangup();
		} catch (error) {
			reportActionFailure(error);
		}
	}, [manager, reportActionFailure]);

	const toggleMute = useCallback(() => {
		manager?.toggleMute();
	}, [manager]);

	const toggleCamera = useCallback(() => {
		manager?.toggleCamera();
	}, [manager]);

	const dismiss = useCallback(() => {
		manager?.dismiss();
	}, [manager]);

	return {
		manager,
		state,
		start,
		accept,
		reject,
		hangup,
		toggleMute,
		toggleCamera,
		dismiss,
	};
}
