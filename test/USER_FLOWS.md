# 핵심 유저 플로우와 회귀 테스트

kakapo의 가치는 "AI가 만든 변경을 사람이 빠르게 리뷰하고, 코멘트를 모아 에이전트에게 돌려보내는" 데
있다. 이 디렉토리의 테스트는 그 **핵심 유저 플로우**가 앞으로의 모든 배포에서 깨지지 않도록 지킨다.

## 왜 이런 방식인가 (테스트 아키텍처)

리뷰 뷰어는 서버가 만든 마크업과 번호순으로 번들되는 클라이언트 스크립트(`src/viewer/*.js`)의 **상호작용**으로 동작한다.
실제로 발견된 회귀(코멘트 저장이 화면에 안 보이는 숨은 textarea를 읽던 버그)도 이 경계에서 났다. 그래서
순수 단위 테스트로는 부족하고, **실제 배포 산출물을 그대로 DOM에 띄워** 사용자처럼 클릭·입력·저장하는
통합 테스트가 필요하다.

- **빌드 → 테스트**: `npm test`는 `pretest`로 먼저 `tsc + viewer 에셋 복사`를 돌려, npm에 올라가는
  `dist/` 산출물과 똑같은 것을 검증한다. 소스가 아니라 **배포되는 코드**를 테스트한다.
