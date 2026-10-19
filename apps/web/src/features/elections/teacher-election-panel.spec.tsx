import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ElectionSummary } from "../../api/elections";
import { TeacherElectionPanel } from "./teacher-election-panel";

const draftElection = {
  closed_at: null,
  created_at: "2026-08-26T00:00:00.000Z",
  id: "election-1",
  opened_at: null,
  published_at: null,
  results_visibility: "with_counts" as const,
  row_version: "1",
  status: "draft" as const,
  tie_break: "revote" as const,
  title: "2학기 학급 회장 선거",
};

const candidates = [
  { display_name: "김하늘", id: "candidate-1", student_number: 1 },
  { display_name: "이바다", id: "candidate-2", student_number: 2 },
];

type ElectionStatus = "closed" | "draft" | "open" | "published";

function electionForStatus(status: ElectionStatus): ElectionSummary {
  return {
    ...draftElection,
    closed_at: status === "closed" || status === "published" ? "2026-08-26T00:20:00.000Z" : null,
    opened_at: status === "draft" ? null : "2026-08-26T00:10:00.000Z",
    published_at: status === "published" ? "2026-08-26T00:30:00.000Z" : null,
    status,
  };
}

function electionItem(status: ElectionStatus): object {
  return {
    ...electionForStatus(status),
    candidates,
    participant_count: status === "draft" ? 0 : 12,
  };
}

function electionResults(status: "closed" | "published"): object {
  return {
    leading_candidate_ids: ["candidate-1"],
    participant_count: 12,
    results_visibility: "with_counts",
    status,
    tallies: [
      { candidate_id: "candidate-1", display_name: "김하늘", student_number: 1, vote_count: 7 },
      { candidate_id: "candidate-2", display_name: "이바다", student_number: 2, vote_count: 5 },
    ],
    tie_break: "revote",
    tie_break_applied: false,
    title: draftElection.title,
    winner: candidates[0],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", ETag: '"1"' },
    status,
  });
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function mutationCalls(fetchMock: ReturnType<typeof vi.spyOn>, suffix: string): unknown[][] {
  return fetchMock.mock.calls.filter((call: unknown[]) => {
    const input = call[0] as RequestInfo | URL;
    const init = call[1] as RequestInit | undefined;
    return requestUrl(input).endsWith(suffix) && init?.method === "POST";
  });
}

