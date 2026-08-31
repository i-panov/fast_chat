import {
	Button,
	Center,
	Divider,
	Paper,
	Stack,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { completeRegistration, sendCode, verifyCode } from "../api.ts";
import { useAuth } from "../useAuth.tsx";

type Step = "email" | "code" | "nick";

export function LoginPage() {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const { addAccount, activeAccount } = useAuth();

	const [step, setStep] = useState<Step>("email");
	const [email, setEmail] = useState("");
	const [code, setCode] = useState("");
	const [nick, setNick] = useState("");
	const [setupToken, setSetupToken] = useState("");
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);
	const [debugCode, setDebugCode] = useState<string | null>(null);

	async function handleSendCode() {
		const trimmed = email.trim().toLowerCase();
		if (trimmed.length === 0) return;
		setLoading(true);
		setError("");
		setDebugCode(null);
		try {
			const result = await sendCode(trimmed);
			if (result.debugCode !== undefined) {
				setDebugCode(result.debugCode);
			}
			setStep("code");
		} catch (err) {
			setError(err instanceof Error ? err.message : t("error.sendCode"));
		} finally {
			setLoading(false);
		}
	}

	async function handleVerifyCode() {
		const trimmed = code.trim();
		if (trimmed.length === 0) return;
		setLoading(true);
		setError("");
		try {
			const result = await verifyCode(email.trim().toLowerCase(), trimmed);
			if (result.isNew) {
				setSetupToken(result.setupToken);
				setStep("nick");
			} else {
				addAccount(
					result.token,
					result.user,
					email.trim().toLowerCase(),
					result.expiresAt,
				);
				void navigate({ to: "/chat" });
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : t("error.verifyCode"));
		} finally {
			setLoading(false);
		}
	}

	async function handleCompleteRegistration() {
		const trimmed = nick.trim();
		if (trimmed.length === 0) return;
		setLoading(true);
		setError("");
		try {
			const result = await completeRegistration(setupToken, trimmed);
			addAccount(
				result.token,
				result.user,
				email.trim().toLowerCase(),
				result.expiresAt,
			);
			void navigate({ to: "/chat" });
		} catch (err) {
			setError(err instanceof Error ? err.message : t("error.register"));
		} finally {
			setLoading(false);
		}
	}

	return (
		<Center className="h-full">
			<Paper withBorder className="w-80">
				<Stack p="xl" gap="md">
					{activeAccount !== null && (
						<>
							<Text ta="center" size="sm" c="dimmed">
								{t("login.alreadyLoggedIn", { nick: activeAccount.user.nick })}
							</Text>
							<Button
								variant="light"
								onClick={() => {
									void navigate({ to: "/chat" });
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
								placeholder={t("login.email")}
								type="email"
								value={email}
								onChange={(e) => setEmail(e.target.value)}
								autoFocus
							/>
							{error.length > 0 && (
								<Text size="sm" c="red" ta="center">
									{error}
								</Text>
							)}
							<Button
								disabled={loading || email.trim().length === 0}
								loading={loading}
								onClick={() => {
									void handleSendCode();
								}}
							>
								{t("login.sendCode")}
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
								maxLength={6}
								value={code}
								onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
								autoFocus
							/>
							{error.length > 0 && (
								<Text size="sm" c="red" ta="center">
									{error}
								</Text>
							)}
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
								maxLength={20}
								value={nick}
								onChange={(e) => setNick(e.target.value)}
								autoFocus
							/>
							{error.length > 0 && (
								<Text size="sm" c="red" ta="center">
									{error}
								</Text>
							)}
							<Button
								disabled={loading || nick.trim().length === 0}
								loading={loading}
								onClick={() => {
									void handleCompleteRegistration();
								}}
							>
								{t("login.join")}
							</Button>
						</>
					)}
				</Stack>
			</Paper>
		</Center>
	);
}
