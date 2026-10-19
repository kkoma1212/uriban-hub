export type ManagementTab = "approved" | "pending" | "removed";

export const TAB_ORDER: ManagementTab[] = ["pending", "approved", "removed"];

export const tabConfig: Record<
  ManagementTab,
  { empty: string; emptyDescription: string; filter: string; label: string; summary: string }
> = {
  pending: {
    empty: "대기 중인 반 참여 요청이 없습니다.",
    emptyDescription: "새 반 참여 요청이 들어오면 이곳에서 승인 여부를 결정할 수 있어요.",
    filter: "pending",
    label: "대기",
    summary: "이메일 일부와 계정 상태를 확인한 뒤 승인하거나 거절하세요.",
  },
  approved: {
    empty: "승인된 학생이 없습니다.",
    emptyDescription: "반 참여 요청을 승인하면 참여 중인 학생이 이곳에 표시돼요.",
    filter: "approved",
    label: "참여",
    summary: "현재 반에 참여 중인 학생의 반에서 보이는 이름, 학생 번호와 계정 상태를 확인하세요.",
  },
  removed: {
    empty: "반에서 제외된 학생이 없습니다. 제외된 학생은 초대 코드로 다시 참여를 요청할 수 있어요.",
    emptyDescription: "제외된 학생은 초대 코드로 다시 요청할 수 있고, 새 요청은 대기에서 확인해요.",
    filter: "removed,rejoin_allowed",
    label: "제외",
    summary:
      "반에서 제외된 학생을 확인하세요. 학생은 초대 코드로 다시 요청할 수 있고, 참여하려면 선생님의 승인이 필요합니다.",
  },
};

export function tabFromSearchParams(searchParams: URLSearchParams): ManagementTab {
  const tab = searchParams.get("tab");
  return tab === "approved" || tab === "removed" ? tab : "pending";
}
