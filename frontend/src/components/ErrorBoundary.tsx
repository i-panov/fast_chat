import { Button, Container, Stack, Text, Title } from "@mantine/core";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Component, type ReactNode } from "react";
import i18n from "../i18n.ts";

interface Props {
	children: ReactNode;
	fallback?: ReactNode;
}

interface State {
	error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
	override state: State = { error: null };

	static getDerivedStateFromError(error: Error): State {
		return { error };
	}

	override componentDidCatch(error: Error, info: React.ErrorInfo) {
		console.error("ErrorBoundary caught:", error, info);
	}

	reset = () => {
		this.setState({ error: null });
	};

	override render() {
		const { error } = this.state;
		const { children, fallback } = this.props;

		if (error === null) return children;

		if (fallback !== undefined) return fallback;

		return (
			<Container
				size="sm"
				py="xl"
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					minHeight: "100vh",
				}}
			>
				<Stack align="center" gap="md">
					<AlertTriangle size={48} color="var(--mantine-color-orange-5)" />
					<Title order={2} ta="center">
						{i18n.t("error.boundaryTitle")}
					</Title>
					<Text c="dimmed" ta="center">
						{i18n.t("error.boundaryMessage")}
					</Text>
					{error.message !== "" && (
						<Text size="sm" c="red" ta="center" style={{ maxWidth: 400 }}>
							{error.message}
						</Text>
					)}
					<Button leftSection={<RotateCcw size={16} />} onClick={this.reset}>
						{i18n.t("error.boundaryReset")}
					</Button>
				</Stack>
			</Container>
		);
	}
}