- **진짜 파이프라인**: 픽스처는 임시 git 저장소에 변경을 만들고 `buildDiffReview()`(= `kakapo`가 쓰는 그
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
- Changes 행은 증감 줄 수나 긴 상태 문구 없이 상태 아이콘만 표시한다
- Changes 행에 포커스한 뒤 `Space`를 누르면 열린 파일이 아니라 화살표로 선택한 행의 확인 표시를 토글한다
- diff toolbar 맨 오른쪽의 이전/다음 버튼과 Base/Working tree 헤더가 키보드 F7 흐름과 같은 위치를 가리키며, 별도 변경 카운터는 표시하지 않는다
- 양쪽 라인 번호는 중앙 divider에 모이고, hunk id가 양쪽 행에 전파되며 수정=파랑·삭제=회색·추가=초록 배경이 빈 placeholder까지 이어진다
- `Cmd/Ctrl+9` History를 열어도 왼쪽 activity rail은 유지된다
- History의 커밋 그래프는 전체 폭을 사용하고, `Enter`는 선택한 커밋의 파일 목록·diff를 큰 플로팅 워크스페이스로 연다
- History의 긴 커밋 본문은 기본으로 접혀 코드 공간을 보존하고, DOM 포커스·한글 입력 소스와 무관하게 물리적 `M` 키로 펼치고 접는다
- 플로팅 commit diff에서 `Esc`를 누르면 History 자체가 아니라 diff만 먼저 닫혀 커밋 선택으로 돌아간다
- macOS의 전체 화면 상단 surface(접힌 사이드바의 리뷰 툴바·History·최대화한 메모/합본 프롬프트)는 하나의 공통 safe-area 규칙을 사용해 좌상단 창 버튼을 침범하지 않는다
- 파일 트리·코드·diff·오버레이 등 패널 사이의 포커스 이동은 목적지에만 약 0.5초 focus flash를 보여주고 완전히 사라져, 이전 DOM 포커스의 푸른 테두리가 남지 않는다
- 왼쪽에만 존재하는 삭제 줄은 오른쪽에 회색 빈 행을 만들지 않는다. 오른쪽 실제 줄 번호는 연속되고 삭제 범위는 중앙 곡선으로만 연결된다
- 파일 안 `Cmd/Ctrl+F`는 입력을 짧게 debounce하고, 한 글자 대량 검색도 전체 탐색 결과는 유지하되 DOM 하이라이트만 제한한다. 연속 입력 시 취소된 이전 검색이 최종 결과를 덮어쓰지 않는다
- Find in Files가 열린 동안 입력 필드의 `Cmd/Ctrl+←/→` 같은 네이티브 편집 키는 유지되고, 처리되지 않은 키가 dim 처리된 파일·diff 전역 단축키로 전파되지 않는다
- 프로젝트 검색 프리뷰는 선택 줄 주변 문맥을 먼저 그리고, 위·아래 스크롤에 따라 문맥을 점진적으로 확장하면서 현재 보던 코드의 스크롤 앵커를 유지한다
- 모달 프로젝트 검색이 열리면 파일 안 검색도 함께 dim 처리되고, 모든 스크롤바는 거터 폭을 유지한 채 스크롤 중에만 나타났다가 유휴 상태에서 사라진다
- Linux x64와 ARM64는 각각 네이티브 Ubuntu runner에서 전체 테스트, Electron 패키징, Xvfb 실제 렌더러 기동을 통과한 동일 산출물만 GitHub Release에 첨부한다

### Flow 5 — 프로젝트 코드 분석과 변경 영향 (`analysis.test.mjs`, `impact.test.mjs`, `monaco.test.mjs`)

- 앱에 내장된 9개 언어군의 language server와 stdio JSON-RPC로 definition/references/implementation/workspace symbol을 조회하며 셸 PATH를 탐색하지 않는다
- language server가 없거나 언어가 지원되지 않으면 메인 프로세스 정규식 인덱스가 같은 요청을 처리한다
- Change Impact는 호출자/importer, 호출 대상/의존성, 구현체/상속, 테스트, 타입·API·스키마·설정을 분류한다
- 검색·인덱싱은 렌더러 밖에서 수행하고, lazy-load 뷰어는 실제로 연 파일의 소스만 요청한다
- 모든 코드 파일은 하나의 Review 렌더러에서 열리며 검색·폴딩·네비게이션·코멘트가 같은 커서 상태를 공유한다
- Review 화면의 definition/reference/implementation 요청은 현재 프로젝트 generation의 응답만 받아들인다
- 여러 semantic 결과는 현재 파일을 떠나지 않고 caret-local Semantic Peek 목록에서 비교한다

### Flow 6 — 언어 서버 진단(diagnostics) (`diagnostics.test.mjs`, `analysis.test.mjs`)

AI가 고친 파일을 소스 뷰에서 열면, 언어 서버가 밀어준(`textDocument/publishDiagnostics`) 에러·경고가
그 줄에 물결 밑줄과 거터 마커로 보이고, `F2`/`Shift+F2`로 파일 안의 문제를 오가며 검토할 수 있어야 한다.

- 메인은 서버가 push하는 진단을 URI별로 캡처하고, 최초 조회는 첫 publish를 (bounded로) 기다렸다가 0-based
  line/column 모델로 정규화한다 (`analysis.test.mjs`: fake LSP가 didOpen 후 진단을 push → `diagnosticsFor`).
- 진단에는 정규식 폴백이 없다. 언어 서버가 없는 파일은 오해를 부르는 빈 "문제 없음"이 아니라 `available:false`로
  보고한다.
- 에러(빨강)·경고(앰버)만 표시하며 info/hint는 수집하되 노출하지 않는다. 에러/경고 줄에는 심각도 색 거터 마커가
  붙고, 깨끗한 줄에는 아무 표시도 없다.
- 문제 줄에 포인터를 ~1초 올려두면 커스텀 dwell 툴팁이 메시지를 보여주고, 줄을 벗어나면 사라진다(네이티브 title이
  아니라 지연·스타일을 앱이 소유; jsdom엔 레이아웃/`caretRangeFromPoint`가 없어 줄 단위 메시지로 검증).
- 환경 의존적인 import/모듈 해석 진단(Pyright `reportMissingImports`, tsserver 2307 등)은 억제된다. kakapo는
  프로젝트 런타임 환경(venv/node_modules/인터프리터)을 소유하지 않아 설치된 패키지에도 false positive를 내기
  때문이다. 환경 없이도 신뢰 가능한 구문·타입·미정의 이름 진단만 남는다(`analysis.test.mjs`의 mapLspDiagnostics).
- `F2`/`Shift+F2`는 현재 파일 안의 문제를 앞뒤로 순회하고 양끝에서 감싼다. 파일 경계는 기존 `F7`/사이드바가 맡는다.
- caret fast-path가 문제 줄을 in-place로 다시 그려도 물결 밑줄이 유지된다(직전 회귀의 재현 지점).
- 진단이 있는 줄에서 `Opt+Enter`는 그 진단 메시지를 담은 "수정" change-request 코멘트를 즉시 만든다.
  깨끗한 줄에서는 아무것도 만들지 않는다.

### Flow 7 — 반복 리뷰의 코멘트 수명주기 (`comment-lifecycle.test.mjs`)

에이전트가 코멘트를 반영해 다음 라운드 diff를 만들고 kakapo를 다시 실행해도, 리뷰어가 "내 지적 중
무엇이 반영됐는지"를 잃지 않아야 한다.

- 코멘트는 `anchorCode`(단 줄의 스냅샷)로 새 내용에 재앵커링되고 절대 자동 삭제되지 않는다.
- 코멘트가 가리키던 줄이 이번 라운드에 사라졌고(생성 시 존재했던 앵커가 없어졌으면) '반영된 듯(후보)'으로
  표시된다. 확정이 아니라 후보이므로 리뷰어가 재열기(↺)로 되돌릴 수 있다. old-side diff 앵커처럼 애초에
  현재 내용에 없던 코멘트는 절대 이 상태로 넘어가지 않는다(첫 라운드를 놓치지 않도록 존재 여부는 생성 시 기록).
- '반영된 듯' 코멘트는 다음 병합 프롬프트에서 기본 제외되어 매 라운드가 열린 항목만 싣고, 재열기하면 다시 포함된다.
  (제외는 렌더·reconcile 양쪽에서 이뤄져 프롬프트에 안 보이는 코멘트가 reconcile로 삭제되지 않는다.)

## 실행

```bash
npm test          # pretest가 빌드 후 node --test 로 test/*.test.mjs 실행
```

CI에서는 세 곳이 같은 `npm test`를 돌린다:

- `.github/workflows/test.yml` — 모든 main push·PR (머지 전 1차 게이트, Node 22.14/24 매트릭스)
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
