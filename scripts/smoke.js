// Quick end-to-end check against a running bridge.
// Usage: npm run smoke   (override target with BRIDGE_URL)
const baseUrl = process.env.BRIDGE_URL ?? "http://127.0.0.1:37321";

async function get(path) {
  const res = await fetch(`${baseUrl}${path}`);
  console.log(`\n# GET ${path} -> ${res.status}`);
  console.log((await res.text()).slice(0, 1200));
}

async function call(name, args = {}) {
  const res = await fetch(`${baseUrl}/computer-use/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, arguments: args }),
  });
  const d = await res.json();
  console.log(`\n# POST /computer-use/call ${name} -> ${res.status}`);
  console.log("text:", (d.text ?? d.error ?? "").slice(0, 600));
  if (d.images?.length) console.log("images:", d.images.map((i) => i.url));
}

await get("/health");
await get("/computer-use/tools");
await call("list_apps");
