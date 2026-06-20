## Context

side-by-side diff는 diff2html이 **파일마다 테이블 2개**로 렌더한다 — `.d2h-files-diff`(2열 그리드) 안에 왼쪽 `.d2h-file-side-diff`(old)와 오른쪽(new). 각 시각적 줄은 side마다 `<tr>` 하나이며, diff2html이 매칭되지 않는 줄을 `.d2h-emptyplaceholder` 행으로 채우기 때문에 두 side는 **행 인덱스**로 정렬을 유지한다. 코드 줄에는 `.d2h-code-side-linenumber`와 `.d2h-code-line-ctn`이 있다.

지금 진짜 캐럿은 **소스** 뷰(단일 `.source-table`)의 `viewerCursor`뿐이다 — `setSourceCursor` / `moveSourceCursor` / `caretDomPosition`이 구동하고, `renderLineWithCursor`가 깜빡이는 `.code-cursor` span을 주입해 렌더한다. **diff** 뷰에는 캐럿이 없다: 이동은 hunk 기반(`hunks = querySelectorAll('.hunk')`, `setActive`, `next`, `firstHunkForPath`)에 마우스 선택뿐이다. `setupDiffCaret`은 `#diff2html-container`를 `contenteditable=true`(선택 가능하나 입력 차단)로 만들고, 최근 추가된 코멘트 기능의 `currentCommentTarget`은 `window.getSelection()`에서 줄을 끌어낸다.

## Goals / Non-Goals

**Goals:**
- side-by-side diff에서 명시적 `(file, side, line, column)` 상태를 가진 키보드 이동 캐럿.
- 줄 끝에서 패널 간(old↔new) 이동, 시각적으로 정렬된 행에 안착.
- 선택이 없을 때 캐럿이 줄 단위 동작(코멘트 `?`/`>`, 줄 위치 소스 열기)의 앵커가 됨.
- 기존 hunk 이동과 마우스 선택 동작 보존; 새 의존성 없음.

**Non-Goals:**
- diff를 편집 가능하게 만들기(읽기 전용 유지).
- 행 가상화 / 렌더 성능(별도로 추적).
- diff2html 출력 포맷 변경이나 단일 테이블 렌더러로 전환.
- 마우스 드래그 선택 동작 변경(이미 선택 인식 코멘트에 사용됨).

## Decisions

**1. native contenteditable 캐럿이 아니라, 소스 캐럿을 본뜬 명시적 JS 캐럿 모델.**
`diffCursor = { path, side: 'old'|'new', line, column }`을 도입하고 활성 셀에 `.code-cursor` 표시를 렌더 — 소스 뷰의 검증된 방식을 재사용. 근거: 테이블 2개 구조에서는 native 브라우저 캐럿이 "줄 끝에서 패널을 건넌다"를 결정적으로 할 수 없고, 캐럿은 선택과 다르다. 명시적 모델이 완전한 제어를 주고 코멘트 앵커링에 바로 연결된다. *검토한 대안:* native 선택/캐럿에 의존 — 기각(결정적 끝-건넘 불가; 선택 ≠ 캐럿 위치).

**2. 패널 간 매핑은 줄 번호가 아니라 행 인덱스로.**
패널을 건널 때, 현재 행이 자기 side `<tbody>`에서 갖는 인덱스를 가져와 반대편 side 테이블의 같은 인덱스 행을 고르고, 그 행의 `.d2h-code-side-linenumber`와 `.d2h-code-line-ctn`을 읽는다. 근거: diff2html은 두 side를 (placeholder 포함) 같은 길이로 유지하므로 행 인덱스가 신뢰할 수 있는 정렬 키다. *대안:* 줄 번호로 매칭 — 기각(old/new 번호가 다르고 추가/삭제 줄은 상대 번호가 없음).

**3. 이동 의미는 `moveSourceCursor`를 본뜸.**
`Up`/`Down`은 줄 변경(클램프); `Left`/`Right`는 칸 변경. `new` 패널 column 0에서 `Left`는 `old`로, `old` 패널 줄 끝에서 `Right`는 `new`로 건넌다. 빈 placeholder로 건너가면 column을 0으로 클램프.

**4. keydown 라우팅은 기존 document 핸들러 재사용.**
`handleSourceCaretKey`처럼 게이트한 diff-캐럿 분기 추가: diff 뷰가 보이고 + 사이드바 트리가 포커스 아니고 + `input`/`textarea`/`select`에 포커스가 없을 때만. hunk 이동(`F7`/`[`/`]`)과 기존 `Tab`/`Shift+Tab` 사이드바↔본문 포커스는 건드리지 않음; diff에서 (이전엔 무반응이던) 화살표가 이제 캐럿을 구동.

**5. 앵커 연결은 추가형.**
`currentCommentTarget` 확장: diff 뷰에서 `diffCursor`가 설정되어 있고 텍스트 선택이 없으면 `(diffCursor.path, diffCursor.line)` 사용; 드래그용으로는 선택 기반 경로(코드 캡처 포함)를 유지. `openDiffFileAtCaret`은 `diffCursor`가 있으면 우선 사용.

**6. 시각 표시는 `.code-cursor` 재사용.**
활성 `.d2h-code-line-ctn`에 깜빡이는 캐럿 span을 주입(그 셀만 다시 렌더), 소스 뷰와 동일하게. 컨테이너의 읽기 전용 셀은 이미 `caret-color` 투명으로 렌더되므로 JS 표시만 보인다.

## Risks / Trade-offs

- **`.d2h-code-side-*` 구조에 DOM 결합** → 셀렉터를 캐럿 헬퍼로 중앙화; 코멘트 앵커링 코드가 이미 같은 구조에 결합되어 있어 새 취약점은 아님.
- **이중 캐럿(native contenteditable + JS 표시)** → 컨테이너 읽기 전용 콘텐츠에 `caret-color: transparent`를 유지해 `.code-cursor`만 보이게.
- **diff2html 출력이 바뀌면 행 인덱스 정렬이 어긋날 수 있음** → 반대편 같은 인덱스 행을 읽되 가장 가까운 유효 행으로 폴백; column 클램프.
- **`content-visibility` 가상화와의 상호작용** → 캐럿 계산은 레이아웃이 아니라 DOM/데이터를 쓰고, 대상 행 `scrollIntoView`가 렌더를 강제하므로 화면 밖 캐럿도 안전.
- **단어 단위 `<ins>`/`<del>` span을 가로지르는 column 계산** → 평평한 텍스트 노드를 가정하지 말고 (`caretDomPosition`처럼) 텍스트 노드를 순회.

## Migration Plan

순수 추가형 뷰어 변경(CSS + `diffScript()`의 임베드 JS); 데이터·파일 포맷·API 마이그레이션 없음. 롤백 = diff-캐럿 코드 되돌리기; 코멘트 앵커링은 선택 기반 타게팅(현 동작)으로 폴백.

## Open Questions

- `Tab`도 (줄 끝 `Left`/`Right`에 더해) 패널을 건너야 할까? 현 계획은 `Tab`을 사이드바↔본문으로 두고 패널 건넘은 끝에서의 `Left`/`Right`로.
- 검증: 로직은 (코멘트 기능처럼) jsdom 하네스로 헤드리스 확인 가능; 시각 캐럿 + 패널 간 느낌은 실제 `mo` 앱에서 한 번 봐야 함.
