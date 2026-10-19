import { createDecipheriv, createECDH, hkdfSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createMariaDbDatabase, createMysql2MariaDbPool, type DB } from "@classhub/db";
import { ConfigService } from "@nestjs/config";
import { Kysely, MysqlDialect, sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppEnvironment } from "../src/config/environment.js";
import {
  MAX_SUBSCRIPTIONS_PER_USER,
  PushEndpointNotAllowedException,
  PushSubscriptionsService,
} from "../src/push-subscriptions/push-subscriptions.service.js";
import { WebPushSender } from "../src/push-subscriptions/web-push-sender.js";

const configPath = process.env.PUSH_SUBSCRIPTIONS_QA_MARIADB_CONFIG;
if (
  !configPath &&
  (process.env.CLASSHUB_REQUIRE_MARIADB === "1" ||
    process.env.CI === "true" ||
    process.env.CI === "1")
) {
  throw new Error(
    "MariaDB cannot be skipped in CI/the gate. Run corepack pnpm test:mariadb-isolated.",
  );
}
const root = new URL("../../../", import.meta.url);
// RFC 8291 부록 A의 공개키·인증값(합성 값).
const PUBLIC_KEY =
  "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const OTHER_PUBLIC_KEY =
  "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
const AUTH = "BTBZMqHH6r4Tts7J_aSIgg";
const USER_AGENT_PRIVATE_KEY = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94";
const SERVER_PRIVATE_KEY = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";

