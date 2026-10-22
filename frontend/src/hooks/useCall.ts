import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import {
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

// FAILED_MESSAGE is shown when the server refuses the call.
const FAILED_MESSAGE = "call.failed";

// CALL_STORAGE_KEY is the key of the identifier of the call in the session
// storage of the tab. A reloaded page ends the call it had.
const CALL_STORAGE_KEY = "fastchat.call";

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
		if (callId === null) return;

		sessionStorage.removeItem(CALL_STORAGE_KEY);

		void hangupCallOnLeave(tokenRef.current ?? "", callId);
	}, [manager]);

	// The identifier of the call lives in the session storage while the
	// call is going on.
	useEffect(() => {
		if (state.phase === "idle" || state.phase === "ended") {
			sessionStorage.removeItem(CALL_STORAGE_KEY);

			return;
		}

		if (state.callId !== undefined) {
			sessionStorage.setItem(CALL_STORAGE_KEY, state.callId);
		}
	}, [state.phase, state.callId]);

	// The camera of a call must not outlive the account it belongs to, and
	// the server must not keep a call of a page that goes away.
	useEffect(() => {
		if (manager === null) return;

		const leave = () => {
			const callId = manager.state().callId;
			if (callId === undefined) return;

			void hangupCallOnLeave(tokenRef.current ?? "", callId);
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
		if (manager === null) return;

		let cancelled = false;

		const reconcile = async () => {
			const current = await getCurrentCall(tokenRef.current ?? "").catch(
				() => null,
			);

			if (cancelled || current === null) return;

			// The client is already in a call: it knows more than the
			// server does.
			if (manager.state().callId !== undefined) return;

			// The call waits for an answer and the user was away: it can be
			// taken again. A call that is going on is not touched: another
			// tab or another device may be in it.
			if (current.state === "ringing" && current.offer !== undefined) {
				manager.handleIncoming({
					callId: current.callId,
					chatId: "",
					offer: current.offer,
					from: { id: current.peer, nick: "" },
				});
			}
		};

		void reconcile();

		return () => {
			cancelled = true;
		};
	}, [manager]);

	// The incoming call rings until it is taken or declined.
	const ringing = state.phase === "incoming";

	useEffect(() => {
		if (!ringing) return;

		const ringtone = startRingtone();

		return () => {
			ringtone.stop();
		};
	}, [ringing]);

	const start = useCallback(
		async (chatId: string) => {
			if (manager === null) return;

			try {
				await manager.start(chatId);
			} catch {
				emitNotification(t(FAILED_MESSAGE), "error");
			}
		},
		[manager, t],
	);

	const accept = useCallback(async () => {
		if (manager === null) return;

		try {
			await manager.accept();
		} catch {
			emitNotification(t(FAILED_MESSAGE), "error");
		}
	}, [manager, t]);

	const reject = useCallback(async () => {
		if (manager === null) return;

		try {
			await manager.reject();
		} catch {
			emitNotification(t(FAILED_MESSAGE), "error");
		}
	}, [manager, t]);

	const hangup = useCallback(async () => {
		if (manager === null) return;

		try {
			await manager.hangup();
		} catch {
			emitNotification(t(FAILED_MESSAGE), "error");
		}
	}, [manager, t]);

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
