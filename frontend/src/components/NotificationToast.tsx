import { notifications } from "@mantine/notifications";
import { useEffect } from "react";
import { onNotification } from "../utils/notify.ts";

export function NotificationToast() {
	useEffect(() => {
		const unsub = onNotification(({ message, type }) => {
			notifications.show({
				message,
				color: type === "error" ? "red" : "blue",
				autoClose: 4000,
			});
		});
		return unsub;
	}, []);

	return null;
}
