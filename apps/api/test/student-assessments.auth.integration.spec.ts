import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";

import type {
  StudentAssessmentItem,
  StudentAssessmentListResult,
} from "../src/student-assessments/student-assessments.types.js";
import {
  app,
  type ClassFixture,
  createClassFixture,
  database,
  setupStudentAssessmentsHarness,
  teardownSuppliesHarness,
} from "./supplies-test-harness.js";

let fixture: ClassFixture;

function expectError(
  response: { json(): { error: { code: string } }; statusCode: number },
  status: number,
  code: string,
): void {
  expect(response.statusCode).toBe(status);
  expect(response.json().error.code).toBe(code);
}

beforeAll(setupStudentAssessmentsHarness, 120_000);

beforeEach(async () => {
  fixture = await createClassFixture();
});

afterAll(teardownSuppliesHarness, 120_000);

describe.sequential("student-owned assessment records", () => {
  it("keeps the module student-only and advertises the enabled action only to students", async () => {
    expectError(
      await app.inject({ method: "GET", url: "/api/v1/my-assessments" }),
      401,
      "UNAUTHENTICATED",
    );
    expectError(
      await app.inject({
        headers: fixture.teacher.headers,
        method: "GET",
        url: "/api/v1/my-assessments",
      }),
      403,
      "ROLE_INSUFFICIENT",
    );

    const studentBootstrap = await app.inject({
      headers: fixture.students[0].headers,
      method: "GET",
      url: "/api/v1/bootstrap",
    });
    const teacherBootstrap = await app.inject({
      headers: fixture.teacher.headers,
      method: "GET",
      url: "/api/v1/bootstrap",
    });
    expect(studentBootstrap.statusCode).toBe(200);
    expect(studentBootstrap.json().allowed_actions).toContain("MANAGE_OWN_ASSESSMENTS");
    expect(teacherBootstrap.statusCode).toBe(200);
    expect(teacherBootstrap.json().allowed_actions).not.toContain("MANAGE_OWN_ASSESSMENTS");
  });

  it("autosaves a private draft with ETags, completes it, and exports safe CSV", async () => {
    const owner = fixture.students[0];
    const createHeaders = {
      ...owner.headers,
      "idempotency-key": "10000000-0000-4000-8000-000000000001",
    };
    const createResponse = await app.inject({
      headers: createHeaders,
      method: "POST",
      payload: { subject: "수학" },
      url: "/api/v1/my-assessments",
    });
    expect(createResponse.statusCode, createResponse.body).toBe(201);
    const draft = createResponse.json() as StudentAssessmentItem;
    expect(draft).toMatchObject({
      row_version: "1",
      status: "draft",
      subject: "수학",
    });
    expect(createResponse.headers.etag).toBe('"1"');

    const replayResponse = await app.inject({
      headers: createHeaders,
      method: "POST",
      payload: { subject: "수학" },
      url: "/api/v1/my-assessments",
    });
    expect(replayResponse.statusCode).toBe(201);
    expect(replayResponse.json()).toEqual(draft);

    const otherStudentResponse = await app.inject({
      headers: fixture.students[1].headers,
      method: "GET",
      url: `/api/v1/my-assessments/${draft.id}`,
    });
    expectError(otherStudentResponse, 404, "NOT_FOUND");

    const incompleteResponse = await app.inject({
      headers: { ...owner.headers, "if-match": '"1"' },
      method: "POST",
      url: `/api/v1/my-assessments/${draft.id}/complete`,
    });
    expectError(incompleteResponse, 400, "VALIDATION_FAILED");

    const updateResponse = await app.inject({
      headers: { ...owner.headers, "if-match": '"1"' },
      method: "PATCH",
      payload: {
        academic_year: 2026,
        assessment_date: "2026-07-30",
        assessment_type: "performance",
        max_score_hundredths: 10_000,
        memo: "=SUM(A1:A2)",
        score_hundredths: 9_250,
        semester: 1,
        title: "+개인 수행평가",
        weight_basis_points: 3_000,
      },
      url: `/api/v1/my-assessments/${draft.id}`,
    });
    expect(updateResponse.statusCode, updateResponse.body).toBe(200);
    const saved = updateResponse.json() as StudentAssessmentItem;
    expect(saved).toMatchObject({
      row_version: "2",
      score_hundredths: 9_250,
      status: "draft",
      title: "+개인 수행평가",
    });
    expect(updateResponse.headers.etag).toBe('"2"');

    const staleResponse = await app.inject({
      headers: { ...owner.headers, "if-match": '"1"' },
      method: "PATCH",
      payload: { memo: "오래된 저장" },
      url: `/api/v1/my-assessments/${draft.id}`,
    });
    expectError(staleResponse, 409, "RESOURCE_VERSION_CHANGED");

    const completeResponse = await app.inject({
      headers: { ...owner.headers, "if-match": '"2"' },
      method: "POST",
      url: `/api/v1/my-assessments/${draft.id}/complete`,
    });
    expect(completeResponse.statusCode, completeResponse.body).toBe(200);
    const recorded = completeResponse.json() as StudentAssessmentItem;
    expect(recorded).toMatchObject({ row_version: "3", status: "recorded" });
    expect(recorded.recorded_at).not.toBeNull();
    expect(
      new Date(recorded.expires_at).getTime() - new Date(recorded.recorded_at!).getTime(),
    ).toBe(365 * 24 * 60 * 60 * 1_000);

    const csvResponse = await app.inject({
      headers: owner.headers,
      method: "GET",
      url: "/api/v1/my-assessments/export.csv?academic_year=2026&semester=1",
    });
    expect(csvResponse.statusCode, csvResponse.body).toBe(200);
    expect(csvResponse.headers["content-type"]).toContain("text/csv");
    expect(csvResponse.body.startsWith("\uFEFF")).toBe(true);
    expect(csvResponse.body).toContain('"수행평가"');
    expect(csvResponse.body).toContain('"\'+개인 수행평가"');
    expect(csvResponse.body).toContain('"\'=SUM(A1:A2)"');
    expect(csvResponse.body).toContain('"92.5"');
    expect(csvResponse.body).toContain('"27.75"');

    await database
      .insertInto("student_assessment_records")
      .values({
        created_at: sql<Date>`clock_timestamp() - interval '40 days'`,
        expires_at: sql<Date>`clock_timestamp() - interval '1 day'`,
        owner_user_id: owner.userId,
        subject: "만료",
        title: "목록에 보이면 안 되는 초안",
        updated_at: sql<Date>`clock_timestamp() - interval '1 day'`,
      })
      .execute();
    const listResponse = await app.inject({
      headers: owner.headers,
      method: "GET",
      url: "/api/v1/my-assessments",
    });
    expect(listResponse.statusCode).toBe(200);
    const list = listResponse.json() as StudentAssessmentListResult;
    expect(list.items.map((item) => item.id)).toEqual([recorded.id]);

    const deleteResponse = await app.inject({
      headers: { ...owner.headers, "if-match": '"3"' },
      method: "DELETE",
      url: `/api/v1/my-assessments/${recorded.id}`,
    });
    expect(deleteResponse.statusCode, deleteResponse.body).toBe(204);
    const deletedCount = await database
      .selectFrom("student_assessment_records")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("id", "=", recorded.id)
      .executeTakeFirstOrThrow();
    expect(deletedCount.count).toBe("0");
  });
});
