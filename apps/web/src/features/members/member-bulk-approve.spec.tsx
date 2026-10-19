import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as auth from "../../api/auth";
import type { MemberListItem } from "../../api/auth";
import {
  approvalRequestFromDraft,
  bulkApproveSummary,
  MemberBulkApprove,
  type BulkApproveResult,
} from "./member-bulk-approve";

vi.mock("../../api/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/auth")>()),
  approveMember: vi.fn(),
  listMembers: vi.fn(),
}));

function pendingMember(id: string, name: string): MemberListItem {
  return {
    account_state: "active",
    display_name: name,
    display_name_in_class: null,
    id,
    requested_at: "2026-09-23T00:00:00.000Z",
    row_version: "1",
    status: "pending",
    status_changed_at: "2026-09-23T00:00:00.000Z",
    student_number: null,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("approvalRequestFromDraft", () => {
  it("비어 있으면 번호·이름 없이 승인한다", () => {
    expect(approvalRequestFromDraft({ displayName: " ", studentNumber: "" })).toEqual({
      ok: true,
      request: { display_name_in_class: null, student_number: null },
    });
  });

  it("번호 범위와 이름 길이를 검사한다", () => {
    expect(approvalRequestFromDraft({ displayName: "", studentNumber: "0" }).ok).toBe(false);
    expect(approvalRequestFromDraft({ displayName: "", studentNumber: "100" }).ok).toBe(false);
    expect(approvalRequestFromDraft({ displayName: "가", studentNumber: "" }).ok).toBe(false);
    expect(approvalRequestFromDraft({ displayName: "김학생", studentNumber: "7" })).toEqual({
      ok: true,
      request: { display_name_in_class: "김학생", student_number: 7 },
    });
  });
});

describe("MemberBulkApprove", () => {
  const members = [
    pendingMember("1", "학생가"),
    pendingMember("2", "학생나"),
    pendingMember("3", "학생다"),
  ];

  it("대기 학생이 한 명 이하면 버튼을 보여 주지 않는다", () => {
    const { container } = render(
      <MemberBulkApprove
        disabled={false}
        drafts={{}}
        onFinished={vi.fn()}
        pending={members.slice(0, 1)}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("확인 뒤 차례로 승인하고, 실패한 학생이 있어도 나머지를 계속 승인한다", async () => {
    vi.mocked(auth.approveMember).mockImplementation(async (memberId) => {
      if (memberId === "2")
        throw new auth.ApiRequestError(
          "STUDENT_NUMBER_CONFLICT",
          "학생 번호가 이미 사용 중입니다.",
          409,
        );
      return {
        email_delivery_status: memberId === "3" ? "failed" : "sent",
      } as Awaited<ReturnType<typeof auth.approveMember>>;
    });
    const onFinished = vi.fn();
    render(
      <MemberBulkApprove
        disabled={false}
        drafts={{
          "1": { displayName: "", studentNumber: "1" },
          "2": { displayName: "", studentNumber: "1" },
        }}
        onFinished={onFinished}
        pending={members}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /대기 학생 모두 승인 \(3명\)/u }));
    fireEvent.click(await screen.findByRole("button", { name: "3명 승인" }));
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(vi.mocked(auth.approveMember).mock.calls.map(([id, request]) => [id, request])).toEqual([
      ["1", { display_name_in_class: null, student_number: 1 }],
      ["2", { display_name_in_class: null, student_number: 1 }],
      ["3", { display_name_in_class: null, student_number: null }],
    ]);
    expect(onFinished).toHaveBeenCalledWith({
      approved: 2,
      failed: [{ message: "학생 번호가 이미 사용 중입니다.", name: "학생나" }],
      mailFailed: 1,
    });
  });

  it("사용이 정지된 계정은 세지 않고 보내지도 않는다(총검수 A1-06)", async () => {
    vi.mocked(auth.approveMember).mockResolvedValue({
      email_delivery_status: "sent",
    } as Awaited<ReturnType<typeof auth.approveMember>>);
    const onFinished = vi.fn();
    render(
      <MemberBulkApprove
        disabled={false}
        drafts={{}}
        onFinished={onFinished}
        pending={[...members, { ...pendingMember("4", "학생라"), account_state: "inactive" }]}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "대기 학생 모두 승인 (3명, 비활성 1명 제외)" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "3명 승인" }));
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(vi.mocked(auth.approveMember).mock.calls.map(([id]) => id)).toEqual(["1", "2", "3"]);
  });

  it("확인 대화상자에서 취소하면 아무도 승인하지 않는다", async () => {
    render(
      <MemberBulkApprove disabled={false} drafts={{}} onFinished={vi.fn()} pending={members} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /대기 학생 모두 승인/u }));
    fireEvent.click(await screen.findByRole("button", { name: "취소" }));
    expect(auth.approveMember).not.toHaveBeenCalled();
  });

  it("입력이 잘못된 학생은 서버에 보내지 않고 실패로 모은다", async () => {
    vi.mocked(auth.approveMember).mockResolvedValue({
      email_delivery_status: "sent",
    } as Awaited<ReturnType<typeof auth.approveMember>>);
    const onFinished = vi.fn();
    render(
      <MemberBulkApprove
        disabled={false}
        drafts={{ "1": { displayName: "", studentNumber: "150" } }}
        onFinished={onFinished}
        pending={members.slice(0, 2)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /대기 학생 모두 승인/u }));
    fireEvent.click(await screen.findByRole("button", { name: "2명 승인" }));
    await waitFor(() => expect(onFinished).toHaveBeenCalled());
    expect(auth.approveMember).toHaveBeenCalledTimes(1);
    expect((onFinished.mock.calls[0]![0] as BulkApproveResult).failed[0]!.name).toBe("학생가");
  });
});

