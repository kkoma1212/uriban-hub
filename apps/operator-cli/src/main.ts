import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import {
  hasRuntimeObservationSettings,
  runtimeInspectionHoldMs,
  holdRuntimeObservationForInspection,
} from "@classhub/db";

import { importMeals } from "./meal-import.js";
import { syncNeisMeals } from "./neis-meal-sync.js";
import { syncPublicHolidays } from "./kasi-holiday-sync.js";
import { syncNeisSchoolSchedules } from "./neis-school-schedule-sync.js";
import { syncNeisSchools } from "./neis-school-sync.js";
import { openOperatorDatabase, requireOperatorDatabaseUrl } from "./operator-database.js";
import { bootstrapOperator } from "./operator-bootstrap.js";
import {
  renderAdminProvisionOutput,
  renderBootstrapSecretOutput,
  renderTeacherPasswordResetOutput,
  renderTeacherProvisionOutput,
  runInteractiveSecretCommand,
} from "./secret-output.js";
import { importSchools } from "./school-import.js";
import { provisionTeacher, resetTeacherPassword } from "./teacher-provision.js";
import { transferClassTeacher } from "./class-transfer.js";
import { provisionAdmin } from "./admin-provision.js";

const { positionals, values } = parseArgs({
  // Observation accepts only its exact command; never parse or echo supplied options.
  args:
    process.argv[2] === "observe-database"
      ? ["observe-database"]
      : hasRuntimeObservationSettings(process.env)
        ? ["observation-forbidden"]
        : process.argv.slice(2),
  allowPositionals: true,
  options: {
    "class-id": { type: "string" },
    "display-name": { type: "string" },
    "dry-run": { type: "boolean", default: false },
    "edu-office-code": { type: "string" },
    email: { type: "string" },
    file: { type: "string" },
    force: { type: "boolean", default: false },
    from: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
    reason: { type: "string" },
    role: { type: "string" },
    "replace-seed": { type: "boolean", default: false },
    "school-code": { type: "string" },
    to: { type: "string" },
    "to-email": { type: "string" },
    year: { type: "string" },
  },
});

function printHelp(): void {
  process.stdout.write(
    [
      "우리반 허브 운영 CLI",
      "",
      "명령:",
      "  observe-database (선택적 비공개 DB 관측만 수행, 업무 실행 없음)",
      "  check-database (연결·TLS·운영 계정 권한 확인, 데이터 변경 없음)",
      "  bootstrap-operator --email admin@classhub.local",
      "  import-schools --file data/seeds/schools/example.schools.json --dry-run",
      "  import-schools --file data/seeds/schools/example.schools.json",
      "  sync-neis-schools --dry-run",
      "  sync-neis-schools",
      '  provision-teacher --email teacher@example.com --display-name "담임 선생님"',
      '  provision-admin --email admin@example.com --display-name "서비스 관리자" --role security_auditor',
      "  reset-teacher-password --email teacher@example.com [--force]",
      '  transfer-class --class-id 12 --to-email new-teacher@example.com --reason "휴직 대체"',
      "  import-meals --file data/seeds/meals/2026-07.json",
      "  sync-neis-meals --edu-office-code M10 --school-code 8021028 --from 2026-07-01 --to 2026-07-31 --dry-run",
      "  sync-neis-meals --edu-office-code M10 --school-code 8021028 --from 2026-07-01 --to 2026-07-31",
      "  sync-neis-school-schedules --edu-office-code J10 --school-code 7530063 --from 2026-03-01 --to 2027-02-28 --dry-run",
      "  sync-neis-school-schedules --edu-office-code J10 --school-code 7530063 --from 2026-03-01 --to 2027-02-28",
      "  sync-public-holidays --year 2026 --dry-run",
      "  sync-public-holidays --year 2026",
      "",
      "bootstrap 외 명령의 operator token은 명령행·환경변수가 아니라 숨김 stdin으로 입력합니다.",
      "token·임시 비밀번호 생성 명령은 stdout이 연결된 대화형 터미널에서만 실행됩니다.",
      "필수 환경값: OPERATOR_DATABASE_URL",
      "MariaDB 추가 환경값: DATABASE_ENGINE=mariadb, OPERATOR_DATABASE_TLS_CA_FILE, OPERATOR_DATABASE_ACCOUNT_HOST",
      "bootstrap 추가 환경값: OPERATOR_BOOTSTRAP_SECRET",
      "NEIS 동기화 추가 환경값: NEIS_API_KEY",
      "공휴일 동기화 추가 환경값: KASI_HOLIDAY_API_KEY (공공데이터포털 한국천문연구원 특일 정보)",
      "공휴일 동기화는 그 해 안에서만 지웁니다 — 다른 해의 공휴일은 건드리지 않습니다.",
      "근로자의 날은 학교가 정상 수업하므로 공휴일 목록에서 제외합니다.",
      "NEIS 학교 동기화는 초·중·고만 포함하고 다른 학교급은 제외 건수로 보고합니다.",
      "NEIS 학교 동기화는 원격에 없는 기존 학교를 삭제하지 않습니다.",
      "NEIS 급식 동기화는 원격에 없는 기존 급식을 삭제하지 않으며 seed 행은 기본적으로 보존합니다.",
      "seed 행 교체는 영향 확인 후 --replace-seed를 명시한 경우에만 수행합니다.",
      "",
    ].join("\n"),
  );
}