/** 가짜 푸시 서비스가 받은 본문을 수신 브라우저처럼 복호화한다(RFC 8291). */
function decryptReceived(body: Buffer): unknown {
  const salt = body.subarray(0, 16);
  const serverKey = body.subarray(21, 21 + body.readUInt8(20));
  const ciphertext = body.subarray(21 + body.readUInt8(20));
  const agent = createECDH("prime256v1");
  agent.setPrivateKey(Buffer.from(USER_AGENT_PRIVATE_KEY, "base64url"));
  const info = Buffer.concat([Buffer.from("WebPush: info\0"), agent.getPublicKey(), serverKey]);
  const authSecret = Buffer.from(AUTH, "base64url");
  const ikm = Buffer.from(hkdfSync("sha256", agent.computeSecret(serverKey), authSecret, info, 32));
  const key = Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: aes128gcm\0", 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: nonce\0", 12));
  const decipher = createDecipheriv("aes-128-gcm", key, nonce);
  decipher.setAuthTag(ciphertext.subarray(-16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
  return JSON.parse(padded.subarray(0, -1).toString("utf8"));
}
const endpoint = (suffix: string) => `https://fcm.googleapis.com/fcm/send/qa-${suffix}`;

describe.runIf(configPath !== undefined)("push subscriptions on an owned TLS MariaDB", () => {
  let admin: Kysely<DB>;
  let app: Kysely<DB>;
  let service: PushSubscriptionsService;
  let config: ConfigService<AppEnvironment, true>;
  const save = (userId: string, target: string, p256dh = PUBLIC_KEY) =>
    service.save({ userId, endpoint: target, p256dh, auth: AUTH });
  const rows = () =>
    admin
      .selectFrom("push_subscriptions")
      .select(["user_id", "endpoint", "p256dh", "auth_secret"])
      .orderBy("id")
      .execute();

  beforeAll(async () => {
    const target = JSON.parse(await readFile(configPath!, "utf8"));
    expect(target.kind).toBe("classhub-push-isolated-qa");
    expect(target.database).toBe("classhub_push_qa");
    expect(target.host).toBe("localhost");
    expect([3306, 3307, 5173, 5174]).not.toContain(target.port);
    const require = createRequire(new URL("packages/db/package.json", root));
    const mysql = require("mysql2");
    const connection = {
      host: target.host,
      port: target.port,
      database: target.database,
      user: target.user,
      password: target.password,
    };
    admin = new Kysely<DB>({
      dialect: new MysqlDialect({
        pool: mysql.createPool({
          ...connection,
          ssl: { ca: target.sslCa, rejectUnauthorized: true, verifyIdentity: true },
          timezone: "Z",
          supportBigNumbers: true,
          bigNumberStrings: true,
          dateStrings: true,
          multipleStatements: true,
          connectionLimit: 3,
        }),
      }),
    });
    await sql
      .raw(
        `INSERT INTO users (id,email_normalized,display_name,password_hash,email_verified_at) VALUES
          (1,'student1@example.invalid','합성 학생가','synthetic',UTC_TIMESTAMP(6)),
          (2,'student2@example.invalid','합성 학생나','synthetic',UTC_TIMESTAMP(6)),
          (3,'student3@example.invalid','합성 학생다','synthetic',UTC_TIMESTAMP(6));`,
      )
      .execute(admin);
    // 실제 설치와 같은 파일로 테이블과 권한을 만든다.
    await sql
      .raw(
        await readFile(new URL("db/mariadb/migrations/0047_push_subscriptions.sql", root), "utf8"),
      )
      .execute(admin);
    const grant = (
      await readFile(
        new URL("db/mariadb/permissions/0047_push_subscriptions_acl.sql", root),
        "utf8",
      )
    )
      .replaceAll("classhub_mariadb_phase1_dev", target.database)
      .replaceAll("'classhub_app'@'%'", "'push_qa_app'@'localhost'");
    await sql.raw(grant).execute(admin);
    app = createMariaDbDatabase<DB>(createMysql2MariaDbPool, {
      ...connection,
      sslCa: target.sslCa,
      user: target.appUser,
      password: target.appPassword,
    });
    config = new ConfigService<AppEnvironment, true>({
      DATABASE_ENGINE: "mariadb",
      WEB_PUSH_SUBJECT: "mailto:operator@example.invalid",
      WEB_PUSH_VAPID_PRIVATE_KEY: SERVER_PRIVATE_KEY,
      WEB_PUSH_VAPID_PUBLIC_KEY: OTHER_PUBLIC_KEY,
    });
    service = new PushSubscriptionsService(app, config);
  });

  beforeEach(async () => {
    await admin.deleteFrom("push_subscriptions").execute();
  });

  afterAll(async () => {
    await app?.destroy();
    await admin?.destroy();
  });

  it("공개키 설정을 돌려주고 구독을 저장한다", async () => {
    expect(service.config()).toEqual({ public_key: OTHER_PUBLIC_KEY });
    await save("1", endpoint("a"));
    expect(await rows()).toEqual([
      { user_id: "1", endpoint: endpoint("a"), p256dh: PUBLIC_KEY, auth_secret: AUTH },
    ]);
  });

  it("같은 브라우저 주소를 다른 계정이 구독하면 주인과 키가 바뀐다", async () => {
    await save("1", endpoint("shared"));
    await save("2", endpoint("shared"), OTHER_PUBLIC_KEY);
    expect(await rows()).toEqual([
      { user_id: "2", endpoint: endpoint("shared"), p256dh: OTHER_PUBLIC_KEY, auth_secret: AUTH },
    ]);
  });

  it("같은 계정이 다시 구독해도 한 행만 남는다", async () => {
    await save("1", endpoint("again"));
    await save("1", endpoint("again"));
    expect(await rows()).toHaveLength(1);
  });

  it("본인 구독만 해제하고, 여러 번 해제해도 오류가 없다", async () => {
    await save("1", endpoint("mine"));
    await service.remove("2", endpoint("mine"));
    expect(await rows()).toHaveLength(1);
    await service.remove("1", endpoint("mine"));
    await service.remove("1", endpoint("mine"));
    expect(await rows()).toHaveLength(0);
  });

  it("공식 푸시 서비스가 아닌 주소와 잘못된 키는 저장하지 않는다", async () => {
    for (const target of [
      "http://fcm.googleapis.com/fcm/send/x",
      "https://127.0.0.1/push",
      "https://localhost/push",
      "https://fcm.googleapis.com.evil.example/x",
      "https://fcm.googleapis.com:8443/x",
      "https://user@fcm.googleapis.com/x",
      "https://notify.windows.com/x",
      "https://FCM.googleapis.com/x",
    ]) {
      await expect(save("1", target)).rejects.toBeInstanceOf(PushEndpointNotAllowedException);
    }
    await expect(save("1", endpoint("key"), "A".repeat(87))).rejects.toBeInstanceOf(
      PushEndpointNotAllowedException,
    );
    expect(await rows()).toHaveLength(0);
    await save("1", "https://wns2-sg2p.notify.windows.com/w/?token=qa");
    await save("1", "https://web.push.apple.com/QA-token");
    await save("1", "https://updates.push.services.mozilla.com/wpush/v2/qa");
    expect(await rows()).toHaveLength(3);
  });

  it(`계정당 최근 ${MAX_SUBSCRIPTIONS_PER_USER}개만 남긴다`, async () => {
    for (let index = 0; index < MAX_SUBSCRIPTIONS_PER_USER + 2; index += 1)
      await save("1", endpoint(`cap-${index}`));
    await save("2", endpoint("other-user"));
    const kept = (await rows()).filter((row) => row.user_id === "1").map((row) => row.endpoint);
    expect(kept).toHaveLength(MAX_SUBSCRIPTIONS_PER_USER);
    expect(kept).not.toContain(endpoint("cap-0"));
    expect(kept).not.toContain(endpoint("cap-1"));
    expect(kept).toContain(endpoint(`cap-${MAX_SUBSCRIPTIONS_PER_USER + 1}`));
    expect((await rows()).filter((row) => row.user_id === "2")).toHaveLength(1);
  });

  it("앱 계정은 허용된 열만 바꿀 수 있다", async () => {
    await save("1", endpoint("acl"));
    await expect(
      sql`UPDATE push_subscriptions SET endpoint = 'https://fcm.googleapis.com/x'`.execute(app),
    ).rejects.toThrow();
    await expect(
      sql`UPDATE push_subscriptions SET created_at = UTC_TIMESTAMP(6)`.execute(app),
    ).rejects.toThrow();
    await expect(sql`UPDATE users SET display_name = 'x'`.execute(app)).rejects.toThrow();
  });

  it("발송: 접수된 구독은 세고, 사라진 구독은 지우며, 본문은 수신 기기만 풀 수 있다", async () => {
    await save("1", endpoint("live"));
    await save("1", endpoint("gone"));
    await save("2", endpoint("someone-else"));
    const requests: { url: string; headers: Record<string, string>; body: Buffer }[] = [];
    const fakeFetch = (async (url: URL, init: RequestInit) => {
      requests.push({
        url: url.href,
        headers: init.headers as Record<string, string>,
        body: Buffer.from(init.body as Uint8Array),
      });
      return new Response(null, { status: url.href.endsWith("gone") ? 410 : 201 });
    }) as unknown as typeof fetch;
    const sender = new WebPushSender(app, config, fakeFetch);
    const message = {
      title: "일정 변경",
      body: "국어 발표가 금요일로 바뀌었습니다.",
      path: "/schedules/7",
    };
    expect(await sender.sendToUser("1", message)).toEqual({ accepted: 1, removed: 1, failed: 0 });
    expect(requests.map((request) => request.url).sort()).toEqual(
      [endpoint("gone"), endpoint("live")].sort(),
    );
    for (const request of requests) {
      expect(request.headers).toMatchObject({
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: "86400",
      });
      expect(request.headers.Authorization).toMatch(/^vapid t=[^.]+\.[^.]+\.[^,]+, k=/u);
      expect(decryptReceived(request.body)).toEqual(message);
    }
    expect((await rows()).map((row) => row.endpoint).sort()).toEqual(
      [endpoint("live"), endpoint("someone-else")].sort(),
    );
  });

  it("발송: 허용 목록 밖 주소는 요청하지 않고 지운다", async () => {
    await sql`INSERT INTO push_subscriptions (user_id,endpoint,p256dh,auth_secret)
      VALUES (1,'https://internal.example.invalid/push',${PUBLIC_KEY},${AUTH})`.execute(admin);
    let called = 0;
    const fakeFetch = (async () => {
      called += 1;
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    const sender = new WebPushSender(app, config, fakeFetch);
    expect(await sender.sendToUser("1", { title: "t", body: "b", path: "/home" })).toEqual({
      accepted: 0,
      removed: 1,
      failed: 0,
    });
    expect(called).toBe(0);
    expect(await rows()).toHaveLength(0);
  });

  it("계정이 삭제되면 구독도 함께 지워진다", async () => {
    await save("3", endpoint("cascade"));
    await admin.deleteFrom("users").where("id", "=", "3").execute();
    expect(await rows()).toHaveLength(0);
  });
});
