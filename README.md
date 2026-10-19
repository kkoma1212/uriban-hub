# 우리반 허브

중·고등학교 담임 선생님을 위한 학급 안내 앱입니다. 공지·숙제·준비물·일정을 '우리반 칠판' 한곳에 올리고, 공지를 고친 뒤에도 누가 최신 내용을 다시 확인했는지 보여 줍니다.

> **개발 중인 서비스입니다.** 정식 출시 전이며, 실제 업무 절감 효과는 아직 검증하지 않았습니다.

- 소개 사이트: https://kkoma1212.github.io/uriban-hub-site/
- 가입 없이 예시 체험: https://uriban-hub.kkoma1212.workers.dev/demo
- 문의: uribanhub@naver.com

## 이 저장소에 대해

이 저장소는 **소스 코드를 보여 주기 위한 공개 사본**입니다. 실제 개발은 비공개 저장소에서 하고, 공개해도 되는 부분만 골라 옮겼습니다.

다음은 들어 있지 않습니다.

- 운영 환경 전용 도구(백업·복구·자동 시작 등)와 내부 작업 문서
- 보안 점검 기록, 지난 커밋 기록
- 빌드 결과물

그래서 `package.json`의 일부 명령(운영 도구를 부르는 것)은 이 사본만으로는 실행되지 않습니다.

## 구성

| 폴더 | 내용 |
|---|---|
| `apps/api` | 서버 API (NestJS · Fastify · Kysely) |
| `apps/web` | 교사·학생·관리자 화면 (React) |
| `apps/worker` | 알림·메일 등 뒤에서 도는 작업 |
| `apps/operator-cli`, `apps/retention-cli`, `apps/migrator` | 운영자 명령, 보관기간 정리, DB 설치 도구 |
| `packages/` | 앱들이 함께 쓰는 코드 |
| `db/` | DB 구조(MariaDB)와 권한 설정 |

Node.js 24, pnpm을 씁니다.

## 보안 문제를 발견하면

공개 이슈로 올리지 말고 uribanhub@naver.com 으로 알려 주세요.

## 라이선스

이 저장소에는 오픈소스 라이선스를 붙이지 않았습니다. 저작권은 운영자에게 있습니다. 코드를 읽어 보는 것은 자유지만, 허락 없이 복제·수정·배포하거나 다른 서비스에 쓸 수 없습니다. 쓰고 싶으면 uribanhub@naver.com 으로 문의해 주세요.

오픈소스 라이브러리의 라이선스 고지는 `THIRD_PARTY_NOTICES.md`와 `THIRD_PARTY_LICENSES/`에 있습니다.
