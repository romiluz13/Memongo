import { MemongoClient } from "../src/index.js";

const client = new MemongoClient();

try {
  await client.add({
    content: "User prefers MongoDB for agent memory.",
    containerTag: "demo-user",
  });
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 0;
}
