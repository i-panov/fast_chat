import { Button, Center, Paper, Text, TextInput, Title } from "@mantine/core";
import { Navigate, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../useAuth.tsx";

export function LoginPage() {
	const [nick, setNick] = useState("");
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);
	const navigate = useNavigate();
	const { t } = useTranslation();
	const { login, activeAccount } = useAuth();

	if (activeAccount !== null) {
		return <Navigate to="/chat" />;
	}

	async function handleSubmit(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const trimmed = nick.trim();
		if (trimmed.length === 0) {
			return;
		}

		setLoading(true);
		setError("");
		try {
			await login(trimmed);
			navigate({ to: "/chat" });
		} catch (err) {
			setError(err instanceof Error ? err.message : t("error.register"));
		} finally {
			setLoading(false);
		}
	}

	return (
		<Center className="h-full">
			<Paper withBorder p="xl" className="w-80">
				<form onSubmit={handleSubmit} className="flex flex-col gap-4">
					<Title order={1} ta="center" c="blue">
						{t("login.title")}
					</Title>
					<Text ta="center" size="sm" c="dimmed">
						{t("login.subtitle")}
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
						type="submit"
						disabled={loading || nick.trim().length === 0}
						loading={loading}
					>
						{t("login.join")}
					</Button>
				</form>
			</Paper>
		</Center>
	);
}
