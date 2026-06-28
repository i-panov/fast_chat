import {
	Button,
	Modal,
	Overlay,
	ScrollArea,
	Select,
	Text,
	Title,
	UnstyledButton,
} from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import i18n, { getCurrentLocale, SUPPORTED_LANGS } from "./i18n.ts";
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

export function AccountSwitcher({ open, onClose, onLogout }: Props) {
	const { t } = useTranslation();
	const { accounts, activeAccount, switchAccount } = useAuth();
	const navigate = useNavigate();
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
					<Button
						variant="outline"
						style={{
							width: "100%",
							borderStyle: "dashed",
							marginBottom: "8px",
						}}
						onClick={() => {
							onClose();
							navigate({ to: "/login" });
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
							value={getCurrentLocale()}
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
					<div
						style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}
					>
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
					</div>
				</Modal>
			</div>
		</>
	);
}