describe("bulkApproveSummary", () => {
  it("승인 수·메일 실패·실패 이유를 한 번에 알린다", () => {
    expect(
      bulkApproveSummary({
        approved: 2,
        mailFailed: 1,
        failed: [{ name: "학생나", message: "번호 중복" }],
      }),
    ).toEqual({
      notice:
        "2명을 승인했습니다. 1명에게는 안내 메일을 보내지 못했어요. 학생에게 결과를 알려 주세요.",
      error: "1명은 승인하지 못했습니다. 학생나: 번호 중복",
    });
  });
});

it.each([true, false])(
  "confirms a lost approval response without repeating mutation; confirmed=%s",
  async (confirmed) => {
    vi.mocked(auth.approveMember).mockRejectedValue(new Error("lost response"));
    vi.mocked(auth.listMembers).mockImplementation(async () => {
      if (!confirmed) throw new Error("lookup failed");
      return {
        members: [
          { ...pendingMember("1", "학생가"), status: "approved" },
          { ...pendingMember("2", "학생나"), status: "approved" },
        ],
      };
    });
    const finished = vi.fn();
    render(
      <MemberBulkApprove
        disabled={false}
        drafts={{}}
        onFinished={finished}
        pending={[pendingMember("1", "학생가"), pendingMember("2", "학생나")]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "대기 학생 모두 승인 (2명)" }));
    fireEvent.click(await screen.findByRole("button", { name: "2명 승인" }));
    await waitFor(() => expect(finished).toHaveBeenCalledOnce());
    expect(auth.approveMember).toHaveBeenCalledTimes(2);
    const result = finished.mock.calls[0]![0] as BulkApproveResult;
    expect(result.failed).toEqual([]);
    if (confirmed) {
      expect(result.approved).toBe(2);
      expect(bulkApproveSummary(result).notice).toContain("메일이 갔는지는 확인하지 못했어요");
    } else {
      expect(result.approved).toBe(0);
      expect(bulkApproveSummary(result).error).toContain("승인 결과를 확인하지 못했습니다");
      expect(bulkApproveSummary(result).error).not.toContain("승인하지 못했습니다");
    }
  },
);
