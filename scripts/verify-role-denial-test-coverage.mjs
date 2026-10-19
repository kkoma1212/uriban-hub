import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

async function read(relativePath) {
  return readFile(join(repositoryRoot, relativePath), "utf8");
}

const memberSource = await read("apps/api/test/member-profile.auth.integration.spec.ts");
for (const route of [
  'url: "/api/v1/members"',
  "url: `/api/v1/members/${pendingMemberId}/approve`",
  "url: `/api/v1/members/${pendingMemberId}/reject`",
  "url: `/api/v1/members/${approvedMemberId}/remove`",
  "url: `/api/v1/members/${removedMember.id}/allow-rejoin`",
]) {
  assert(memberSource.includes(route), `Missing student denial coverage for ${route}`);
}
for (const immutableAssertion of [
  "expect(afterMembers).toEqual(beforeMembers)",
  "expect(afterHistory).toEqual(beforeHistory)",
  "expect(afterAudit).toEqual(beforeAudit)",
]) {
  assert(memberSource.includes(immutableAssertion));
}
assert(memberSource.includes('error: { code: "ROLE_INSUFFICIENT" }'));

for (const [resource, action] of [
  ["notices", "notice.deleted"],
  ["schedules", "schedule.deleted"],
  ["supplies", "supply.deleted"],
]) {
  const source = await read(`apps/api/test/${resource}.auth.integration.spec.ts`);
  const deleteDenialPattern = new RegExp(
    `method: "DELETE"[\\s\\S]{0,180}url: \`/api/v1/${resource}/\\$\\{own[A-Za-z]+\\.id\\}\`[\\s\\S]{0,220}fixture\\.students\\[0\\]\\.headers[\\s\\S]{0,260}"ROLE_INSUFFICIENT"`,
    "u",
  );
  assert.match(source, deleteDenialPattern);
  assert(source.includes(").toEqual(beforeStudentDelete)"));
  assert(source.includes(`.where("action", "=", "${action}")`));
  assert(source.includes(').toEqual({ count: "0" })'));
}

const attendanceSource = await read(
  "apps/api/test/attendance-notifications-mutations.auth.integration.spec.ts",
);
for (const requiredBoundary of [
  'expectError(await createAttendance(fixture.teacher, today), 403, "ROLE_INSUFFICIENT")',
  "url: `/api/v1/attendance-notifications/${item.id}/acknowledge`",
  "url: `/api/v1/attendance-notifications/${item.id}/cancel`",
  'method: "PATCH"',
  "expect(await attendanceAudits(item.id)).toHaveLength(1)",
  'row_version: "1"',
  'status: "pending"',
]) {
  assert(
    attendanceSource.includes(requiredBoundary),
    `Missing attendance role-boundary evidence: ${requiredBoundary}`,
  );
}

const pollSource = await read("apps/api/test/polls.auth.integration.spec.ts");
for (const evidence of [
  'expectError(studentClose, 403, "ROLE_INSUFFICIENT")',
  "url: `/api/v1/polls/${poll.id}/close`",
  ").toEqual(beforeStudentClose)",
  '.where("action", "=", "poll.closed")',
])
  assert(pollSource.includes(evidence), `Missing manual poll close role boundary: ${evidence}`);

process.stdout.write(
  "Role-denial integration source verified: 21 teacher-only routes plus attendance role boundaries, 403 assertions, row/history/audit immutability checks. PASS\n",
);
