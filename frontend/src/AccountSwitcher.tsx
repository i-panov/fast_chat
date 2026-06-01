import {
	Button,
	Group,
	Modal,
	Overlay,
	ScrollArea,
	Select,
	Stack,
	Text,
	TextInput,
	Title,
	UnstyledButton,
} from "@mantine/core";
import type { FormEvent } from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import i18n, { SUPPORTED_LANGS } from "./i18n.ts";
import { useAuth } from "./useAuth.tsx";

interface Props {
	open: boolean;
	onClose: () => void;
	onLogout: () => void;
}

function AccountRow({
	account,
	isActive,
	onClick,
}: {
	account: { token: string; user: { id: string; nick: string } };
	isActive: boolean;
	onClick: () => void;
}) {
	return (
		<UnstyledButton
			style={{
				display: "flex",
				alignItems: "center",
				gap: "12px",
				width: "100%",
				padding: "12px 16px",
				borderBottom: "1px solid var(--mantine-color-dark-4)",
				background: isActive ? "var(--mantine-color-dark-6)" : undefined,
			}}
			onMouseEnter={(e) => {
				e.currentTarget.style.background = "var(--mantine-color-dark-6)";
			}}
			onMouseLeave={(e) => {
				if (!isActive) {
					e.currentTarget.style.background = "";
				}
			}}
			onClick={onClick}
		>
			<div
				style={{
					width: "32px",
					height: "32px",
					borderRadius: "50%",
					background: "var(--mantine-color-blue-8)",
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					flexShrink: 0,
				}}
			>
				<Text
					span
					style={{ color: "white", fontSize: "14px", fontWeight: 700 }}
				>
					{(account.user.nick[0] ?? "").toUpperCase()}
				</Text>
			</div>
			<Text span style={{ flex: 1, fontSize: "14px", color: "white" }}>
				@{account.user.nick}
			</Text>
			{isActive && (
				<Text
					span
					style={{ color: "var(--mantine-color-blue-5)", fontSize: "14px" }}
				>
					✓
				</Text>
			)}
		</UnstyledButton>
	);
}

function AccountList({
	accounts,
	activeAccount,
	onSwitchAccount,
	onClose,
}: {
	accounts: { token: string; user: { id: string; nick: string } }[];
	activeAccount: { token: string; user: { id: string; nick: string } } | null;
	onSwitchAccount: (token: string) => void;
	onClose: () => void;
}) {
	return (
		<ScrollArea style={{ flex: 1 }}>
			{accounts.map((acc) => (
				<AccountRow
					key={acc.token}
					account={acc}
					isActive={acc.token === activeAccount?.token}
					onClick={() => {
						if (acc.token !== activeAccount?.token) {
							onSwitchAccount(acc.token);
							onClose();
						}
					}}
				/>
			))}
		</ScrollArea>
	);
}

function Footer({
	adding,
	error,
	loading,
	newNick,
	setNewNick,
	onSubmit,
	onCancel,
	onAddClick,
}: {
	adding: boolean;
	error: string;
	loading: boolean;
	newNick: string;
	setNewNick: (v: string) => void;
	onSubmit: (e: FormEvent<HTMLFormElement>) => void;
	onCancel: () => void;
	onAddClick: () => void;
}) {
	const { t } = useTranslation();

	if (!adding) {
		return (
			<Button
				variant="outline"
				style={{ width: "100%", borderStyle: "dashed" }}
				onClick={onAddClick}
			>
				{t("accounts.add")}
			</Button>
		);
	}
	return (
		<form onSubmit={onSubmit}>
			<Stack gap="xs">
				<TextInput
					placeholder={t("accounts.addNick")}
					maxLength={20}
					value={newNick}
					onChange={(e) => setNewNick(e.target.value)}
				/>
				{error.length > 0 && (
					<Text size="sm" c="red">
						{error}
					</Text>
				)}
				<Group justify="flex-end" gap="xs">
					<Button
						type="submit"
						disabled={loading || newNick.trim().length === 0}
						loading={loading}
					>
						{loading ? t("accounts.adding") : t("accounts.addBtn")}
					</Button>
					<Button variant="default" onClick={onCancel}>
						{t("accounts.cancel")}
					</Button>
				</Group>
			</Stack>
		</form>
	);
}

