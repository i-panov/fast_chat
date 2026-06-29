import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { getRouter } from "./router.tsx";
import "./i18n.ts";
import "./styles.css";
import "leaflet/dist/leaflet.css";

const router = getRouter();

const rootEl = document.getElementById("root");
if (rootEl === null) {
	throw new Error("Root element not found");
}

createRoot(rootEl).render(
	<StrictMode>
		<RouterProvider router={router} />
	</StrictMode>,
);