async function readPipedSecret(): Promise<string> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  for await (const line of lines) {
    lines.close();
    return line.trim();
  }
  return "";
}

async function readHiddenSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    process.stderr.write(prompt);
    return readPipedSecret();
  }

  return new Promise<string>((resolve, reject) => {
    let value = "";
    const cleanup = (): void => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write("\n");
    };
    const onData = (chunk: Buffer | string): void => {
      for (const character of chunk.toString()) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("operator token 입력이 취소되었습니다."));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(value.trim());
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    };

    process.stderr.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

async function runBootstrap(): Promise<void> {
  const email = values.email;
  if (email === undefined) throw new Error("--email이 필요합니다.");
  await runInteractiveSecretCommand(async () => {
    const operatorDatabaseUrl = requireOperatorDatabaseUrl(process.env.OPERATOR_DATABASE_URL);
    return bootstrapOperator({
      bootstrapSecret: process.env.OPERATOR_BOOTSTRAP_SECRET,
      email,
      operatorDatabaseUrl,
    });
  }, renderBootstrapSecretOutput);
}

async function runMealImport(): Promise<void> {
  if (values.file === undefined) throw new Error("--file이 필요합니다.");
  const operatorDatabaseUrl = requireOperatorDatabaseUrl(process.env.OPERATOR_DATABASE_URL);
  const operatorToken = await readHiddenSecret("Operator token: ");
  const result = await importMeals({
    filePath: values.file,
    operatorDatabaseUrl,
    operatorToken,
  });
  process.stdout.write(
    [
      "급식 import 완료",
      `RUN_ID=${result.runId}`,
      `CHECKSUM=${result.checksum}`,
      `INSERTED=${result.insertedCount}`,
      `UPDATED=${result.updatedCount}`,
      `DELETED=${result.deletedCount}`,
      `SKIPPED=${result.skippedCount}`,
      `FAILED=${result.failedCount}`,
      "",
    ].join("\n"),
  );
}

async function runSchoolImport(): Promise<void> {
  if (values.file === undefined) throw new Error("--file이 필요합니다.");
  const operatorDatabaseUrl = requireOperatorDatabaseUrl(process.env.OPERATOR_DATABASE_URL);
  const operatorToken = await readHiddenSecret("Operator token: ");
  const result = await importSchools({
    dryRun: values["dry-run"],
    filePath: values.file,
    operatorDatabaseUrl,
    operatorToken,
  });
  process.stdout.write(
    [
      result.dryRun ? "학교 import dry-run 완료" : "학교 import 완료",
      `RUN_ID=${result.runId}`,
      `CHECKSUM=${result.checksum}`,
      `INSERTED=${result.insertedCount}`,
      `UPDATED=${result.updatedCount}`,
      `SKIPPED=${result.skippedCount}`,
      `FAILED=${result.failedCount}`,
      ...(result.dryRun ? ["dry-run은 DB 데이터와 감사 로그를 변경하지 않았습니다."] : []),
      "",
    ].join("\n"),
  );
}

