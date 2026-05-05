import type { ReactNode } from "react"

export const metadata = {
	title: "Memongo Console",
	description:
		"MongoDB-native agent memory operator console for standalone Memongo",
}

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html lang="en">
			<body
				style={{
					background: "#f6f8fb",
					fontFamily:
						'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
					margin: 0,
				}}
			>
				{children}
			</body>
		</html>
	)
}
