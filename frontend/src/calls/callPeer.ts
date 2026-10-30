import type { CallApi } from "./callTypes.ts";
import type { CallContext } from "./callManager.ts";
import {
	DISCONNECT_GRACE_MS,
	endRemoteCall,
	settleEnded,
} from "./callEndings.ts";


// createPeer builds the connection and wires the events it reports. The
// events belong to one generation only: a late event of the old connection
// must not touch the call that replaced it.
export function createPeer(
	ctx: CallContext,
	api: CallApi,
	notify: () => void,
	generation: number,
): RTCPeerConnection {
	const connection = new RTCPeerConnection({ iceServers: ctx.iceServers });

	connection.onicecandidate = (event) => {
		if (ctx.generation !== generation || ctx.peer !== connection) return;
		if (!event.candidate) return;

		// The identifier of the call is only known after the server
		// answered, so the candidates collected in the meantime wait for it.
		if (ctx.callId === undefined) {
			ctx.outgoingCandidates.push(event.candidate.toJSON());

			return;
		}

		// A candidate that does not reach the other side is not worth an
		// error: the connection has other candidates.
		void api
			.sendCallIce(api.token, ctx.callId, event.candidate.toJSON())
			.catch(() => undefined);
	};

	connection.ontrack = (event) => {
		if (ctx.generation !== generation || ctx.peer !== connection) return;

		ctx.remoteStream = event.streams[0];
		notify();
	};

	connection.onconnectionstatechange = () => {
		if (ctx.generation !== generation || ctx.peer !== connection) return;

		const state = connection.connectionState;

		// A dead connection never recovers: tell the server so the other
		// side does not stay in a ghost call, then end locally.
		if (state === "failed" || state === "closed") {
			endRemoteCall(ctx, api);
			settleEnded(ctx, notify, { reason: "peer-left" });
			return;
		}

		// "disconnected" is transient (a short network gap usually heals
		// on its own): give it a grace period instead of ending
		// immediately, and notify the server if it never recovers.
		if (state === "disconnected") {
			if (ctx.disconnectTimer !== undefined) return;
			ctx.disconnectTimer = setTimeout(() => {
				ctx.disconnectTimer = undefined;
				if (ctx.generation !== generation || ctx.peer !== connection) {
					return;
				}
				const current = connection.connectionState;
				if (
					current === "disconnected" ||
					current === "failed" ||
					current === "closed"
				) {
					endRemoteCall(ctx, api);
					settleEnded(ctx, notify, { reason: "peer-left" });
				}
			}, DISCONNECT_GRACE_MS);
			return;
		}

		if (ctx.disconnectTimer !== undefined) {
			clearTimeout(ctx.disconnectTimer);
			ctx.disconnectTimer = undefined;
		}
	};

	return connection;
}

