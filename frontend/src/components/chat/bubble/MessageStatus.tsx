import { Loader } from "@mantine/core";
import { Check, CheckCheck } from "lucide-react";
import type { MessageDeliveryStatus } from "../../../types/api.ts";

interface Props {
	status?: MessageDeliveryStatus;
}

export function MessageStatus({ status }: Props) {
	if (status === undefined || status === "sent") {
		return <Check size={12} className="message-status-sent" />;
	}

	if (status === "delivered") {
		return <CheckCheck size={12} className="message-status-delivered" />;
	}

	if (status === "read") {
		return <CheckCheck size={12} className="message-status-read" />;
	}

	return <Loader size={8} />;
}
