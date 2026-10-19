import { hostname } from "node:os";

import { describe, expect, it } from "vitest";

import { readServiceIdentity } from "./service-identity.js";

describe("service identity for logs", () => {
  it("carries what the deployment supplies", () => {
    expect(
      readServiceIdentity("api", {
        IMAGE_DIGEST: "sha256:0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0",
        INSTANCE_ID: "classhub-api-7d9f8c",
        NODE_ENV: "production",
        RELEASE_ID: "2026.08.06-1",
      }),
    ).toEqual({
      environment: "production",
      image_digest: "sha256:0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0",
      instance_id: "classhub-api-7d9f8c",
      release_id: "2026.08.06-1",
      service: "api",
    });
  });

  it("says unknown rather than dropping the field when the deployment supplies nothing", () => {
    /*
     * 필드가 아예 없으면 "배포가 안 넘겼다"와 "수집기가 흘렸다"를 구분할 수 없다.
     * instance_id만은 hostname으로 채울 수 있으므로 여기서도 값이 남는다.
     */
    expect(readServiceIdentity("api", {})).toMatchObject({
      environment: "unknown",
      image_digest: "unknown",
      instance_id: hostname(),
      release_id: "unknown",
      service: "api",
    });
  });

  it("refuses values that would break a log line into two", () => {
    const identity = readServiceIdentity("api", {
      IMAGE_DIGEST: 'sha256:abc\n{"level":30,"msg":"injected"}',
      INSTANCE_ID: "a".repeat(201),
      NODE_ENV: "production\r\n",
      RELEASE_ID: "  2026.08.06-1  ",
    });

    expect(identity.image_digest).toBe("unknown");
    expect(identity.instance_id).toBe(hostname());
    expect(identity.environment).toBe("production");
    expect(identity.release_id).toBe("2026.08.06-1");
  });
});
