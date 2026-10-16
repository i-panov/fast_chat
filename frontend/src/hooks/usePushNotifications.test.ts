import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api.ts", () => ({
	getVapidPublicKey: vi.fn(),
	subscribePush: vi.fn(),
}));

const { getVapidPublicKey, subscribePush } = await import("../api.ts");
const { usePushNotifications } = await import("./usePushNotifications.ts");

let subscribeCalls = 0;

function subscription(json: {
	endpoint?: string;
	keys?: { p256dh?: string; auth?: string };
}): PushSubscription {
	return {
		unsubscribe: () => Promise.resolve(true),
		toJSON: () => json,
	} as unknown as PushSubscription;
}

function serviceWorker(
	getSubscription: () => Promise<PushSubscription | null>,
) {
	const registration = {
		pushManager: {
			getSubscription,
			subscribe: () => {
				subscribeCalls += 1;
				return Promise.resolve(
					subscription({
						endpoint: "https://push/new",
						keys: { p256dh: "p", auth: "a" },
					}),
				);
			},
		},
	};
	return { ready: Promise.resolve(registration) };
}

function installServiceWorker(
	getSubscription: () => Promise<PushSubscription | null>,
) {
	Object.defineProperty(navigator, "serviceWorker", {
		value: serviceWorker(getSubscription),
		configurable: true,
	});
}

function setPermission(permission: NotificationPermission) {
	vi.stubGlobal("Notification", {
		permission,
		requestPermission: () => Promise.resolve(permission),
	});
}

beforeEach(() => {
	subscribeCalls = 0;
	vi.mocked(getVapidPublicKey).mockResolvedValue({ publicKey: "AQID" });
	vi.mocked(subscribePush).mockResolvedValue({ subscription: {} });
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	Reflect.deleteProperty(navigator, "serviceWorker");
});

describe("usePushNotifications", () => {
	it("does nothing without a token", () => {
		const getSubscription = () => Promise.resolve(null);
		installServiceWorker(getSubscription);
		setPermission("granted");

		renderHook(() => usePushNotifications(""));

		expect(subscribeCalls).toBe(0);
	});

	it("does nothing when Notification is unavailable", () => {
		installServiceWorker(() => Promise.resolve(null));

		renderHook(() => usePushNotifications("tok"));

		expect(subscribePush).not.toHaveBeenCalled();
	});

	it("does nothing when permission is denied", () => {
		installServiceWorker(() => Promise.resolve(null));
		setPermission("denied");

		renderHook(() => usePushNotifications("tok"));

		expect(subscribePush).not.toHaveBeenCalled();
	});

	it("reuses an existing subscription", async () => {
		installServiceWorker(() =>
			Promise.resolve(
				subscription({
					endpoint: "https://push/existing",
					keys: { p256dh: "p", auth: "a" },
				}),
			),
		);
		setPermission("granted");

		renderHook(() => usePushNotifications("tok"));

		await waitFor(() => {
			expect(subscribePush).toHaveBeenCalledWith(
				"tok",
				"https://push/existing",
				"p",
				"a",
			);
		});
		expect(subscribeCalls).toBe(0);
	});

	it("ignores incomplete subscriptions", async () => {
		const vapidCalls = vi.mocked(getVapidPublicKey).mock.calls.length;
		const subCalls = vi.mocked(subscribePush).mock.calls.length;
		installServiceWorker(() => Promise.resolve(subscription({})));
		setPermission("granted");

		renderHook(() => usePushNotifications("tok"));

		// Give the async setup a chance to proceed past the guard.
		await new Promise((r) => setTimeout(r, 50));
		expect(vi.mocked(getVapidPublicKey).mock.calls.length).toBe(vapidCalls);
		expect(vi.mocked(subscribePush).mock.calls.length).toBe(subCalls);
	});

	it("subscribes fresh when nothing is stored", async () => {
		installServiceWorker(() => Promise.resolve(null));
		setPermission("granted");

		renderHook(() => usePushNotifications("tok"));

		await waitFor(() => {
			expect(subscribePush).toHaveBeenCalledWith(
				"tok",
				"https://push/new",
				"p",
				"a",
			);
		});
		expect(getVapidPublicKey).toHaveBeenCalledTimes(1);
	});

	it("requests permission first", async () => {
		installServiceWorker(() => Promise.resolve(null));
		const requestPermission = () =>
			Promise.resolve("granted" as NotificationPermission);
		const requestPermissionSpy = vi.fn(requestPermission);
		vi.stubGlobal("Notification", {
			permission: "default" as NotificationPermission,
			requestPermission: requestPermissionSpy,
		});

		renderHook(() => usePushNotifications("tok"));

		await waitFor(() => {
			expect(subscribePush).toHaveBeenCalled();
		});
		expect(requestPermissionSpy).toHaveBeenCalledTimes(1);
	});

	it("warns instead of crashing on setup failure", async () => {
		installServiceWorker(() => Promise.reject(new Error("sw down")));
		setPermission("granted");

		renderHook(() => usePushNotifications("tok"));

		await waitFor(() => {
			expect(console.warn).toHaveBeenCalledWith(
				"push notification setup failed",
				expect.anything(),
			);
		});
	});

	it("unsubscribes once when the session ends", async () => {
		const unsubscribe = () => Promise.resolve(true);
		const unsubscribeSpy = vi.fn(unsubscribe);
		installServiceWorker(() =>
			Promise.resolve({
				unsubscribe: unsubscribeSpy,
			} as unknown as PushSubscription),
		);
		setPermission("denied");

		const initialProps: { token: string } = { token: "tok" };
		const { rerender } = renderHook(
			({ token }) => usePushNotifications(token),
			{ initialProps },
		);
		rerender({ token: "" });
		rerender({ token: "" });

		await waitFor(() => {
			expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
		});
	});
});