function mockLifecycle(initialStatus: "closed" | "draft" | "open"): ReturnType<typeof vi.spyOn> {
  let published = false;
  return vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? "GET";
    if (url === "/api/v1/elections/election-1" && method === "GET") {
      return Promise.resolve(jsonResponse(electionItem(published ? "published" : initialStatus)));
    }
    if (url === "/api/v1/elections/election-1/open" && method === "POST") {
      return Promise.resolve(jsonResponse(electionItem("open")));
    }
    if (url === "/api/v1/elections/election-1/close" && method === "POST") {
      return Promise.resolve(jsonResponse(electionItem("closed")));
    }
    if (url === "/api/v1/elections/election-1/results" && method === "GET") {
      return Promise.resolve(jsonResponse(electionResults(published ? "published" : "closed")));
    }
    if (url === "/api/v1/elections/election-1/publish" && method === "POST") {
      published = true;
      return Promise.resolve(jsonResponse(electionResults("published")));
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
}

function renderPanel(status: "closed" | "draft" | "open"): void {
  const view = render(
    <TeacherElectionPanel
      createOpen={false}
      elections={[electionForStatus(status)]}
      members={[]}
      onChanged={vi.fn()}
      onCloseCreate={vi.fn()}
    />,
  );
  view.container.id = "root";
}

describe("TeacherElectionPanel", () => {
  beforeEach(() => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=test-csrf-token",
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the lifecycle and only marks the current election stage", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "/api/v1/elections/election-1") {
        return Promise.resolve(
          jsonResponse({
            ...draftElection,
            candidates,
            participant_count: 0,
          }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <TeacherElectionPanel
        createOpen={false}
        elections={[draftElection]}
        members={[]}
        onChanged={vi.fn()}
        onCloseCreate={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /2학기 학급 회장 선거/ }));

    const lifecycle = await screen.findByRole("list", { name: "선거 단계" });
    const currentStep = within(lifecycle).getByText("후보 등록").closest("li");
    expect(currentStep).toHaveAttribute("aria-current", "step");
    expect(currentStep).toHaveClass("bg-role-primary", "text-app-canvas");
    expect(currentStep).not.toHaveClass("text-white");
    expect(within(lifecycle).getByText("투표").closest("li")).not.toHaveAttribute("aria-current");
    expect(within(lifecycle).getByText("마감")).toBeVisible();
    expect(within(lifecycle).getByText("결과 공개")).toBeVisible();
    expect(await screen.findByRole("button", { name: "투표 시작" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "투표 마감하고 개표" })).not.toBeInTheDocument();
  });

  it("starts only after explicit confirmation and treats cancel as API zero", async () => {
    const fetchMock = mockLifecycle("draft");
    renderPanel("draft");
    fireEvent.click(screen.getByRole("button", { name: /2학기 학급 회장 선거/ }));

    const trigger = await screen.findByRole("button", { name: "투표 시작" });
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", {
      name: "‘2학기 학급 회장 선거’ 투표를 시작할까요?",
    });
    expect(dialog).toHaveAccessibleDescription(
      "등록한 후보 2명이 학생 화면에 공개됩니다. 시작하면 후보를 추가할 수 없고 준비 중 단계로 되돌릴 수 없습니다.",
    );
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "취소" })).toHaveFocus());
    fireEvent.click(within(dialog).getByRole("button", { name: "취소" }));
    expect(mutationCalls(fetchMock, "/open")).toHaveLength(0);
    await waitFor(() => expect(trigger).toHaveFocus());

    fireEvent.click(trigger);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "투표 시작" }));
    await waitFor(() => expect(mutationCalls(fetchMock, "/open")).toHaveLength(1));
  });

  it("closes only after explicit confirmation and treats backdrop as API zero", async () => {
    const fetchMock = mockLifecycle("open");
    renderPanel("open");
    fireEvent.click(screen.getByRole("button", { name: /2학기 학급 회장 선거/ }));

    const trigger = await screen.findByRole("button", { name: "투표 마감하고 개표" });
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", {
      name: "‘2학기 학급 회장 선거’ 투표를 마감할까요?",
    });
    expect(dialog).toHaveAccessibleDescription(
      "현재 12명이 투표했습니다. 마감하면 학생은 더 이상 참여할 수 없고 투표 중 단계로 되돌릴 수 없습니다.",
    );
    fireEvent.pointerDown(screen.getByTestId("confirm-dialog-backdrop"));
    expect(mutationCalls(fetchMock, "/close")).toHaveLength(0);
    await waitFor(() => expect(trigger).toHaveFocus());

    fireEvent.click(trigger);
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "투표 마감하고 개표",
      }),
    );
    await waitFor(() => expect(mutationCalls(fetchMock, "/close")).toHaveLength(1));
  });

  it("publishes only after explicit confirmation and treats Escape as API zero", async () => {
    const fetchMock = mockLifecycle("closed");
    renderPanel("closed");
    fireEvent.click(screen.getByRole("button", { name: /2학기 학급 회장 선거/ }));

    const trigger = await screen.findByRole("button", { name: "결과 발표하기" });
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", {
      name: "‘2학기 학급 회장 선거’ 결과를 발표할까요?",
    });
    expect(dialog).toHaveAccessibleDescription(
      "당선 결과(1번 김하늘)를 학생 화면에 공개합니다. 발표한 뒤에는 이 화면에서 취소하거나 마감 상태로 되돌릴 수 없습니다.",
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(mutationCalls(fetchMock, "/publish")).toHaveLength(0);
    await waitFor(() => expect(trigger).toHaveFocus());

    fireEvent.click(trigger);
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "결과 발표하기" }),
    );
    await waitFor(() => expect(mutationCalls(fetchMock, "/publish")).toHaveLength(1));
  });
});
