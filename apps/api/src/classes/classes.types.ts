export interface ArchiveCurrentClassCommand {
  actorUserId: string;
  classNameConfirmation: string;
  expectedClassId: string;
  expectedRowVersion: string;
  requestId: string;
}

export interface ArchiveCurrentClassResult {
  archived_at: string;
  class_id: string;
  next_action: "CREATE_CLASS";
  row_version: string;
}

export interface CurrentClassResult {
  academic_year: number;
  active_student_count: number;
  expected_student_count?: number;
  grade: number;
  id: string;
  name: string;
  role: "student" | "teacher";
  row_version: string;
  school_address: string | null;
  school_homepage_url: string | null;
  school_name: string;
  school_phone_number: string | null;
  status: "active";
  teacher_display_name: string;
}

export interface InviteCodeView {
  code: string;
  created_at: string;
  expires_at: string;
  id: string;
  status: "active" | "expired";
}

export interface CurrentInviteCodeResult {
  class_id: string;
  invite_code: InviteCodeView;
}

export interface RotateInviteCodeCommand {
  actorUserId: string;
  idempotencyKey: string | string[] | undefined;
  requestId: string;
}

export type RotateInviteCodeResult = CurrentInviteCodeResult;

export interface CreateClassCommand {
  academicYear: number;
  actorUserId: string;
  eduOfficeCode: string;
  expectedStudentCount: number;
  grade: number;
  idempotencyKey: string | string[] | undefined;
  name: string;
  requestId: string;
  schoolCode: string;
}

export interface CreateClassResult {
  class: {
    academic_year: number;
    expected_student_count: number;
    grade: number;
    id: string;
    name: string;
    row_version: string;
    school_name: string;
    status: "active";
  };
  invite_code: InviteCodeView;
  next_action: "HOME";
  teacher_membership_id: string;
}

export interface UpdateCurrentClassCommand {
  actorUserId: string;
  expectedRowVersion: string;
  expectedStudentCount: number | undefined;
  name: string | undefined;
  requestId: string;
}

export type UpdateCurrentClassResult = CurrentClassResult;
