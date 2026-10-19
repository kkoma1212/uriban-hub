import { hostname } from "node:os";

/*
 * 로그 한 줄만 보고 "어느 서비스의, 어느 환경의, 어느 배포본이 남긴 것인지" 알 수 있게
 * 모든 줄에 붙이는 공통 필드다(OPERATIONS/OBSERVABILITY_INCIDENT_RUNBOOK.md §3 최소 log 계약).
 * 장애 때 이 네 값이 없으면 로그가 있어도 어느 배포본을 되돌려야 하는지 못 짚는다.
 *
 * 값이 없을 때 필드를 빼지 않고 "unknown"을 넣는 이유: 필드가 아예 없으면 "배포가 안 넘겨준
 * 것"인지 "수집기가 흘린 것"인지 구분할 수 없다. 있는데 unknown이면 앞의 경우로 확정된다.
 *
 * ⚠️ `apps/worker/src/service-identity.ts`와 같은 내용의 쌍둥이다. 한쪽을 고치면 다른 쪽도
 * 같이 고칠 것. 세 번째 사용처가 생기면 그때 공유 패키지로 추출한다(T-HUB-06).
 */

/*
 * 거르는 것은 제어문자와 과한 길이뿐이다. 정상 배포가 주는 값에 제어문자가 들어갈 일은
 * 없으므로, 섞여 있다면 그 값을 신뢰하지 않는다(pino가 JSON으로 이스케이프하니 줄이 실제로
 * 쪼개지지는 않지만, 로그를 평문으로 훑는 도구까지 안전하다고 볼 수는 없다).
 *
 * 문자 종류를 화이트리스트로 좁히지 않는 이유: 처음엔 ASCII만 허용했다가 한글 hostname을
 * 가진 개발 머신에서 instance_id가 통째로 사라졌다(2026-08-06 실측). 한국어 환경을 쓰는
 * 제품이라 운영 쪽에서도 같은 일이 난다. 길이 상한은 로그 한 줄이 비대해지는 것을 막는다.
 */
const UNSAFE_IDENTITY_VALUE = /[\u0000-\u001f\u007f]/u;
const MAXIMUM_IDENTITY_LENGTH = 200;
const UNKNOWN_IDENTITY_VALUE = "unknown";

export interface ServiceIdentity {
  readonly environment: string;
  readonly image_digest: string;
  readonly instance_id: string;
  readonly release_id: string;
  readonly service: string;
}

function safeIdentityValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || UNSAFE_IDENTITY_VALUE.test(trimmed)) return null;
  return Array.from(trimmed).length <= MAXIMUM_IDENTITY_LENGTH ? trimmed : null;
}

export function readServiceIdentity(
  service: string,
  environment: NodeJS.ProcessEnv = process.env,
): ServiceIdentity {
  return {
    environment: safeIdentityValue(environment.NODE_ENV) ?? UNKNOWN_IDENTITY_VALUE,
    image_digest: safeIdentityValue(environment.IMAGE_DIGEST) ?? UNKNOWN_IDENTITY_VALUE,
    /*
     * 컨테이너에서는 hostname이 곧 인스턴스 식별자다(k8s면 pod 이름). 배포가 INSTANCE_ID를
     * 따로 주면 그것을 우선한다.
     */
    instance_id:
      safeIdentityValue(environment.INSTANCE_ID) ??
      safeIdentityValue(hostname()) ??
      UNKNOWN_IDENTITY_VALUE,
    release_id: safeIdentityValue(environment.RELEASE_ID) ?? UNKNOWN_IDENTITY_VALUE,
    service: safeIdentityValue(service) ?? UNKNOWN_IDENTITY_VALUE,
  };
}
