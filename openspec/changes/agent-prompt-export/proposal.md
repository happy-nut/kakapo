## Why

monacori의 테제는 "리뷰를 에이전트 프롬프트로 바꾸는 것"(`openspec/project.md`)인데, 지금 루프의 **마지막 1인치가 복사-붙여넣기**다. `Cmd+Shift+?`/`>` 합본 뷰에서 "Copy all"을 누르고, 앱을 바꿔, 에이전트에 붙여넣어야 한다. 드래그 시 코드까지 캡처되어 프롬프트는 이미 자기완결적이므로, 남은 건 "복사 안 하게" 하는 것이다 — 이게 monacori를 *유일하게* 만드는 지점이다.

## What Changes

- 합본 뷰(또는 단축키)에서 **전체 리뷰(질문 + 수정요청)를 마크다운 프롬프트 파일 `.monacori/review-prompt.md`로 저장**한다. 사용자는 에이전트에게 "이 리뷰를 처리해: `.monacori/review-prompt.md`"라고 가리키기만 하면 된다 — 에이전트가 그 파일을 읽는다.
- 프롬프트 파일은 짧은 지시 서문 + `### file:line` + 캡처된 코드 + 코멘트로 자기완결적.
- 기존 "Copy all"은 유지한다(브라우저/정적 빌드 폴백).
- monacori는 **에이전트 프로세스를 소유하지 않는다** — 파일만 떨군다(제1원칙: 가볍고 빠르게).

## Capabilities

### New Capabilities
- `agent-prompt-export`: 저장된 리뷰 코멘트(질문 + 수정요청)를 에이전트가 바로 읽을 수 있는 자기완결적 마크다운 프롬프트 파일로 내보낸다.

### Modified Capabilities
<!-- 없음 -->

## Impact

- `src/cli.ts` — 합본 뷰(`openMergedView`)/`buildMergedText`에 "Save prompt" 액션 + 전체-리뷰 프롬프트 빌더(`buildReviewPrompt`).
- `src/app-main.ts` + `src/preload.cts` — 파일 쓰기 IPC(`monacori:save-prompt`, 기존 `monacoriHttp` 패턴 재사용)로 `.monacori/review-prompt.md`에 기록 후 경로 반환.
- 새 의존성 없음. 비-Electron(정적 `monacori diff`)은 "Copy all"/다운로드로 폴백.
