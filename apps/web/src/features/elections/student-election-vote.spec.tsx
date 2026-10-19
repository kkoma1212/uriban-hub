import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ElectionPublicItem } from "../../api/elections";
import { StudentElectionVote } from "./student-election-vote";

const election: ElectionPublicItem = {
  candidates: [
    { display_name: "김하늘", id: "candidate-1", student_number: 1 },
    { display_name: "이바다", id: "candidate-2", student_number: 2 },
  ],
  has_voted: false,
  id: "election-1",
  participant_count: 11,
  status: "open",
  title: "2학기 학급 회장 선거",
};

const votedElection: ElectionPublicItem = {
  ...election,
  has_voted: true,
  participant_count: 12,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function VoteHarness({
  onVoted,
}: {
  onVoted: (next: ElectionPublicItem | null) => void;
}): React.JSX.Element {
  const [current, setCurrent] = useState(election);
  return (
    <StudentElectionVote
      election={current}
      onVoted={(next) => {
        onVoted(next);
        if (next !== null) setCurrent(next);
      }}
    />
  );
}

function castVote(): void {
  fireEvent.click(screen.getByRole("radio", { name: /1번\s*김하늘/ }));
  fireEvent.click(screen.getByRole("button", { name: "투표하기" }));
}

describe("StudentElectionVote", () => {
  beforeEach(() => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=test-csrf-token",
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the normal successful vote path and does not perform a status GET", async () => {
    const onVoted = vi.fn();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === "/api/v1/elections/election-1/vote" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ item: votedElection }));
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    });
    render(<VoteHarness onVoted={onVoted} />);

    castVote();

    expect(await screen.findByRole("heading", { name: "투표를 마쳤어요" })).toBeVisible();
    expect(onVoted).toHaveBeenCalledWith(votedElection);
    expect(
      fetchMock.mock.calls.filter(([input]) => requestUrl(input) === "/api/v1/elections/current"),
    ).toHaveLength(0);
    expect(screen.queryByText("김하늘")).not.toBeInTheDocument();
  });

  it.each(["network", "already-voted"] as const)(
    "reconciles a %s vote response with privacy-safe current state",
    async (failure) => {
      const onVoted = vi.fn();
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
        const url = requestUrl(input);
        if (url === "/api/v1/elections/election-1/vote" && init?.method === "POST") {
          if (failure === "network") return Promise.reject(new TypeError("response lost"));
          return Promise.resolve(
            jsonResponse(
              {
                error: {
                  code: "ELECTION_ALREADY_VOTED",
                  message: "이미 투표했어요. 한 사람이 한 번만 투표할 수 있습니다.",
                },
              },
              409,
            ),
          );
        }
        if (url === "/api/v1/elections/current" && init?.method === undefined) {
          return Promise.resolve(jsonResponse({ item: votedElection }));
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
      });
      render(<VoteHarness onVoted={onVoted} />);

      castVote();

      expect(await screen.findByRole("heading", { name: "투표를 마쳤어요" })).toBeVisible();
      expect(onVoted).toHaveBeenCalledWith(votedElection);
      expect(
        fetchMock.mock.calls.filter(([input]) => requestUrl(input) === "/api/v1/elections/current"),
      ).toHaveLength(1);
      expect(screen.queryByRole("radio")).not.toBeInTheDocument();
      expect(screen.queryByText("김하늘")).not.toBeInTheDocument();
    },
  );

  it("keeps the original error and offers a generic recheck when current state also fails", async () => {
    const onVoted = vi.fn();
    let currentAttempts = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === "/api/v1/elections/election-1/vote" && init?.method === "POST") {
        return Promise.reject(new TypeError("response lost"));
      }
      if (url === "/api/v1/elections/current" && init?.method === undefined) {
        currentAttempts += 1;
        return currentAttempts === 1
          ? Promise.reject(new TypeError("still offline"))
          : Promise.resolve(jsonResponse({ item: votedElection }));
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    });
    render(<VoteHarness onVoted={onVoted} />);

    castVote();

    const recheck = await screen.findByRole("button", { name: "투표 상태 다시 확인" });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(
      "서버에 연결하지 못했습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.",
    );
    expect(alert).not.toHaveTextContent("김하늘");
    expect(screen.getByRole("radio", { name: /1번\s*김하늘/ })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "투표하기" })).toBeDisabled();
    expect(onVoted).not.toHaveBeenCalled();
    expect(currentAttempts).toBe(1);

    fireEvent.click(recheck);

    expect(await screen.findByRole("heading", { name: "투표를 마쳤어요" })).toBeVisible();
    expect(onVoted).toHaveBeenCalledWith(votedElection);
    expect(currentAttempts).toBe(2);
    expect(
      fetchMock.mock.calls.filter(([input]) => requestUrl(input) === "/api/v1/elections/current"),
    ).toHaveLength(2);
    await waitFor(() => expect(screen.queryByText("김하늘")).not.toBeInTheDocument());
  });
});
