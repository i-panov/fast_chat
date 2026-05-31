import { Text } from "@mantine/core";
import { useEffect, useState } from "react";
import { onNotification } from "../utils/notify.ts";

interface Toast {
	message: string;
	type: "error" | "info";
	id: number;
}

let nextId = 0;

export function NotificationToast() {
	const [toasts, setToasts] = useState<Toast[]>([]);

	useEffect(() => {
		const unsub = onNotification(({ message, type }) => {
			const id = nextId++;
			setToasts((prev) => [...prev, { message, type, id }]);
			setTimeout(() => {
				setToasts((prev) => prev.filter((t) => t.id !== id));
			}, 4000);
		});
		return unsub;
	}, []);

	if (toasts.length === 0) return null;

	return (
		<div
			style={{
				position: "fixed",
				bottom: 16,
				right: 16,
				zIndex: 9999,
				display: "flex",
				flexDirection: "column",
				gap: 8,
			}}
		>
			{toasts.map((t) => (
				<div
					key={t.id}
					style={{
						padding: "10px 16px",
						borderRadius: "8px",
						background:
							t.type === "error"
								? "var(--mantine-color-red-8)"
								: "var(--mantine-color-blue-8)",
						color: "white",
						maxWidth: "320px",
						boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
					}}
				>
					<Text size="sm">{t.message}</Text>
				</div>
			))}
		</div>
	);
}
