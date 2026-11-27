import {
	Button,
	Center,
	Divider,
	Group,
	Paper,
	Stack,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { completeRegistration, sendCode, verifyCode } from "../api.ts";
import { LanguageSelect } from "../components/LanguageSelect.tsx";
import { useAuth } from "../useAuth.tsx";
import { getDeviceInfo } from "../utils/device.ts";

type Step = "email" | "code" | "nick";

// Known errors stay keys so switching the language re-renders them; server
// messages are already text and cannot be translated.
type FormError = { key: string } | { text: string };

// loginError maps the API failure to a stable i18n key. Auth errors carry no
// machine-readable code, only an English message and a status: showing the
// raw text would leave the user with "unauthorized" or "TypeError: Failed to
// fetch" in a localized interface.
function loginError(err: unknown, fallbackKey: string): FormError {
	if (err instanceof Error) {
		const status = (err as { status?: unknown }).status;
		if (typeof status === "number") {
			if (status === 401) return { key: "error.verifyCode" };
			return { key: fallbackKey };
		}
		if (err.name === "TypeError") return { key: fallbackKey };
		return { text: err.message };
	}
	return { key: fallbackKey };
}

// Resend cooldown: the server rate-limits codes, and a second click before the
// mail arrives only burns the limit.
const RESEND_COOLDOWN_SECONDS = 30;

const EMAIL_LABEL_KEY = "login.email";
const SEND_CODE_KEY = "login.sendCode";

// Empty chat search: TanStack requires explicit search params on every
// navigation once validateSearch is defined.
const CHAT_SEARCH = { chatId: undefined, threadId: undefined };

// The device-aware login adds two lines to an already long component; a
// larger extraction is tracked separately.
// eslint-disable-next-line max-lines-per-function
export function LoginPage() {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const { addAccount, activeAccount } = useAuth();
	const [step, setStep] = useState<Step>("email");
	const [email, setEmail] = useState("");
	const [code, setCode] = useState("");
	const [nick, setNick] = useState("");
	const [displayName, setDisplayName] = useState("");
	const [setupToken, setSetupToken] = useState("");
	const [error, setError] = useState<FormError | null>(null);
	const [loading, setLoading] = useState(false);
	const [debugCode, setDebugCode] = useState<string | null>(null);
	const [resendIn, setResendIn] = useState(0);
	const errorText =
		error === null ? null : "key" in error ? t(error.key) : error.text;

	useEffect(() => {
		if (resendIn === 0) return;
		const timer = setTimeout(() => setResendIn(resendIn - 1), 1000);
		return () => clearTimeout(timer);
	}, [resendIn]);

	async function handleSendCode() {
		const trimmed = email.trim().toLowerCase();
		if (trimmed.length === 0) return;
		setLoading(true);
		setError(null);
		setDebugCode(null);
		try {
			const result = await sendCode(trimmed);
			// The code is a debug convenience of a local server; a production
			// build must not render it even if the server has debug_email on.
			if (result.debugCode !== undefined && import.meta.env.DEV) {
				setDebugCode(result.debugCode);
			}
			setResendIn(RESEND_COOLDOWN_SECONDS);
			setStep("code");
		} catch (err) {
			setError(loginError(err, "error.sendCode"));
		} finally {
			setLoading(false);
		}
	}

	async function handleVerifyCode() {
		const trimmed = code.trim();
		if (trimmed.length === 0) return;
		setLoading(true);
		setError(null);
		try {
			const device = getDeviceInfo();
			const result = await verifyCode(
				email.trim().toLowerCase(),
				trimmed,
				device,
			);
			if (result.isNew) {
				setSetupToken(result.setupToken);
				setStep("nick");
			} else {
				addAccount(
					result.token,
					result.user,
					email.trim().toLowerCase(),
					result.expiresAt,
					result.sessionId,
					result.deviceId ?? device.deviceId,
					device.deviceName,
				);
				void navigate({ to: "/chat", search: CHAT_SEARCH });
			}
		} catch (err) {
			setError(loginError(err, "error.verifyCode"));
		} finally {
			setLoading(false);
		}
	}

	async function handleCompleteRegistration() {
		const trimmed = nick.trim().toLowerCase();
		if (trimmed.length < 3 || trimmed.length > 32) {
			setError({ key: "login.usernameInvalid" });
			return;
		}
		setLoading(true);
		setError(null);
		try {
			const device = getDeviceInfo();
			const result = await completeRegistration(
				setupToken,
				trimmed,
				device,
				displayName.trim() || trimmed,
			);
			addAccount(
				result.token,
				result.user,
				email.trim().toLowerCase(),
				result.expiresAt,
				result.sessionId,
				result.deviceId ?? device.deviceId,
				device.deviceName,
			);
			void navigate({ to: "/chat", search: CHAT_SEARCH });
		} catch (err) {
			setError(loginError(err, "error.register"));
		} finally {
			setLoading(false);
		}
	}

	return (
		<Center className="login-shell" py="xl">
			<Paper withBorder className="w-80">
				<Stack p="xl" gap="md">
					{activeAccount !== null && (
						<>
							<Text ta="center" size="sm" c="dimmed">
								{t("login.alreadyLoggedIn", {
									nick: activeAccount.user.nick,
								})}
							</Text>
							<Button
								variant="light"
								onClick={() => {
									void navigate({ to: "/chat", search: CHAT_SEARCH });
								}}
							>
								{t("login.backToChat")}
							</Button>
							<Divider />
						</>
					)}
					<Title order={1} ta="center" c="blue">
						{t("login.title")}
					</Title>
					<Text ta="center" size="sm" c="dimmed">
						{t("login.subtitle")}
					</Text>

					{step === "email" && (
						<>
							<TextInput
								placeholder={t(EMAIL_LABEL_KEY)}
								aria-label={t(EMAIL_LABEL_KEY)}
								type="email"
								inputMode="email"
								autoComplete="email"
								value={email}
								onChange={(e) => setEmail(e.target.value)}
								onKeyDown={(e) => {
									if (e.key !== "Enter") return;
									e.preventDefault();
									void handleSendCode();
								}}
								autoFocus
							/>
							{errorText !== null && (
								<Text size="sm" c="red" ta="center" role="alert">
									{errorText}
								</Text>
							)}
							<Button
								disabled={loading || email.trim().length === 0}
								loading={loading}
								onClick={() => {
									void handleSendCode();
								}}
							>
								{t(SEND_CODE_KEY)}
							</Button>
						</>
					)}

					{step === "code" && (
						<>
							<Text size="sm" c="dimmed" ta="center">
								{t("login.codeSent", { email: email.trim().toLowerCase() })}
							</Text>
							{debugCode !== null && (
								<Text size="sm" c="orange" ta="center">
									{t("login.debugCode", { code: debugCode })}
								</Text>
							)}
							<TextInput
								placeholder={t("login.code")}
								aria-label={t("login.code")}
								inputMode="numeric"
								autoComplete="one-time-code"
								maxLength={6}
								value={code}
								onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
								onKeyDown={(e) => {
									if (e.key !== "Enter") return;
									e.preventDefault();
									void handleVerifyCode();
								}}
								autoFocus
							/>
							{errorText !== null && (
								<Text size="sm" c="red" ta="center" role="alert">
									{errorText}
								</Text>
							)}
							<Group justify="space-between" gap="xs">
								<Button
									variant="subtle"
									size="xs"
									onClick={() => {
										setStep("email");
										setCode("");
										setError(null);
									}}
								>
									{t(EMAIL_LABEL_KEY)}
								</Button>
								<Button
									variant="subtle"
									size="xs"
									disabled={loading || resendIn > 0}
									onClick={() => {
										void handleSendCode();
									}}
								>
									{resendIn > 0
										? `${t(SEND_CODE_KEY)} (${resendIn})`
										: t(SEND_CODE_KEY)}
								</Button>
							</Group>
							<Button
								disabled={loading || code.trim().length < 6}
								loading={loading}
								onClick={() => {
									void handleVerifyCode();
								}}
							>
								{t("login.verify")}
							</Button>
						</>
					)}

					{step === "nick" && (
						<>
							<Text size="sm" c="dimmed" ta="center">
								{t("login.chooseNick")}
							</Text>
							<TextInput
								placeholder={t("login.nick")}
								aria-label={t("login.nick")}
								autoComplete="username"
								maxLength={32}
								value={nick}
								onChange={(e) => setNick(e.target.value)}
								onKeyDown={(e) => {
									if (e.key !== "Enter") return;
									e.preventDefault();
									void handleCompleteRegistration();
								}}
								autoFocus
							/>
							<TextInput
								placeholder={t("login.displayName")}
								aria-label={t("login.displayName")}
								autoComplete="name"
								maxLength={64}
								value={displayName}
								onChange={(e) => setDisplayName(e.target.value)}
							/>
							{errorText !== null && (
								<Text size="sm" c="red" ta="center" role="alert">
									{errorText}
								</Text>
							)}
							<Button
								disabled={loading || nick.trim().length < 3}
								loading={loading}
								onClick={() => {
									void handleCompleteRegistration();
								}}
							>
								{t("login.join")}
							</Button>
						</>
					)}
					<Divider />
					<LanguageSelect size="xs" />
				</Stack>
			</Paper>
		</Center>
	);
}
