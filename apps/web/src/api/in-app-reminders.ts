export interface InAppReminderCreateResponse {
  batch_id: string;
  cooldown_suppressed_count: number;
  created_at: string;
  created_count: number;
  current_unresolved_count: number;
  next_available_at: string | null;
}

export function reminderContentRevision(value: string, resourceLabel: string): number {
  const numericRevision = Number(value);
  if (!Number.isSafeInteger(numericRevision) || numericRevision < 1) {
    throw new Error(`${resourceLabel} 내용이 방금 바뀌었을 수 있어요. 화면을 새로고침해 주세요.`);
  }
  return numericRevision;
}
