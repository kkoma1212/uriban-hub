import { openConfiguredRetentionDatabase } from "./configured-database.js";
import {
  hasRuntimeObservationSettings,
  runtimeInspectionHoldMs,
  holdRuntimeObservationForInspection,
} from "@classhub/db";
import { assertRetentionTargetAvailable, runRetentionCommand } from "./commands.js";
import { parseRetentionCommand } from "./cli-arguments.js";
import { loadRetentionEnvironment } from "./environment.js";
import { recordJobFailure } from "./job-audit.js";

// 어느 잡이 죽었는지 출력에 적는다. 잡 이름 없는 실패 한 줄로는 무엇을 다시
// 돌려야 하는지 알 수 없다. 대상을 알기 전(인자·환경·연결) 실패는 job이 null이다.
function writeFailure(job: string | null, error: unknown): void {
  const errorName = error instanceof Error ? error.name : "UnknownError";
  process.stderr.write(
    `${JSON.stringify({ error: "retention_cli_failed", error_name: errorName, job })}\n`,
  );
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const observationConfigured = hasRuntimeObservationSettings(process.env);
  if (args[0] === "observe-database") {
    if (args.length !== 1 || !observationConfigured)
      throw new Error("MARIADB_RUNTIME_OBSERVATION_FAILED");
    const inspectionHold = runtimeInspectionHoldMs(process.env);
    const environment = loadRetentionEnvironment();
    const database = await openConfiguredRetentionDatabase(environment);
    await database.destroy();
    await holdRuntimeObservationForInspection(inspectionHold);
    process.stdout.write("MARIADB_RUNTIME_OBSERVATION_PASS\n");
    return;
  }
  if (observationConfigured) throw new Error("MARIADB_RUNTIME_OBSERVATION_FAILED");
  const command = parseRetentionCommand(process.argv.slice(2));
  const environment = loadRetentionEnvironment();
  assertRetentionTargetAvailable(command, environment.databaseEngine);
  const database = await openConfiguredRetentionDatabase(environment);
  try {
    const result = await runRetentionCommand(database, command, environment.databaseEngine, {
      mailLogsGrantInstalled: environment.mariaDb?.mailLogsGrantInstalled === true,
      auditConsentsGrantInstalled: environment.mariaDb?.auditConsentsGrantInstalled === true,
      adminRecordsGrantInstalled: environment.mariaDb?.adminRecordsGrantInstalled === true,
      classArchivesGrantProfile: environment.mariaDb?.classArchivesGrantProfile ?? "none",
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.capped) process.exitCode = 2;
  } catch (error) {
    // 삭제 잡의 성공 기록은 삭제와 같은 트랜잭션 안에 있어 롤백되면 함께 사라진다.
    // 실패 기록은 여기, 트랜잭션 밖에서 남겨야 남는다.
    if (command.mode === "execute") {
      try {
        await recordJobFailure(database, command.target, error, environment.databaseEngine);
      } catch (auditError) {
        // 기록에 실패했다고 원래 오류를 덮지 않는다. 둘 다 알려준다.
        writeFailure(command.target, auditError);
      }
    }
    writeFailure(command.target, error);
  } finally {
    await database.destroy();
  }
}

void main().catch((error: unknown) => {
  if (process.argv[2] === "observe-database" || hasRuntimeObservationSettings(process.env)) {
    process.stderr.write("MARIADB_RUNTIME_OBSERVATION_FAILED\n");
    process.exitCode = 1;
    return;
  }
  writeFailure(null, error);
});
