import {
	Alert,
	Button,
	Code,
	Group,
	Loader,
	Modal,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	createBot,
	listBots,
	type ManagedBot,
	rotateBotToken,
} from "../../api.ts";

interface Props {
	open: boolean;
	onClose: () => void;
	token: string | undefined;
}

export function BotsModal({ open, onClose, token }: Props) {
	const { t } = useTranslation();
	const [bots, setBots] = useState<ManagedBot[]>([]);
	const [username, setUsername] = useState("");
	const [displayName, setDisplayName] = useState("");
	const [issuedToken, setIssuedToken] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open || token === undefined) return;
		let cancelled = false;
		setLoading(true);
		setError(null);
		void listBots(token)
			.then((result) => {
				if (!cancelled) setBots(result.result);
			})
			.catch((err: unknown) => {
				if (!cancelled)
					setError(err instanceof Error ? err.message : String(err));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [open, token]);

	async function handleCreate() {
		if (token === undefined || busy) return;
		setBusy(true);
		setError(null);
		try {
			const result = await createBot(
				token,
				username.trim(),
				displayName.trim(),
			);
			setBots((prev) => [...prev, result.bot]);
			setIssuedToken(result.token);
			setUsername("");
			setDisplayName("");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	async function handleRotate(botUsername: string) {
		if (token === undefined || busy) return;
		if (!window.confirm(t("bots.rotateConfirm"))) return;
		setBusy(true);
		setError(null);
		try {
			const result = await rotateBotToken(token, botUsername);
			setIssuedToken(result.token);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<Modal opened={open} onClose={onClose} title={t("bots.title")} size="lg">
			<Stack gap="md">
				{error !== null && <Alert color="red">{error}</Alert>}
				{issuedToken !== null && (
					<Alert color="teal" title={t("bots.tokenTitle")}>
						<Text size="xs" mb={4}>
							{t("bots.tokenHint")}
						</Text>
						<Code block>{issuedToken}</Code>
					</Alert>
				)}
				<Group align="end" grow>
					<TextInput
						label={t("bots.username")}
						placeholder="my_bot"
						value={username}
						onChange={(e) => setUsername(e.target.value)}
					/>
					<TextInput
						label={t("bots.displayName")}
						value={displayName}
						onChange={(e) => setDisplayName(e.target.value)}
					/>
					<Button
						onClick={() => void handleCreate()}
						loading={busy}
						disabled={username.trim().length < 6}
					>
						{t("bots.create")}
					</Button>
				</Group>
				{loading ? (
					<Loader size="sm" />
				) : (
					<Stack gap="xs">
						{bots.map((bot) => (
							<Group key={bot.id} justify="space-between">
								<div>
									<Text fw={600}>@{bot.username}</Text>
									<Text size="xs" c="dimmed">
										{bot.displayName ?? bot.username}
									</Text>
								</div>
								<Button
									size="xs"
									variant="light"
									disabled={busy}
									onClick={() => void handleRotate(bot.username)}
								>
									{t("bots.rotate")}
								</Button>
							</Group>
						))}
						{bots.length === 0 && (
							<Text c="dimmed" size="sm">
								{t("bots.empty")}
							</Text>
						)}
					</Stack>
				)}
			</Stack>
		</Modal>
	);
}