async function runNeisMealSync(): Promise<void> {
  if (values["edu-office-code"] === undefined) throw new Error("--edu-office-code가 필요합니다.");
  if (values["school-code"] === undefined) throw new Error("--school-code가 필요합니다.");
  if (values.from === undefined) throw new Error("--from이 필요합니다.");
  if (values.to === undefined) throw new Error("--to가 필요합니다.");
  const operatorDatabaseUrl = requireOperatorDatabaseUrl(process.env.OPERATOR_DATABASE_URL);
  const operatorToken = await readHiddenSecret("Operator token: ");
  const result = await syncNeisMeals({
    apiKey: process.env.NEIS_API_KEY,
    dryRun: values["dry-run"],
    eduOfficeCode: values["edu-office-code"],
    from: values.from,
    operatorDatabaseUrl,
    operatorToken,
    replaceSeed: values["replace-seed"],
    schoolCode: values["school-code"],
    to: values.to,
  });
  process.stdout.write(
    [
      result.dryRun ? "NEIS 급식 동기화 dry-run 완료" : "NEIS 급식 동기화 완료",
      `RUN_ID=${result.runId}`,
      `CHECKSUM=${result.checksum}`,
      `INSERTED=${result.insertedCount}`,
      `UPDATED=${result.updatedCount}`,
      `REPLACED_SEED=${result.replacedSeedCount}`,
      `SKIPPED=${result.skippedCount}`,
      `FAILED=${result.failedCount}`,
      ...(result.dryRun ? ["dry-run은 DB 데이터와 감사 로그를 변경하지 않았습니다."] : []),
      "",
    ].join("\n"),
  );
}

async function runNeisSchoolSync(): Promise<void> {
  const operatorDatabaseUrl = requireOperatorDatabaseUrl(process.env.OPERATOR_DATABASE_URL);
  const operatorToken = await readHiddenSecret("Operator token: ");
  const result = await syncNeisSchools({
    apiKey: process.env.NEIS_API_KEY,
    dryRun: values["dry-run"],
    operatorDatabaseUrl,
    operatorToken,
  });
  process.stdout.write(
    [
      result.dryRun ? "NEIS 학교 동기화 dry-run 완료" : "NEIS 학교 동기화 완료",
      `RUN_ID=${result.runId}`,
      `CHECKSUM=${result.checksum}`,
      `SOURCE_TOTAL=${result.sourceCount}`,
      `FETCHED=${result.fetchedCount}`,
      `IGNORED_INVALID_IDENTIFIER=${result.ignoredInvalidIdentifierCount}`,
      `IGNORED_UNSUPPORTED=${result.ignoredUnsupportedCount}`,
      `BLANKED_OPTIONAL_FIELDS=${result.blankedOptionalFieldCount}`,
      `INSERTED=${result.insertedCount}`,
      `UPDATED=${result.updatedCount}`,
      `SKIPPED=${result.skippedCount}`,
      `FAILED=${result.failedCount}`,
      ...(result.dryRun ? ["dry-run은 DB 데이터와 감사 로그를 변경하지 않았습니다."] : []),
      "",
    ].join("\n"),
  );
}

