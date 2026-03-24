"use client";

import { useState } from "react";

const defaultApi = process.env.NEXT_PUBLIC_MEMONGO_API_URL ?? "http://127.0.0.1:3847";

type Tab = "search" | "kb" | "status" | "profile" | "health";

export default function Home() {
  const [baseUrl, setBaseUrl] = useState(defaultApi);
  const [apiKey, setApiKey] = useState("");
  const [tab, setTab] = useState<Tab>("search");
  const [query, setQuery] = useState("hello");
  const [out, setOut] = useState<string>("");
  const [loading, setLoading] = useState(false);

  function jsonHeaders(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey.trim()) {
      h.Authorization = `Bearer ${apiKey.trim()}`;
    }
    return h;
  }

  function authHeaders(): Record<string, string> {
    const h: Record<string, string> = {};
    if (apiKey.trim()) {
      h.Authorization = `Bearer ${apiKey.trim()}`;
    }
    return h;
  }

  const root = () => baseUrl.replace(/\/$/, "");

  async function run() {
    setLoading(true);
    setOut("");
    try {
      let res: Response;
      if (tab === "search") {
        res = await fetch(`${root()}/v1/search`, {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({ query }),
        });
      } else if (tab === "kb") {
        res = await fetch(`${root()}/v1/search-kb`, {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({ query }),
        });
      } else if (tab === "status") {
        res = await fetch(`${root()}/v1/status`, { headers: authHeaders() });
      } else if (tab === "profile") {
        res = await fetch(`${root()}/v1/profile`, {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({}),
        });
      } else {
        res = await fetch(`${root()}/health`, { headers: authHeaders() });
      }
      const text = await res.text();
      setOut(`${res.status}\n${text}`);
    } catch (e) {
      setOut(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: 24 }}>
      <h1>Memongo Console</h1>
      <p>
        Point this UI at <code>memongo-api</code>. Set <code>NEXT_PUBLIC_MEMONGO_API_URL</code> for defaults.
      </p>
      <label style={{ display: "block", marginBottom: 8 }}>
        API base URL
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          style={{ width: "100%", marginTop: 4 }}
        />
      </label>
      <label style={{ display: "block", marginBottom: 8 }}>
        API key (optional)
        <input
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          type="password"
          style={{ width: "100%", marginTop: 4 }}
        />
      </label>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        {(
          [
            ["search", "Search"],
            ["kb", "KB search"],
            ["status", "Status"],
            ["profile", "Profile"],
            ["health", "Health"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            style={{
              fontWeight: tab === k ? "bold" : "normal",
              padding: "6px 10px",
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {(tab === "search" || tab === "kb") && (
        <label style={{ display: "block", marginBottom: 8 }}>
          Query
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ width: "100%", marginTop: 4 }}
          />
        </label>
      )}
      <button type="button" onClick={() => void run()} disabled={loading}>
        {loading ? "Loading…" : "Run"}
      </button>
      <pre
        style={{
          marginTop: 24,
          padding: 12,
          background: "#111",
          color: "#eee",
          overflow: "auto",
          whiteSpace: "pre-wrap",
        }}
      >
        {out || "—"}
      </pre>
    </main>
  );
}
