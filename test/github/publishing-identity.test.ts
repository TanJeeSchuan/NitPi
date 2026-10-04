import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { Publisher } from "../../src/github/publisher.js";
import { RestGitHubApi } from "../../src/github/rest-api.js";

it("identifies the publishing bot when an installation token cannot access REST /user", async () => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/user") {
      response.writeHead(403).end(JSON.stringify({ message: "Resource not accessible by integration" }));
      return;
    }
    if (request.method === "POST" && request.url === "/graphql") {
      let raw = "";
      request.on("data", (chunk) => { raw += chunk; });
      request.on("end", () => {
        const body = JSON.parse(raw) as { query?: string };
        if (body.query?.includes("viewer")) {
          response.end(JSON.stringify({ data: { viewer: { login: "github-actions[bot]" } } }));
        } else {
          response.end(JSON.stringify({ errors: [{ message: "unsupported query" }] }));
        }
      });
      return;
    }
    response.writeHead(404).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    expect(await new Publisher(new RestGitHubApi(url, "installation-token")).botLogin()).toBe("github-actions[bot]");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
