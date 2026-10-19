-- Up Migration

/*
 * 만료된 임시저장을 지우는 잡에 권한을 준다 — T-HUB-31 5단계.
 *
 * ⚠️ 앞 마이그레이션(1783700033000)에서 `classhub_app` 에만 권한을 줬다. 그런데 보관기간
 * 잡은 **별도 역할 `classhub_retention` 으로 접속한다**(권한을 좁게 나눠 둔 구조라, 앱이
 * 쓰는 계정으로는 잡이 돌지 않는다). 그대로 뒀으면 잡은 붙자마자 권한 오류로 죽고,
 * 임시저장은 영원히 쌓였을 것이다.
 *
 * 지우는 데 필요한 것만 준다 — 읽고(무엇이 만료됐는지 세고) 지우는 것뿐이다. 넣거나
 * 고칠 일은 없으므로 INSERT·UPDATE 는 주지 않는다.
 */
GRANT SELECT, DELETE ON layout_draft_autosaves TO classhub_retention;

-- Down Migration

REVOKE SELECT, DELETE ON layout_draft_autosaves FROM classhub_retention;
