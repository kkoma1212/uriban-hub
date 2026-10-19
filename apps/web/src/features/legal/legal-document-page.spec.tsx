import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as legalApi from "./legal-api";
import { LegalDocumentContent } from "./legal-document-content";
import { LegalDocumentPage } from "./legal-document-page";

const currentVersion: legalApi.LegalVersion = {
  content: "## 시행 문서\n\n게시 승인을 마친 본문입니다.",
  content_sha256: "a".repeat(64),
  document_type: "terms",
  effective_at: "2026-09-01T00:00:00.000Z",
  id: "published-1",
  policy_version: "terms-v2",
  published_at: "2026-09-01T00:00:00.000Z",
  status: "published",
  title: "이용약관",
};

function renderPage(path = "/legal/terms"): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <LegalDocumentPage />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("public legal document reading", () => {
  it("renders a published version without requiring a session or showing a draft", async () => {
    const read = vi.spyOn(legalApi, "getLegalDocument").mockResolvedValue({
      version: currentVersion,
      versions: [currentVersion],
    });
    renderPage();

    expect(await screen.findByText("게시 승인을 마친 본문입니다.")).toBeInTheDocument();
    expect(read).toHaveBeenCalledWith("terms", undefined);
    expect(screen.getByText("현재 시행본 · terms-v2")).toBeInTheDocument();
    expect(screen.queryByText("검토용 초안 · 시행 전")).not.toBeInTheDocument();
  });

  it("allows a reader to retrieve the exact previous policy version", async () => {
    const previous = {
      ...currentVersion,
      id: "published-0",
      policy_version: "terms-v1",
      status: "retired" as const,
      content: "이전 시행 내용",
    };
    const read = vi
      .spyOn(legalApi, "getLegalDocument")
      .mockResolvedValueOnce({ version: currentVersion, versions: [currentVersion, previous] })
      .mockResolvedValueOnce({ version: previous, versions: [currentVersion, previous] });
    renderPage();

    fireEvent.change(await screen.findByLabelText("시행본 선택"), {
      target: { value: "terms-v1" },
    });
    expect(await screen.findByText("이전 시행 내용")).toBeInTheDocument();
    expect(read).toHaveBeenLastCalledWith("terms", "terms-v1");
    expect(screen.getByText("이전 시행본 · terms-v1")).toBeInTheDocument();
  });

  it("offers the draft in development with an explicit pre-publication label", async () => {
    vi.stubEnv("DEV", true);
    vi.spyOn(legalApi, "getLegalDocument").mockResolvedValue({ version: null, versions: [] });
    renderPage("/legal/privacy-policy");

    expect(await screen.findByText("검토용 초안 · 시행 전")).toBeInTheDocument();
    const preview = screen.getByRole("region", { name: "검토용 개발 초안" });
    // 개발·검수자용 머리말과 제0장은 화면에서 뺀다(총검수 B3-13). 공개 본문은 그대로다.
    expect(
      within(preview).queryByRole("heading", { name: "0. 게시 차단 조건" }),
    ).not.toBeInTheDocument();
    expect(within(preview).queryByText(/개발 문서 ID/u)).not.toBeInTheDocument();
    expect(
      within(preview).getByRole("heading", { name: "1. 방침의 적용 범위와 기본 원칙" }),
    ).toBeInTheDocument();
    expect(within(preview).getByText(/6자 이상\(길이 상한 없음\)/u)).toBeInTheDocument();
  });

  it.each([
    "/legal/terms",
    "/legal/privacy-consent",
    "/legal/privacy-policy",
    "/legal/guardian-consent",
  ])("shares the local draft at %s in an explicit preview build", async (path) => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("MODE", "preview");
    vi.spyOn(legalApi, "getLegalDocument").mockResolvedValue({ version: null, versions: [] });
    renderPage(path);

    expect(await screen.findByText("검토용 초안 · 시행 전")).toBeInTheDocument();
    expect(document.querySelector("[data-legal-document-content]")).not.toBeNull();
    expect(screen.queryByText("아직 게시된 문서가 없습니다.")).not.toBeInTheDocument();
  });

  it("keeps an unpublished production document unavailable instead of exposing draft text", async () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("MODE", "production");
    vi.spyOn(legalApi, "getLegalDocument").mockResolvedValue({ version: null, versions: [] });
    renderPage();

    expect(await screen.findByText("아직 게시된 문서가 없습니다.")).toBeInTheDocument();
    expect(document.querySelector("[data-legal-document-content]")).toBeNull();
    expect(screen.queryByText("검토용 초안 · 시행 전")).not.toBeInTheDocument();
  });

  it("shows an error on failed reads and retries the read without substituting a draft", async () => {
    const read = vi
      .spyOn(legalApi, "getLegalDocument")
      .mockRejectedValueOnce(new Error("connection unavailable"))
      .mockResolvedValueOnce({ version: currentVersion, versions: [currentVersion] });
    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent("문서를 불러오지 못했어요.");
    expect(document.querySelector("[data-legal-document-content]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("게시 승인을 마친 본문입니다.")).toBeInTheDocument();
  });
});

describe("legal document content", () => {
  it("renders semantic tables and keeps HTML and executable links as text", () => {
    render(
      <LegalDocumentContent
        content={
          "## 확인\n\n<script>alert(1)</script> [위험](javascript:alert)\n\n| 항목 | 기간 |\n| --- | --- |\n| 이메일 | 계정 삭제까지 |\n\n[공식 근거](https://example.org/legal)"
        }
      />,
    );

    expect(screen.getByRole("heading", { name: "확인" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "기간" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "계정 삭제까지" })).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
    expect(screen.queryByRole("link", { name: "위험" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "공식 근거" })).toHaveAttribute(
      "href",
      "https://example.org/legal",
    );
  });
});
