import { ArrowRight, Bell, Check, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";

import { APP_MAIN_ID, ProductWordmark } from "../layout/app-shell";
import { SiteFooter } from "../layout/site-footer";
import "./demo-page.css";

// 이 화면은 실제 계정·반·알림과 연결하지 않는 메모리 안의 고정 예시다.
// 재알림 등록과 학생의 확인은 별개이며, 등록만으로 확인 수를 늘리지 않는다.
const STAGES = [
  {
    title: "안내가 바뀌면, 확인도 새롭게",
    description:
      "집합 장소를 운동장에서 강당으로 바꿔 보세요. 수정 전 내용을 확인한 학생도 새 내용을 다시 확인해야 해요.",
    action: "장소 변경해 보기",
    status: "가상 학생 4명 중 3명이 수정 전 공지를 확인한 상태예요.",
  },
  {
    title: "다시 확인할 학생을 한눈에",
    description: "수정 전 공지를 확인한 3명과 아직 확인하지 않은 1명을 구분해 볼 수 있어요.",
    action: "앱 내 재알림 예시 등록",
    status: "공지를 수정했어요. 재확인 필요 3명, 미확인 1명이며 최신 내용 확인은 0명이에요.",
  },
  {
    title: "학생이 직접 최신 내용을 확인",
    description:
      "재알림 등록만으로 확인이 끝나지는 않아요. 예시 학생 1의 화면에서 새 내용을 확인해 보세요.",
    action: "최신 내용 다시 확인",
    status: "예시 재알림 4명 등록. 학생들의 확인 상태는 그대로예요. 실제 알림은 보내지 않습니다.",
  },
  {
    title: "확인한 학생과 남은 학생이 보여요",
    description: "예시 학생 1이 최신 내용을 확인했어요. 나머지 3명에게는 아직 확인이 필요해요.",
    action: "",
    status: "최신 내용 확인 1명, 재확인 필요 2명, 미확인 1명. 예시 체험을 마쳤어요.",
  },
] as const;

const STEP_LABELS = ["공지 수정", "재알림 등록", "학생 확인"];

export function DemoPage(): React.JSX.Element {
  const [stage, setStage] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previousStageRef = useRef(stage);
  const current = STAGES[stage]!;
  const revised = stage > 0;
  const completed = stage === 3;
  const confirmed = completed ? 1 : revised ? 0 : 3;
  const reconfirmationNeeded = completed ? 2 : revised ? 3 : 0;

  useEffect(() => {
    if (previousStageRef.current === stage) return;
    previousStageRef.current = stage;
    headingRef.current?.focus();
  }, [stage]);

  return (
    <main className="demo-page" id={APP_MAIN_ID} tabIndex={-1}>
      <div className="demo-container">
        <header className="demo-header">
          <ProductWordmark to="/login" />
          <Link className="ui-button ui-button-secondary" to="/login">
            로그인
          </Link>
        </header>

        <div className="demo-intro">
          <p className="demo-eyebrow">가입 없이 예시 체험 · 개발 중</p>
          <h1>바뀐 안내, 확인까지 이어지게.</h1>
          <p className="demo-lead">
            공지를 고친 뒤 누가 다시 확인해야 하는지, 가상 학급에서 직접 살펴보세요.
          </p>
          <p className="demo-disclosure">
            모든 이름과 숫자는 가상 예시입니다. 실제 학생에게 알림을 보내지 않으며, 체험 내용은
            저장되지 않습니다.
          </p>
        </div>

        <ol aria-label="예시 체험 단계" className="demo-steps">
          {STEP_LABELS.map((label, index) => (
            <li
              aria-current={!completed && stage === index ? "step" : undefined}
              data-complete={stage > index ? "true" : undefined}
              key={label}
            >
              <span aria-hidden="true" className="demo-step-number">
                {stage > index ? <Check size={17} /> : index + 1}
              </span>
              <span>{label}</span>
              {stage > index ? <span className="sr-only">완료</span> : null}
            </li>
          ))}
        </ol>

        <div className="demo-workspace">
          <section aria-labelledby="demo-stage-title" className="demo-guide">
            <p className="demo-eyebrow">{completed ? "체험 완료" : `${stage + 1} / 3 단계`}</p>
            <h2 id="demo-stage-title" ref={headingRef} tabIndex={-1}>
              {current.title}
            </h2>
            <p className="demo-guide-description">{current.description}</p>
            <p aria-live="polite" aria-atomic="true" className="demo-status" role="status">
              {current.status}
            </p>

            {completed ? (
              <div className="demo-next">
                <Link className="ui-button ui-button-primary demo-action" to="/sign-up">
                  가입 화면으로 이동 <ArrowRight aria-hidden="true" size={18} />
                </Link>
                <p>실제 이용은 기존 가입·이메일 확인·역할별 승인 절차를 따릅니다.</p>
              </div>
            ) : stage < 2 ? (
              <button
                className="ui-button ui-button-primary demo-action"
                onClick={() => setStage(stage + 1)}
                type="button"
              >
                {current.action} <ArrowRight aria-hidden="true" size={18} />
              </button>
            ) : (
              <p className="demo-next demo-student-direction">
                아래 예시 학생 1의 공지에서 ‘최신 내용 다시 확인’을 눌러 보세요.
              </p>
            )}
            <button
              className="ui-button ui-button-tertiary demo-reset"
              disabled={stage === 0}
              onClick={() => setStage(0)}
              type="button"
            >
              <RotateCcw aria-hidden="true" size={16} /> 처음부터 체험
            </button>
          </section>

          <section aria-label="가상 학급의 공지와 확인 현황" className="demo-preview">
            <div className="demo-board">
              <div className="demo-board-top">
                <span>{stage === 2 ? "예시 학생 1의 화면" : "선생님 화면 예시"}</span>
                <span>가상 학급 · 4명</span>
              </div>
              <h2>현장체험학습 집합 안내</h2>
              <p>금요일 오전 9시, 아래 장소에서 만나요.</p>
              <p className="demo-place">
                집합 장소{" "}
                {revised ? (
                  <>
                    <del>운동장</del>
                    <ArrowRight aria-hidden="true" size={20} />
                    <mark>강당</mark>
                    <span className="sr-only">으로 변경</span>
                  </>
                ) : (
                  <strong>운동장</strong>
                )}
              </p>
              <p className="demo-board-note">
                {revised
                  ? "수정된 내용 · 다시 읽고 확인해 주세요."
                  : "수정 전 내용 · 3명이 확인했어요."}
              </p>
              {stage === 2 ? (
                <button className="demo-student-confirm" onClick={() => setStage(3)} type="button">
                  최신 내용 다시 확인
                </button>
              ) : null}
            </div>

            <div className="demo-results">
              <div className="demo-results-title">
                <h3>선생님에게 보이는 확인 현황</h3>
                <span>가상 예시</span>
              </div>
              <dl className="demo-counts">
                <div>
                  <dt>최신 내용 확인</dt>
                  <dd data-demo-count="confirmed">
                    {confirmed}
                    <span>명</span>
                  </dd>
                </div>
                <div>
                  <dt>재확인 필요</dt>
                  <dd data-demo-count="reconfirm">
                    {reconfirmationNeeded}
                    <span>명</span>
                  </dd>
                </div>
                <div>
                  <dt>미확인</dt>
                  <dd data-demo-count="unread">
                    1<span>명</span>
                  </dd>
                </div>
              </dl>
              <ul aria-label="가상 학생별 확인 상태" className="demo-students">
                {[1, 2, 3, 4].map((student) => {
                  const checked = student < 4 && (!revised || (completed && student === 1));
                  const label =
                    student === 4 ? "미확인" : checked ? "최신 내용 확인" : "재확인 필요";
                  return (
                    <li key={student}>
                      <span>예시 학생 {student}</span>
                      <span data-confirmed={checked ? "true" : undefined}>
                        {checked ? <Check aria-hidden="true" size={15} /> : null}
                        {label}
                      </span>
                    </li>
                  );
                })}
              </ul>
              {revised ? (
                <p className="demo-reconfirmed">
                  수정 전 확인했던 3명 중 <strong>{completed ? 1 : 0}명</strong>이 최신 내용을 다시
                  확인했어요.
                </p>
              ) : null}
              {stage >= 2 ? (
                <p className="demo-reminder">
                  <Bell aria-hidden="true" size={17} /> 예시 재알림 4명 등록 · 확인 여부와 별개
                </p>
              ) : null}
            </div>
          </section>
        </div>

        <aside aria-label="예시 체험 안내" className="demo-boundaries">
          <p>
            <strong>공지 재알림은 앱 안에서.</strong> 이 재알림은 이메일·문자·푸시로 발송되지
            않습니다.
          </p>
          <p>
            <strong>확인은 학생의 표시.</strong> 내용 이해나 실제 행동의 완료를 보증하지 않습니다.
          </p>
          <p>
            현재는 개발 중인 서비스입니다. 예시 체험은 업무 절감 효과나 정식 운영 준비가 검증됐다는
            뜻이 아닙니다.
          </p>
        </aside>
        <SiteFooter />
      </div>
    </main>
  );
}
