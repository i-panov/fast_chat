import { Alert, Badge, Loader, Stack, Text } from "@mantine/core";
import type { TFunction } from "i18next";
import { useEffect, useState } from "react";
import { adminListFederationPeers } from "../../api.ts";
import { errorText } from "./shared.tsx";

export function FederationTab({ token, t }: { token: string; t: TFunction }) {
	const [peers, setPeers] = useState<string[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		void adminListFederationPeers(token)
			.then((result) => {
				if (!cancelled) setPeers(result.peers);
			})
			.catch((err: unknown) => {
				if (!cancelled) setError(errorText(err));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});

		return () => {
			cancelled = true;
		};
	}, [token]);

	return (
		<Stack gap="md">
			{error !== null && <Alert color="red">{error}</Alert>}
			{loading ? (
				<Loader size="sm" />
			) : peers.length === 0 ? (
				<Text size="sm" c="dimmed">
					{t("admin.empty")}
				</Text>
			) : (
				<Stack gap="xs">
					{peers.map((peer) => (
						<Badge key={peer} variant="light" size="lg">
							{peer}
						</Badge>
					))}
				</Stack>
			)}
		</Stack>
	);
}
