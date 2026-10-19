import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AdminOperationsStatus } from "../../api/admin-operations";
import { OperationsPanel } from "./admin-console-operations-panel";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

const healthy: AdminOperationsStatus = {
  audit_queue: {
    conditions: ["quarantine_present"],
    latest_quarantined_at: "2026-09-09T11:36:02.000Z",
    pending_entries: 0,
    quarantine_reviewed_through: "2026-09-09T23:59:59.999Z",
    quarantine_entries: 130,
    sampled_at: "2026-09-30T10:59:00.000Z",
    status: "attention",
  },
  backup: { at: "2026-09-30T09:00:00.000Z", verified: true },
  generated_at: "2026-09-30T11:00:00.000Z",
  restore_check: {
    at: "2026-09-29T22:00:00.000Z",
    expected_ledger_rows: 80,
    expected_tables: 75,
    ledger_rows: 80,
    passed: true,
    tables: 75,
  },
  status_source_configured: true,
  offline_backup: { at: "2026-09-28T01:00:00.000Z", backup_at: "2026-09-27T18:35:00.000Z" },
};

const section = (title: string) =>
  within(screen.getByRole("heading", { name: title }).closest("section")!);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OperationsPanel", () => {
  it("shows the last USB export and warns once it is older than a week", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(healthy));
    const { unmount } = render(<OperationsPanel />);
    await screen.findByRole("heading", { name: "백업" });
    const recent = section("백업").getByText(/\(2일 전\)$/u);
    expect(recent).not.toHaveClass("text-danger-text");
    unmount();

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ...healthy,
        offline_backup: { at: "2026-09-22T09:00:00.000Z", backup_at: "2026-09-22T06:35:00.000Z" },
      }),
    );
    render(<OperationsPanel />);
    await screen.findByRole("heading", { name: "백업" });
    expect(section("백업").getByText(/\(8일 전\)$/u)).toHaveClass("text-danger-text");
  });

  it("treats only reviewed past quarantine as normal next to backup and restore results", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(healthy));
    render(<OperationsPanel />);

    const audit = within(
      (await screen.findByRole("heading", { name: "보안 감사 기록 처리" })).closest("section")!,
    );
    expect(audit.getByText("정상 (확인한 과거 격리만)")).not.toHaveClass("text-danger-text");
    expect(audit.getByText(/130건 · 확인한 과거 건/u)).not.toHaveClass("text-danger-text");
    expect(section("백업").getByText("암호화·되읽기 확인됨")).toBeVisible();
    expect(section("백업").getByText("2시간 전")).not.toHaveClass("text-danger-text");
    const restore = section("복원 검증·DB 설치 상태");
    expect(restore.getByText("통과")).toBeVisible();
    expect(restore.getByText("75 / 75")).toBeVisible();
    expect(restore.getByText("80 / 80")).toBeVisible();
  });

  it("warns again when a quarantine is newer than the reviewed time or another condition exists", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        ...healthy,
        audit_queue: {
          ...healthy.audit_queue!,
          quarantine_entries: 131,
          latest_quarantined_at: "2026-09-30T10:00:00.000Z",
        },
      }),
    );
    const { unmount } = render(<OperationsPanel />);
    const audit = () =>
      within(screen.getByRole("heading", { name: "보안 감사 기록 처리" }).closest("section")!);
    expect(await screen.findByText(/131건 · 새 격리 있음/u)).toHaveClass("text-danger-text");
    expect(audit().getByText("확인 필요")).toHaveClass("text-danger-text");
    unmount();

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ...healthy,
        audit_queue: {
          ...healthy.audit_queue!,
          conditions: ["quarantine_present", "queue_backlog"],
        },
      }),
    );
    render(<OperationsPanel />);
    expect(await screen.findByText("확인 필요")).toHaveClass("text-danger-text");
  });

  it("lists recent screen errors by screen, error and count without personal details", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "/api/v1/admin/client-errors")
        return jsonResponse({
          kinds: [
            {
              count: 3,
              device: "phone",
              first_seen_at: "2026-09-30T09:00:00.000Z",
              last_seen_at: "2026-09-30T10:30:00.000Z",
              name: "TypeError",
              role: "student",
              route: "/help-requests/:id",
              source: "chunk",
            },
          ],
          total: 3,
          window_hours: 24,
        });
      return jsonResponse(healthy);
    });
    render(<OperationsPanel />);

    const heading = await screen.findByRole("heading", { name: /화면 오류\(최근 24시간\).*3건/u });
    const errors = within(heading.closest("section")!);
    const table = errors.getByRole("region", { name: "화면 오류 표" });
    expect(within(table).getByText("/help-requests/:id")).toBeVisible();
    expect(within(table).getByText("TypeError")).toBeVisible();
    expect(within(table).getByText("화면 파일 불러오기 실패")).toBeVisible();
    expect(within(table).getByText("학생 · 휴대폰")).toBeVisible();
    expect(within(table).getByText("3건")).toBeVisible();
  });

  it("says so when no screen errors were collected", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      jsonResponse(
        String(input) === "/api/v1/admin/client-errors"
          ? { kinds: [], total: 0, window_hours: 24 }
          : healthy,
      ),
    );
    render(<OperationsPanel />);
    expect(await screen.findByText("최근 24시간 동안 모인 화면 오류가 없습니다.")).toBeVisible();
  });

  it("flags a late backup, a failed restore and missing sources instead of hiding them", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        ...healthy,
        audit_queue: null,
        backup: { at: "2026-09-30T02:00:00.000Z", verified: false },
        restore_check: { ...healthy.restore_check!, passed: false, tables: 74 },
        offline_backup: null,
      }),
    );
    const { unmount } = render(<OperationsPanel />);
    expect(
      await screen.findByText("작업자에 연결할 수 없습니다. 작업자가 꺼져 있을 수 있습니다."),
    ).toBeVisible();
    expect(section("백업").getByText("검증 안 됨")).toHaveClass("text-danger-text");
    expect(section("백업").getByText("9시간 전")).toHaveClass("text-danger-text");
    expect(section("복원 검증·DB 설치 상태").getByText("실패")).toHaveClass("text-danger-text");
    expect(section("복원 검증·DB 설치 상태").getByText("74 / 75")).toHaveClass("text-danger-text");
    expect(section("백업").getByText("아직 없음")).toHaveClass("text-danger-text");
    unmount();

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ...healthy,
        backup: null,
        restore_check: null,
        status_source_configured: false,
      }),
    );
    render(<OperationsPanel />);
    expect(
      await screen.findAllByText("이 서버에는 백업 상태 폴더가 설정되지 않아 확인할 수 없습니다."),
    ).toHaveLength(2);
  });
});
