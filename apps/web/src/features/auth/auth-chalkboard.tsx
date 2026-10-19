/*
 * 2026-09-27 확정 시안(로그인가입_v3_확정)의 로그인 칠판. 홈 칠판(home/chalkboard.tsx)과 같은
 * 나무 틀 · 짙은 초록 · 분필 글씨(Gaegu)를 쓰되, 링크 없는 소개용이라 따로 둔다.
 * 테마와 무관하게 --color-chalk-* 토큰만 쓴다.
 */

const CHALK_FONT = "Gaegu, 'Pretendard Variable', cursive";
const BOARD_BACKGROUND =
  "radial-gradient(120% 90% at 20% 0%, rgb(255 255 255 / 7%) 0%, transparent 60%), var(--color-chalk-board)";
// 일반 소개 문구의 형광펜은 연두. 노랑은 고친 글의 바뀜 표시에만 사용한다.
const CHALK_UNDERLINE =
  "bg-[linear-gradient(transparent_68%,#c6e8a4_68%,#c6e8a4_90%,transparent_90%)]";

// 줄 옆 작은 꼬리표(칠판 · 소식 · 도움 요청)는 문장과 같은 말을 되풀이해 두지 않는다(2026-09-27 사용자 검토).
const INTRO_LINES = [
  "오늘 챙길 것은 칠판에",
  "공지 · 숙제는 한 흐름으로",
  "궁금한 건 선생님께 바로",
];

function ChalkTitle({ className }: { className: string }): React.JSX.Element {
  return (
    <p className={`text-white ${className}`} style={{ fontFamily: CHALK_FONT }}>
      우리 반의 하루가
      <br />
      <span className={`box-decoration-clone ${CHALK_UNDERLINE}`}>더 선명해져요</span>
    </p>
  );
}

/** PC 왼쪽: 바탕 위에 가로로 넓은 칠판 한 장을 건다. */
export function AuthDesktopChalkboard(): React.JSX.Element {
  return (
    <div
      className="flex w-full rounded-[1.6rem] bg-[var(--color-chalk-frame)] p-[7px] shadow-[0_18px_40px_rgb(30_45_38/16%)]"
      data-auth-chalkboard="desktop"
    >
      {/* 옆 흰 카드와 같은 높이로 늘어나 두 칸의 윗선 · 아랫선이 맞는다. */}
      <div
        className="flex min-h-[26rem] flex-1 flex-col rounded-[1.2rem] px-10 pb-5 pt-8 text-[var(--color-chalk-text)]"
        style={{ background: BOARD_BACKGROUND }}
      >
        <p aria-hidden="true" className="text-right text-sm font-semibold opacity-80">
          우리반 칠판
        </p>
        <ChalkTitle className="mt-4 text-5xl leading-tight" />
        <ul className="mt-7 grid gap-3">
          {INTRO_LINES.map((line) => (
            <li className="text-[1.7rem] opacity-90" key={line} style={{ fontFamily: CHALK_FONT }}>
              {line}
            </li>
          ))}
        </ul>
        <p className="mt-auto flex items-center gap-2.5 border-t border-white/15 pt-3.5 text-xs opacity-80">
          <span aria-hidden="true" className="flex gap-1">
            <span className="h-1.5 w-5 rounded-full bg-[var(--color-chalk-text)]" />
            <span className="h-1.5 w-3.5 rounded-full bg-[#c6e8a4]" />
          </span>
          선생님과 학생이 함께 쓰는 우리 반 칠판
        </p>
      </div>
    </div>
  );
}

/** 휴대폰 로그인 머리: 작은 칠판에 제품 이름 + 손글씨 한 줄. */
export function AuthMobileChalkboard({
  wordmark,
}: {
  wordmark: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      className="rounded-[1.35rem] bg-[var(--color-chalk-frame)] p-1 shadow-card"
      data-auth-chalkboard="mobile"
    >
      <div
        className="rounded-[1.1rem] px-4 pb-3.5 pt-4 text-[var(--color-chalk-text)]"
        style={{ background: BOARD_BACKGROUND }}
      >
        {wordmark}
        <ChalkTitle className="mt-3 text-[1.7rem] leading-tight" />
        <p className="mt-1.5 text-xs font-semibold opacity-80">
          공지 · 숙제 · 출결 연락을 한곳에서
        </p>
      </div>
    </div>
  );
}
