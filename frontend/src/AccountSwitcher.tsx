import {
	Button,
	Drawer,
	Modal,
	ScrollArea,
	Select,
	Text,
	Title,
	UnstyledButton,
} from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getConfig } from "./api.ts";
import { BackupSettingsModal } from "./components/chat/BackupSettingsModal.tsx";
import type { KeyPair } from "./e2ee/crypto.ts";
import { getMyKeyPair } from "./e2ee/keys.ts";
import i18n, { getCurrentLocale, SUPPORTED_LANGS } from "./i18n.ts";
import type { AppConfig } from "./types/api.ts";
import { useAuth } from "./useAuth.tsx";
import { clearAllData } from "./utils/clearAllData.ts";

const dividerBorder = "1px solid var(--mantine-color-dark-4)";

function ConfirmModal({
	open,
	title,
	body,
	confirmLabel,
	loading,
	onCancel,
	onConfirm,
}: {
	open: boolean;
	title: string;
	body: string;
	confirmLabel: string;
	loading?: boolean;
	onCancel: () => void;
	onConfirm: () => void;
}) {
	const { t } = useTranslation();
	return (
		<Modal opened={open} onClose={onCancel} title={title} size="sm">
			<Text size="sm" mb="md">
				{body}
			</Text>
			<div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
				<Button variant="default" disabled={loading} onClick={onCancel}>
					{t("accounts.cancel")}
				</Button>
				<Button color="red" loading={loading} onClick={onConfirm}>
					{confirmLabel}
				</Button>
			</div>
		</Modal>
	);
}

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
				borderBottom: dividerBorder,
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

export function AccountSwitcher({ open, onClose, onLogout }: Props) {
	const { t } = useTranslation();
	const { accounts, activeAccount, switchAccount } = useAuth();
	const navigate = useNavigate();
	const [confirmLogout, setConfirmLogout] = useState(false);
	const [confirmClearData, setConfirmClearData] = useState(false);
	const [clearDataLoading, setClearDataLoading] = useState(false);
	const [backupOpen, setBackupOpen] = useState(false);
	const [keyPair, setKeyPair] = useState<KeyPair | null>(null);
	const [appConfig, setAppConfig] = useState<AppConfig | null>(null);
	const abortRef = useRef<AbortController | null>(null);

	useEffect(() => {
		if (!open) return;

		abortRef.current?.abort();
		const ctrl = new AbortController();
		abortRef.current = ctrl;

		getConfig()
			.then((cfg) => {
				if (!ctrl.signal.aborted) setAppConfig(cfg);
			})
			.catch(() => {});

		return () => ctrl.abort();
	}, [open]);

	useEffect(() => {
		if (!open) return;
		getMyKeyPair()
			.then(setKeyPair)
			.catch(() => setKeyPair(null));
	}, [open]);

	// Keep the key pair in sync after the backup modal mutates local keys.
	async function refreshKeyPair() {
		setKeyPair(await getMyKeyPair().catch(() => null));
	}

	async function handleClearData() {
		setClearDataLoading(true);
		try {
			await clearAllData();
		} catch (err) {
			console.error("clearAllData failed", err);
		}
		onClose();
		window.location.replace("/login");
	}

	return (
		<Drawer
			opened={open}
			onClose={onClose}
			size="280px"
			withCloseButton={false}
			styles={{
				body: {
					height: "100%",
					display: "flex",
					flexDirection: "column",
					padding: 0,
				},
			}}
		>
			<div
				style={{
					padding: "16px",
					borderBottom: dividerBorder,
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
					borderTop: dividerBorder,
					padding: "16px",
				}}
			>
				<Button
					variant="outline"
					style={{ width: "100%", marginBottom: "8px" }}
					onClick={() => setBackupOpen(true)}
					disabled={activeAccount === null}
				>
					{t("backup.open")}
				</Button>
				<Button
					variant="outline"
					style={{
						width: "100%",
						borderStyle: "dashed",
						marginBottom: "8px",
					}}
					onClick={() => {
						onClose();
						void navigate({ to: "/login" });
					}}
				>
					{t("accounts.add")}
				</Button>
				<Button
					variant="outline"
					color="red"
					style={{ width: "100%" }}
					onClick={() => setConfirmLogout(true)}
				>
					{t("accounts.logout")}
				</Button>
				<Button
					variant="outline"
					color="red"
					style={{ width: "100%", marginTop: "8px" }}
					onClick={() => setConfirmClearData(true)}
				>
					{t("accounts.clearData")}
				</Button>
				<div
					style={{
						borderTop: dividerBorder,
						padding: "12px 0 0",
						marginTop: "12px",
					}}
				>
					<Select
						data={SUPPORTED_LANGS.map((l) => ({
							value: l,
							label: t(`lang.${l}`),
						}))}
						value={getCurrentLocale()}
						onChange={(val) => {
							if (val !== null) void i18n.changeLanguage(val);
						}}
						size="xs"
					/>
					{appConfig?.version && appConfig.version !== "dev" && (
						<Text size="xs" c="dimmed" ta="center" style={{ marginTop: "8px" }}>
							v-{appConfig.version}-{appConfig.commit}
						</Text>
					)}
				</div>
			</div>
			<ConfirmModal
				open={confirmLogout}
				title={t("accounts.logoutTitle")}
				body={t("accounts.logoutConfirm")}
				confirmLabel={t("accounts.logout")}
				onCancel={() => setConfirmLogout(false)}
				onConfirm={() => {
					setConfirmLogout(false);
					onLogout();
					onClose();
				}}
			/>
			<ConfirmModal
				open={confirmClearData}
				title={t("accounts.clearDataTitle")}
				body={t("accounts.clearDataConfirm")}
				confirmLabel={t("accounts.clearData")}
				loading={clearDataLoading}
				onCancel={() => setConfirmClearData(false)}
				onConfirm={() => {
					void handleClearData();
				}}
			/>
			{activeAccount !== null && (
				<BackupSettingsModal
					open={backupOpen}
					onClose={() => {
						setBackupOpen(false);
						void refreshKeyPair();
					}}
					token={activeAccount.token}
					keyPair={keyPair}
				/>
			)}
		</Drawer>
	);
}