interface HandleSubmitOpts {
	newNick: string;
	login: (nick: string) => Promise<void>;
	setAdding: (v: boolean) => void;
	setNewNick: (v: string) => void;
	setError: (v: string) => void;
	setLoading: (v: boolean) => void;
	onClose: () => void;
	registerError: string;
}

async function handleSubmit(
	e: FormEvent<HTMLFormElement>,
	opts: HandleSubmitOpts,
) {
	e.preventDefault();
	const trimmed = opts.newNick.trim();
	if (trimmed.length === 0) return;
	opts.setLoading(true);
	opts.setError("");
	try {
		await opts.login(trimmed);
		opts.setAdding(false);
		opts.setNewNick("");
		opts.onClose();
	} catch (err) {
		opts.setError(err instanceof Error ? err.message : opts.registerError);
	} finally {
		opts.setLoading(false);
	}
}

export function AccountSwitcher({ open, onClose, onLogout }: Props) {
	const { t } = useTranslation();
	const { accounts, activeAccount, switchAccount, login } = useAuth();
	const [adding, setAdding] = useState(false);
	const [newNick, setNewNick] = useState("");
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);
	const [confirmLogout, setConfirmLogout] = useState(false);

	return (
		<>
			{open && (
				<Overlay color="#000" opacity={0.5} zIndex={40} onClick={onClose} />
			)}
			<div
				style={{
					position: "fixed",
					top: 0,
					left: 0,
					height: "100%",
					width: "280px",
					background: "var(--mantine-color-dark-8)",
					zIndex: 50,
					display: "flex",
					flexDirection: "column",
					transition: "transform 300ms ease-in-out",
					boxShadow: "0 0 20px rgba(0,0,0,0.3)",
					transform: open ? "translateX(0)" : "translateX(-100%)",
				}}
			>
				<div
					style={{
						padding: "16px",
						borderBottom: "1px solid var(--mantine-color-dark-4)",
					}}
				>
					<Title
						order={2}
						style={{ margin: 0, fontSize: "16px", color: "white" }}
					>
						{t("accounts.title")}
					</Title>
				</div>
				<AccountList
					accounts={accounts}
					activeAccount={activeAccount}
					onSwitchAccount={switchAccount}
					onClose={onClose}
				/>
				<div
					style={{
						borderTop: "1px solid var(--mantine-color-dark-4)",
						padding: "16px",
					}}
				>
					<Footer
						adding={adding}
						error={error}
						loading={loading}
						newNick={newNick}
						setNewNick={setNewNick}
						onSubmit={(e) =>
							handleSubmit(e, {
								newNick,
								login,
								setAdding,
								setNewNick,
								setError,
								setLoading,
								onClose,
								registerError: t("error.register"),
							})
						}
						onCancel={() => {
							setAdding(false);
							setError("");
						}}
						onAddClick={() => setAdding(true)}
					/>
					<Button
						variant="outline"
						color="red"
						style={{ width: "100%", marginTop: "8px" }}
						onClick={() => setConfirmLogout(true)}
					>
						{t("accounts.logout")}
					</Button>
					<div
						style={{
							borderTop: "1px solid var(--mantine-color-dark-4)",
							padding: "12px 0 0",
							marginTop: "12px",
						}}
					>
						<Select
							data={SUPPORTED_LANGS.map((l) => ({
								value: l,
								label: t(`lang.${l}`),
							}))}
							value={i18n.language.split("-")[0]}
							onChange={(val) => {
								if (val !== null) i18n.changeLanguage(val);
							}}
							size="xs"
						/>
					</div>
				</div>
				<Modal
					opened={confirmLogout}
					onClose={() => setConfirmLogout(false)}
					title={t("accounts.logoutTitle")}
					size="sm"
				>
					<Text size="sm" mb="md">
						{t("accounts.logoutConfirm")}
					</Text>
					<Group justify="flex-end" gap="xs">
						<Button variant="default" onClick={() => setConfirmLogout(false)}>
							{t("accounts.cancel")}
						</Button>
						<Button
							color="red"
							onClick={() => {
								setConfirmLogout(false);
								onLogout();
								onClose();
							}}
						>
							{t("accounts.logout")}
						</Button>
					</Group>
				</Modal>
			</div>
		</>
	);
}
