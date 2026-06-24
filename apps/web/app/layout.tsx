import type { ReactNode } from "react"
import "./globals.css"

export const metadata = {
	title: "Memongo",
	description: "MongoDB-native long-term memory for AI agents",
}

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html lang="en">
			<body>{children}</body>
		</html>
	)
}
