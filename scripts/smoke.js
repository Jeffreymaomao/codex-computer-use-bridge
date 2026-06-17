const baseUrl = process.env.BRIDGE_URL ?? "http://127.0.0.1:37321";

for (const path of ["/health", "/apps", "/computer-use/tools"]) {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();
  console.log(`\n${response.status} ${path}`);
  console.log(text);
}