async function runNeisSchoolScheduleSync(): Promise<void> {
  if (values["edu-office-code"] === undefined) {
    throw new Error("--edu-office-code is required.");
  }
  if (values["school-code"] === undefined) throw new Error("--school-code is required.");
  if (values.from === undefined) throw new Error("--from is required.");
  if (values.to === undefined) throw new Error("--to is required.");
  const operatorDatabaseUrl = requireOperatorDatabaseUrl(process.env.OPERATOR_DATABASE_URL);
  const operatorToken = await readHiddenSecret("Operator token: ");
  const result = await syncNeisSchoolSchedules({
    apiKey: process.env.NEIS_API_KEY,
    dryRun: values["dry-run"],
    eduOfficeCode: values["edu-office-code"],
    from: values.from,
    operatorDatabaseUrl,
    operatorToken,
    schoolCode: values["school-code"],
    to: values.to,
  });
  process.stdout.write(
    [
      result.dryRun
        ? "NEIS school schedule sync dry-run complete"
        : "NEIS school schedule sync complete",
      `RUN_ID=${result.runId}`,
      `CHECKSUM=${result.checksum}`,
      `INSERTED=${result.insertedCount}`,
      `UPDATED=${result.updatedCount}`,
      "DELETED=0",
      `SKIPPED=${result.skippedCount}`,
      `FAILED=${result.failedCount}`,
      ...(result.dryRun ? ["dry-run did not change events or audit logs."] : []),
      "",
    ].join("\n"),
  );
}

async function runPublicHolidaySync(): Promise<void> {
  if (values.year === undefined) throw new Error("--year is required.");
  const year = Number(values.year);
  if (!Number.isInteger(year)) throw new Error("--year must be a four digit year.");
  const operatorDatabaseUrl = requireOperatorDatabaseUrl(process.env.OPERATOR_DATABASE_URL);
  const operatorToken = await readHiddenSecret("Operator token: ");
  const result = await syncPublicHolidays({
    apiKey: process.env.KASI_HOLIDAY_API_KEY,
    dryRun: values["dry-run"],
    operatorDatabaseUrl,
    operatorToken,
    year,
  });
  process.stdout.write(
    [
      result.dryRun ? "Public holiday sync dry-run complete" : "Public holiday sync complete",
      `YEAR=${result.year}`,
      `RUN_ID=${result.runId}`,
      `CHECKSUM=${result.checksum}`,
      `INSERTED=${result.insertedCount}`,
      `UPDATED=${result.updatedCount}`,
      `DELETED=${result.deletedCount}`,
      `SKIPPED=${result.skippedCount}`,
      `FAILED=${result.failedCount}`,
      ...(result.dryRun ? ["dry-run did not change holidays or audit logs."] : []),
      "",
    ].join("\n"),
  );
}

async function runTeacherProvision(): Promise<void> {
  const email = values.email;
  const displayName = values["display-name"];
  if (email === undefined) throw new Error("--email이 필요합니다.");
  if (displayName === undefined) throw new Error("--display-name이 필요합니다.");
  await runInteractiveSecretCommand(async () => {
    const operatorDatabaseUrl = requireOperatorDatabaseUrl(process.env.OPERATOR_DATABASE_URL);
    const operatorToken = await readHiddenSecret("Operator token: ");
    return provisionTeacher({
      displayName,
      email,
      operatorDatabaseUrl,
      operatorToken,
    });
  }, renderTeacherProvisionOutput);
}

async function runAdminProvision(): Promise<void> {
  const email = values.email;
  const displayName = values["display-name"];
  const role = values.role;
  if (email === undefined) throw new Error("--email이 필요합니다.");
  if (displayName === undefined) throw new Error("--display-name이 필요합니다.");
  if (role === undefined) throw new Error("--role이 필요합니다.");

  await runInteractiveSecretCommand(async () => {
    const operatorDatabaseUrl = requireOperatorDatabaseUrl(process.env.OPERATOR_DATABASE_URL);
    const operatorToken = await readHiddenSecret("Operator token: ");
    return provisionAdmin({
      displayName,
      email,
      operatorDatabaseUrl,
      operatorToken,
      role,
    });
  }, renderAdminProvisionOutput);
}

async function runTeacherPasswordReset(): Promise<void> {
  const email = values.email;
  if (email === undefined) throw new Error("--email이 필요합니다.");
  await runInteractiveSecretCommand(async () => {
    const operatorDatabaseUrl = requireOperatorDatabaseUrl(process.env.OPERATOR_DATABASE_URL);
    const operatorToken = await readHiddenSecret("Operator token: ");
    return resetTeacherPassword({
      email,
      force: values.force,
      operatorDatabaseUrl,
      operatorToken,
    });
  }, renderTeacherPasswordResetOutput);
}

