import assert from "node:assert/strict";
import { verifyTeamDrawEvidence } from "./0012_team_draws_evidence.mjs";
import { verifyDutyRosterEvidence } from "./0013_duty_rosters_evidence.mjs";
import { verifyAuditCatalogEvidence } from "./0014_audit_action_catalog_evidence.mjs";
import { verifyElectionEvidence } from "./0015_elections_evidence.mjs";
import { verifyLayoutDraftEvidence } from "./0016_layout_draft_autosaves_evidence.mjs";
import { verifyLayoutTemplateEvidence } from "./0017_classroom_layout_templates_evidence.mjs";

import { verifyCommonEvidence } from "./0018_0019_common_evidence.mjs";

import { verifyAdminAuthEvidence } from "./0020_admin_auth_evidence.mjs";
import { verifyAdminFeatureEvidence } from "./0021_0024_admin_features_evidence.mjs";

// Feature-owned contracts stay separate from the shared manifest inventory checks.
const evidenceVerifiers = {
  "0012_team_draws": verifyTeamDrawEvidence,
  "0013_duty_rosters": verifyDutyRosterEvidence,
  "0014_audit_action_catalog": verifyAuditCatalogEvidence,
  "0015_elections": verifyElectionEvidence,
  "0016_layout_draft_autosaves": verifyLayoutDraftEvidence,
  "0017_classroom_layout_templates": verifyLayoutTemplateEvidence,
  "0018_public_holidays": verifyCommonEvidence,
  "0019_guardian_consent_requests": verifyCommonEvidence,
  "0020_admin_auth": verifyAdminAuthEvidence,
  "0021_admin_signup_approvals": verifyAdminFeatureEvidence,
  "0022_admin_inquiries_system_state": verifyAdminFeatureEvidence,
  "0023_admin_terms_management": verifyAdminFeatureEvidence,
  "0024_admin_account_management": verifyAdminFeatureEvidence,
};

export async function verifyFeaturePhaseEvidence(phase, readRepositoryFile) {
  assert.ok(
    Object.hasOwn(evidenceVerifiers, phase.id),
    `parser-smoke-verified phase ${phase.id} has no evidence contract`,
  );
  await evidenceVerifiers[phase.id](phase, readRepositoryFile);
}
