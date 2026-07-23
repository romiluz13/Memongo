import type { Metadata } from "next"
import type { ReactNode } from "react"
import "./globals.css"

const title = "Memongo"
const description = "MongoDB-native long-term memory for production AI agents"
const siteUrl = "https://memongo.rom-88f.workers.dev"
const socialImage = "/memongo-social-preview.png"

export const metadata: Metadata = {
	metadataBase: new URL(siteUrl),
	title: "Memongo",
	description,
	openGraph: {
		title,
		description,
		url: siteUrl,
		siteName: title,
		images: [
			{
				url: socialImage,
				width: 1280,
				height: 640,
				alt: "Memongo - memory for AI agents should be asked, not reloaded.",
			},
		],
		type: "website",
	},
	twitter: {
		card: "summary_large_image",
		title,
		description,
		images: [socialImage],
	},
}

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html lang="en">
			<body>{children}</body>
		</html>
	)
}
