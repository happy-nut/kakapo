# 핵심 유저 플로우와 회귀 테스트

monacori의 가치는 "AI가 만든 변경을 사람이 빠르게 리뷰하고, 코멘트를 모아 에이전트에게 돌려보내는" 데
있다. 이 디렉토리의 테스트는 그 **핵심 유저 플로우**가 앞으로의 모든 배포에서 깨지지 않도록 지킨다.

## 왜 이런 방식인가 (테스트 아키텍처)

리뷰 뷰어는 서버가 만든 마크업과 번호순으로 번들되는 클라이언트 스크립트(`src/viewer/*.js`)의 **상호작용**으로 동작한다.
실제로 발견된 회귀(코멘트 저장이 화면에 안 보이는 숨은 textarea를 읽던 버그)도 이 경계에서 났다. 그래서
순수 단위 테스트로는 부족하고, **실제 배포 산출물을 그대로 DOM에 띄워** 사용자처럼 클릭·입력·저장하는
통합 테스트가 필요하다.

- **빌드 → 테스트**: `npm test`는 `pretest`로 먼저 `tsc + viewer 에셋 복사`를 돌려, npm에 올라가는
  `dist/` 산출물과 똑같은 것을 검증한다. 소스가 아니라 **배포되는 코드**를 테스트한다.
- **진짜 파이프라인**: 픽스처는 임시 git 저장소에 변경을 만들고 `buildDiffReview()`(= `mo`가 쓰는 그
  함수)로 standalone HTML을 만든다. diff 파싱·소스 임베드·렌더까지 실제 경로를 탄다.
- **jsdom**: 그 HTML을 jsdom에 로드해 클라이언트 스크립트를 부팅시킨다. 뷰 가시성은 `.hidden` 클래스
  기반이라 레이아웃 엔진 없이도 정확히 재현되고, 영속화는 localStorage로 그대로 확인된다.

테스트가 **진짜 회귀를 잡는지**는 검증되었다: 저장 버그를 다시 심으면
`comments.test.mjs`의 "clicking Save persists…"가 즉시 실패한다(negative control).

## 핵심 유저 플로우 (정의)

### Flow 1 — 코멘트 작성·저장 (`comments.test.mjs`)

리뷰어가 변경 파일의 한 줄을 골라 질문(`?`)이나 변경요청(`>`)을 쓰고 저장하면, 그 코멘트가 보존되고
화면에 카드로 보여야 한다. **모든 뷰에서** 동작해야 한다.

- 소스/마크다운 뷰에서 "Comment" 버튼으로 저장 — *직전에 고친 회귀의 정확한 재현*
- 일반 소스(코드) 뷰에서 저장
- diff 뷰에서 저장
- `Cmd/Ctrl+Enter` 키보드 저장
- 빈/공백 입력은 저장하지 않고 컴포저를 닫는다
- 같은 줄의 여러 코멘트는 스레드로 쌓인다
- 자동 포커스는 화면에 보이는 컴포저에 간다(숨은 중복이 아니라)
- 질문(`q`)과 변경요청(`c`)은 종류가 구분되어 저장·표시된다

### Flow 2 — 코멘트 영속화 (`comments.test.mjs`)

저장한 코멘트는 앱을 다시 열어도 복원되어야 한다(localStorage seed로 재시작을 시뮬레이션). Electron은
설정을 contextBridge로 노출하면서 그 값을 deep-freeze하므로, **복원된 frozen 배열 위에서도** 새 코멘트가
저장되어야 한다 — `loadViewer(html, { electronSettings })`로 그 환경을 재현한다(jsdom 기본 경로는
localStorage라 이 함정을 못 건드린다).

### Flow 3 — 에이전트 프롬프트로 병합 (`comments.test.mjs`)

코멘트들은 `Cmd/Ctrl+Shift+/`(질문) · `Cmd/Ctrl+Shift+.`(변경요청)로 여는 병합 프롬프트에 모여,
파일·줄 출처와 함께 에이전트에게 돌려보낼 수 있어야 한다.

### Flow 4 — 리뷰 surface 탐색 (`views.test.mjs`)

- 변경 목록·파일 트리에 바뀐 파일이 모두 보인다
- diff ↔ 소스 뷰 전환
- 마크다운: 기본은 렌더(블록당 한 줄, sparse 줄번호), raw 토글 시 물리적 모든 줄
- CSV: 레코드별 정렬 테이블
- 한 뷰에서 단 코멘트는 다른 뷰로 옮겨가도 보인다
- 코멘트가 달린 파일에는 개수 배지가 붙는다
- diff toolbar의 이전/다음 버튼, 변경 카운터, Base/Working tree 헤더가 키보드 F7 흐름과 같은 위치를 가리킨다

### Flow 5 — 프로젝트 코드 분석과 변경 영향 (`analysis.test.mjs`, `impact.test.mjs`, `monaco.test.mjs`)

- 프로젝트에 설치된 language server와 stdio JSON-RPC로 definition/references/implementation/workspace symbol을 조회한다
- language server가 없거나 언어가 지원되지 않으면 메인 프로세스 정규식 인덱스가 같은 요청을 처리한다
- Change Impact는 호출자/importer, 호출 대상/의존성, 구현체/상속, 테스트, 타입·API·스키마·설정을 분류한다
- 검색·인덱싱은 렌더러 밖에서 수행하고, lazy-load 뷰어는 실제로 연 파일의 소스만 요청한다
- Code 모드는 Monaco를 필요할 때만 마운트하고, 코멘트를 시작하면 같은 커서의 Review 모드로 돌아온다
- Monaco의 definition/reference/implementation provider는 현재 프로젝트 generation의 응답만 받아들인다
- 여러 semantic 결과는 현재 파일을 떠나지 않고 Semantic Peek 목록과 소스 미리보기로 비교한다

## 실행

```bash
npm test          # pretest가 빌드 후 node --test 로 test/*.test.mjs 실행
```

CI에서는 세 곳이 같은 `npm test`를 돌린다:

- `.github/workflows/test.yml` — 모든 main push·PR (머지 전 1차 게이트, Node 20/22 매트릭스)
- `.github/workflows/publish.yml` — `v*` 태그 배포 직전 게이트
- `.github/workflows/auto-release.yml` — 주간 자동 배포에서 version bump 직전 게이트

즉 빨간 빌드는 머지도, 배포도 되지 않는다.

## 새 플로우 추가하기

1. `test/helpers/fixture.mjs`의 `makeReviewHtml([{ path, before, after }])`로 시나리오 파일을 만든다.
2. `test/helpers/dom.mjs`의 `loadViewer(html)`로 뷰어를 띄우고, 뷰어 어휘 헬퍼로 조작한다:
   `openSourceFile` · `openDiffFor` · `clickSourceLine` · `openComposer('q'|'c')` ·
   `writeAndSave` · `storedComments` · `visibleCardTexts` 등.
3. 사용자가 실제로 보는 것만 단언한다(localStorage·화면 카드·보이는 컴포저). 숨은 DOM 순서에 기대지
   않는다 — 그 가정이 바로 회귀의 원인이었다.
