import { useParams } from "react-router";
import { AppShell } from "../layout/app-shell";
import { ContentBackbar, ContentFrameHeader, ContentPanel } from "../layout/content-frame";
import { MemberProfilePanel } from "./member-profile-panel";

export function MemberProfileManagementPage(): React.JSX.Element {
  const { memberId } = useParams<{ memberId: string }>();
  return (
    <AppShell contentFrame navigationRole="teacher" width="medium">
      <ContentBackbar label="학생 목록으로" to="/members/manage?tab=approved" />
      <ContentFrameHeader title="학생 정보" />
      <ContentPanel data-feature-surface="member-profile">
        <MemberProfilePanel initiallyEditing key={memberId} memberId={memberId} />
      </ContentPanel>
    </AppShell>
  );
}
