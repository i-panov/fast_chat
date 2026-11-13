import { Anchor, Button, Group, Stack } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { pressBotCallback } from "../../../api.ts";
import type { InlineKeyboardMarkup } from "../../../types/api.ts";
import { useAuth } from "../../../useAuth.tsx";

interface Props {
	chatId: string;
	messageId: string;
	markup: InlineKeyboardMarkup;
}

export function InlineKeyboard({ chatId, messageId, markup }: Props) {
	const { t } = useTranslation();
	const { activeAccount } = useAuth();
	const [busy, setBusy] = useState<string | null>(null);

	async function press(data: string) {
		if (activeAccount === null || busy !== null) return;
		setBusy(data);
		try {
			await pressBotCallback(activeAccount.token, chatId, messageId, data);
			notifications.show({ message: t("bot.callbackSent"), color: "teal" });
		} catch (err) {
			notifications.show({
				message: err instanceof Error ? err.message : String(err),
				color: "red",
			});
		} finally {
			setBusy(null);
		}
	}

	return (
		<Stack gap={4} mt={6}>
			{markup.inline_keyboard.map((row) => (
				<Group
					key={row
						.map(
							(button) =>
								`${button.text}:${button.callback_data ?? button.url ?? ""}`,
						)
						.join("|")}
					gap={4}
					grow
				>
					{row.map((button) =>
						button.url !== undefined ? (
							<Anchor
								key={`${button.text}:${button.url}`}
								href={button.url}
								target="_blank"
								rel="noopener noreferrer"
							>
								{button.text}
							</Anchor>
						) : (
							<Button
								key={`${button.text}:${button.callback_data ?? ""}`}
								size="xs"
								variant="light"
								loading={busy === button.callback_data}
								onClick={() => {
									if (button.callback_data !== undefined) {
										void press(button.callback_data);
									}
								}}
							>
								{button.text}
							</Button>
						),
					)}
				</Group>
			))}
		</Stack>
	);
}
