import type { ReactNode } from "react";

export const metadata = {
  title: "Memongo Console",
  description: "MongoDB-native agent memory — product console (POC)",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui", margin: 0, padding: "2rem", maxWidth: 720 }}>
        {children}
      </body>
    </html>
  );
}
