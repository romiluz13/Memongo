import path from "node:path"
import type { NextConfig } from "next"

const nextConfig: NextConfig = {
	outputFileTracingRoot: path.join(__dirname, "../../"),
	reactStrictMode: true,
	transpilePackages: ["@memongo/client"],
	webpack: (config) => {
		config.resolve.extensionAlias = {
			...(config.resolve.extensionAlias ?? {}),
			".js": [".ts", ".tsx", ".js", ".jsx"],
		}
		return config
	},
}

export default nextConfig
