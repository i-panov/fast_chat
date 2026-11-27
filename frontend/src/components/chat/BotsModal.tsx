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
import { useMediaQuery } from "@mantine/hooks";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	ApiError,
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

// Mirrors ParseBotUsername on the server: lowercase letters, digits and
// underscores, no double/trailing underscore, 6..32 characters with "_bot".
const BOT_USERNAME_RE = /^[a-z0-9](?:[a-z0-9_]{0,26}[a-z0-9])?_bot$/;

function isValidBotUsername(value: string): boolean {
	const username = value.trim().toLowerCase();
	return (
		username.length >= 6 &&
		username.length <= 32 &&
		BOT_USERNAME_RE.test(username)
	);
}

function botErrorKey(error: unknown): string {
	if (error instanceof ApiError) {
		if (error.status === 409) return "bots.usernameTaken";
		if (error.status === 400) return "bots.usernameInvalid";
		if (error.status === 403) return "error.forbidden";
	}

	return "error.requestFailed";
}

export function BotsModal({ open, onClose, token }: Props) {
	const { t } = useTranslation();
	const fullScreen = useMediaQuery("(max-width: 48em)") === true;
	const [bots, setBots] = useState<ManagedBot[]>([]);
	const [username, setUsername] = useState("");
	const [displayName, setDisplayName] = useState("");
	const [issuedToken, setIssuedToken] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const [loading, setLoading] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// A plaintext token is shown once. The component stays mounted in the
	// account switcher, so close and account switch must erase it.
	useEffect(() => {
		if (open) return;
		setIssuedToken(null);
		setCopied(false);
		setUsername("");
		setDisplayName("");
		setError(null);
	}, [open]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: token is the reset trigger, not a value read by the effect.
	useEffect(() => {
		setIssuedToken(null);
		setCopied(false);
		setBots([]);
		setError(null);
	}, [token]);

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
				if (!cancelled) setError(t(botErrorKey(err)));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [open, token, t]);

	async function handleCreate() {
		if (token === undefined || busy) return;
		const usernameValue = username.trim().toLowerCase();
		if (!isValidBotUsername(usernameValue)) {
			setError(t("bots.usernameInvalid"));

			return;
		}
		setBusy(true);
		setError(null);
		try {
			const result = await createBot(token, usernameValue, displayName.trim());
			setBots((prev) => [...prev, result.bot]);
			setIssuedToken(result.token);
			setCopied(false);
			setUsername("");
			setDisplayName("");
		} catch (err) {
			setError(t(botErrorKey(err)));
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
			setCopied(false);
		} catch (err) {
			setError(t(botErrorKey(err)));
		} finally {
			setBusy(false);
		}
	}

	async function copyToken() {
		if (issuedToken === null) return;
		try {
			await navigator.clipboard.writeText(issuedToken);
			setCopied(true);
		} catch {
			setError(t("error.requestFailed"));
		}
	}

	return (
		<Modal
			opened={open}
			onClose={onClose}
			title={t("bots.title")}
			size="lg"
			fullScreen={fullScreen}
			centered
		>
			<Stack gap="md">
				{error !== null && <Alert color="red">{error}</Alert>}
				{issuedToken !== null && (
					<Alert color="teal" title={t("bots.tokenTitle")}>
						<Text size="xs" mb={4}>
							{t("bots.tokenHint")}
						</Text>
						<Code block>{issuedToken}</Code>
						<Button
							mt="xs"
							size="xs"
							variant="light"
							onClick={() => {
								void copyToken();
							}}
						>
							{copied ? t("bots.copied") : t("bots.copy")}
						</Button>
					</Alert>
				)}
				<Group align="end" grow>
					<TextInput
						label={t("bots.username")}
						placeholder="my_bot"
						description={t("bots.usernameHint")}
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
						disabled={!isValidBotUsername(username)}
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
						{bots.length === 0 && error === null && (
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