async function runClassTransfer(): Promise<void> {
  if (values["class-id"] === undefined) throw new Error("--class-id가 필요합니다.");
  if (values["to-email"] === undefined) throw new Error("--to-email이 필요합니다.");
  const operatorDatabaseUrl = requireOperatorDatabaseUrl(process.env.OPERATOR_DATABASE_URL);
  const operatorToken = await readHiddenSecret("Operator token: ");
  const result = await transferClassTeacher({
    classId: values["class-id"],
    operatorDatabaseUrl,
    operatorToken,
    reason: values.reason,
    toEmail: values["to-email"],
  });
  process.stdout.write(
    [
      "학급 담임 이관 완료",
      `RUN_ID=${result.runId}`,
      `CLASS_ID=${result.classId}`,
      `FROM_TEACHER_USER_ID=${result.fromUserId}`,
      `TO_TEACHER_USER_ID=${result.toUserId}`,
      `TO_TEACHER_EMAIL=${result.toEmail}`,
      "이전 담임은 이 반에 더 접근할 수 없습니다. 필요하면 이제 revoke할 수 있습니다.",
      "",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const observationConfigured = hasRuntimeObservationSettings(process.env);
  if (positionals[0] === "observe-database") {
    if (process.argv.slice(2).length !== 1 || !observationConfigured)
      throw new Error("MARIADB_RUNTIME_OBSERVATION_FAILED");
    const inspectionHold = runtimeInspectionHoldMs(process.env);
    const database = await openOperatorDatabase(process.env.OPERATOR_DATABASE_URL);
    await database.destroy();
    await holdRuntimeObservationForInspection(inspectionHold);
    process.stdout.write("MARIADB_RUNTIME_OBSERVATION_PASS\n");
    return;
  }
  if (observationConfigured) throw new Error("MARIADB_RUNTIME_OBSERVATION_FAILED");
  if (values.help || positionals.length === 0) {
    printHelp();
    return;
  }
  if (positionals[0] === "check-database") {
    const database = await openOperatorDatabase(process.env.OPERATOR_DATABASE_URL);
    await database.destroy();
    process.stdout.write("운영 DB 연결·계정 권한 확인 완료\n");
    return;
  }
  if (positionals[0] === "bootstrap-operator") {
    await runBootstrap();
    return;
  }
  if (positionals[0] === "import-meals") {
    await runMealImport();
    return;
  }
  if (positionals[0] === "import-schools") {
    await runSchoolImport();
    return;
  }
  if (positionals[0] === "sync-neis-schools") {
    await runNeisSchoolSync();
    return;
  }
  if (positionals[0] === "sync-neis-meals") {
    await runNeisMealSync();
    return;
  }
  if (positionals[0] === "sync-neis-school-schedules") {
    await runNeisSchoolScheduleSync();
    return;
  }
  if (positionals[0] === "sync-public-holidays") {
    await runPublicHolidaySync();
    return;
  }
  if (positionals[0] === "provision-teacher") {
    await runTeacherProvision();
    return;
  }
  if (positionals[0] === "provision-admin") {
    await runAdminProvision();
    return;
  }
  if (positionals[0] === "reset-teacher-password") {
    await runTeacherPasswordReset();
    return;
  }
  if (positionals[0] === "transfer-class") {
    await runClassTransfer();
    return;
  }
  throw new Error(`지원하지 않는 운영 명령입니다: ${positionals[0]}`);
}

void main().catch((error: unknown) => {
  if (positionals[0] === "observe-database" || hasRuntimeObservationSettings(process.env)) {
    process.stderr.write("MARIADB_RUNTIME_OBSERVATION_FAILED\n");
    process.exitCode = 1;
    return;
  }
  const message = error instanceof Error ? error.message : "알 수 없는 오류";
  process.stderr.write(`운영 명령 실패: ${message}\n`);
  process.exitCode = 1;
});
