import type { RetentionMode } from "./student-assessment-retention.js";

export type RetentionTarget =
  | "class-archives"
  | "attendance-notifications"
  | "guardian-consent-requests"
  | "layout-draft-autosaves"
  | "policy-records"
  | "student-assessments"
  | "temporary-password-reminders";

const RETENTION_TARGETS: readonly string[] = [
  "class-archives",
  "attendance-notifications",
  "guardian-consent-requests",
  "layout-draft-autosaves",
  "policy-records",
  "student-assessments",
  "temporary-password-reminders",
];

export interface RetentionCommand {
  mode: RetentionMode;
  target: RetentionTarget;
}

export function parseRetentionMode(arguments_: readonly string[]): RetentionMode {
  if (arguments_.length !== 1 || !["--dry-run", "--execute"].includes(arguments_[0]!)) {
    throw new Error("Exactly one mode is required: --dry-run or --execute.");
  }
  return arguments_[0] === "--execute" ? "execute" : "dry-run";
}

export function parseRetentionCommand(arguments_: readonly string[]): RetentionCommand {
  const modeArguments = arguments_.filter((argument) =>
    ["--dry-run", "--execute"].includes(argument),
  );
  const targetArguments = arguments_.filter((argument) => argument.startsWith("--target="));
  const knownArguments = [...modeArguments, ...targetArguments];
  if (
    knownArguments.length !== arguments_.length ||
    modeArguments.length !== 1 ||
    targetArguments.length > 1
  ) {
    throw new Error(
      `Exactly one mode and at most one target are required: --dry-run|--execute [--target=${RETENTION_TARGETS.join("|")}].`,
    );
  }

  const target = targetArguments[0]?.slice("--target=".length) ?? "student-assessments";
  if (!RETENTION_TARGETS.includes(target)) {
    throw new Error(`Retention target must be one of: ${RETENTION_TARGETS.join(", ")}.`);
  }

  return {
    mode: parseRetentionMode(modeArguments),
    target: target as RetentionTarget,
  };
}
