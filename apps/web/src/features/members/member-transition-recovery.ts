import { listMembers } from "../../api/auth";
import { isMutationOutcomeUnknown } from "../../lib/idempotent-create";

/** Confirm the target's state; disappearance from the previous list is not proof of success. */
export async function confirmMemberTransition(
  error: unknown,
  memberId: string,
  status: "approved" | "rejected" | "removed",
): Promise<boolean> {
  if (!isMutationOutcomeUnknown(error)) return false;
  try {
    const result = await listMembers(status);
    return result.members.some((member) => member.id === memberId && member.status === status);
  } catch {
    return false;
  }
}
