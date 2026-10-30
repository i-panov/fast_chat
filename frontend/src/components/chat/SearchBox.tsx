import {
	ActionIcon,
	Button,
	Group,
	Paper,
	Text,
	TextInput,
} from "@mantine/core";
import { Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { User } from "../../types/api.ts";

interface Props {
	query: string;
	results: User[];
	showResults: boolean;
	onQueryChange: (value: string) => void;
	onSelectUser: (userId: string, nick: string) => void;
	onCreateGroup: () => void;
}

export function SearchBox({
	query,
	results,
	showResults,
	onQueryChange,
	onSelectUser,
	onCreateGroup,
}: Props) {
	const { t } = useTranslation();
	const boxRef = useRef<HTMLDivElement>(null);
	const [dismissed, setDismissed] = useState(false);
	const [activeIndex, setActiveIndex] = useState(-1);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset effect intentionally re-runs when the query changes.
	useEffect(() => {
		setDismissed(false);
		setActiveIndex(-1);
	}, [query]);

	useEffect(() => {
		if (!showResults || dismissed) return;
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") {
				e.preventDefault();
				setDismissed(true);
			} else if (e.key === "ArrowDown" && results.length > 0) {
				e.preventDefault();
				setActiveIndex((i) => Math.min(i + 1, results.length - 1));
			} else if (e.key === "ArrowUp" && results.length > 0) {
				e.preventDefault();
				setActiveIndex((i) => Math.max(i - 1, 0));
			} else if (e.key === "Enter" && activeIndex >= 0) {
				const user = results[activeIndex];
				if (user !== undefined) {
					e.preventDefault();
					onSelectUser(user.id, user.nick);
				}
			}
		}
		function onPointer(e: PointerEvent) {
			if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
				setDismissed(true);
			}
		}
		window.addEventListener("keydown", onKey);
		window.addEventListener("pointerdown", onPointer);
		return () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("pointerdown", onPointer);
		};
	}, [showResults, dismissed, results, activeIndex, onSelectUser]);

	const open = showResults && !dismissed;
	const hasList = open && results.length > 0;

	return (
		<div
			ref={boxRef}
			style={{
				padding: "12px",
				borderBottom: "1px solid var(--mantine-color-dark-4)",
				position: "relative",
			}}
		>
			<Group gap="xs" wrap="nowrap">
				<div style={{ flex: 1, position: "relative" }}>
					<TextInput
						placeholder={t("search.placeholder")}
						value={query}
						onChange={(e) => onQueryChange(e.currentTarget.value)}
						size="sm"
						role="combobox"
						aria-expanded={open}
						aria-controls={hasList ? "user-search-listbox" : undefined}
						aria-activedescendant={
							activeIndex >= 0
								? `user-search-option-${activeIndex}`
								: undefined
						}
						aria-label={t("search.placeholder")}
						rightSection={
							query.length > 0 ? (
								<ActionIcon
									variant="transparent"
									color="gray"
									size="sm"
									onClick={() => onQueryChange("")}
									aria-label={t("media.closeMenu")}
								>
									<X size={14} />
								</ActionIcon>
							) : undefined
						}
					/>
				</div>
				<ActionIcon
					variant="default"
					size="lg"
					onClick={onCreateGroup}
					aria-label={t("chat.createGroup")}
					title={t("chat.createGroup")}
				>
					<Plus size={16} />
				</ActionIcon>
			</Group>
			{open && (
				<Paper
					style={{
						position: "absolute",
						top: "100%",
						left: 0,
						right: 0,
						zIndex: 10,
						maxHeight: "200px",
						overflowY: "auto",
						background: "var(--mantine-color-dark-8)",
					}}
					withBorder
				>
					{results.length === 0 ? (
						<Text size="sm" c="dimmed" p="sm" role="status">
							{t("search.noResults")}
						</Text>
					) : (
						<div role="listbox" id="user-search-listbox">
							{results.map((u, i) => (
								<Button
									key={u.id}
									id={`user-search-option-${i}`}
									variant="subtle"
									color="gray"
									fullWidth
									justify="flex-start"
									style={{ borderRadius: 0 }}
									onClick={() => onSelectUser(u.id, u.nick)}
									role="option"
									aria-selected={i === activeIndex}
								>
									<Text size="sm">@{u.nick}</Text>
									{u.online && (
										<Text size="xs" c="dimmed" ml={4}>
											{t("search.online")}
										</Text>
									)}
								</Button>
							))}
						</div>
					)}
				</Paper>
			)}
		</div>
	);
}
