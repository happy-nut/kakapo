## Why

monacori의 side-by-side diff 뷰(diff2html이 파일마다 왼쪽 "old" 테이블과 오른쪽 "new" 테이블을 렌더)에는 키보드로 움직이는 캐럿이 없다. 소스 뷰에는 화살표 이동이 되는 캐럿(`viewerCursor`)이 있지만, diff에서는 hunk 단위 점프(`F7` / `[` / `]`)나 클릭으로 텍스트를 선택하는 것만 가능하다 — 줄 단위로 커서를 움직일 수 없고, 특히 old↔new 두 패널 사이로 커서를 옮길 수 없다. 이 때문에 정밀한 키보드 리뷰가 막히고, 새로 만든 줄 단위 코멘트 기능(`?` / `>`)이 diff에서는 마우스 선택에 의존하게 된다.

## What Changes

- side-by-side diff 뷰에 `(file, side, line, column)`로 위치를 추적하는 캐럿 추가. `side`는 `old`(왼쪽) 또는 `new`(오른쪽).
- 한 패널 안: `Up`/`Down`은 줄 단위, `Left`/`Right`는 칸(column) 단위로 캐럿 이동.
- **패널 간 이동**: 줄의 좌/우 끝에서 `Left`/`Right`가 인접 패널로 건너간다(왼쪽 끝에서 new→old, 오른쪽 끝에서 old→new). 두 side-by-side 테이블에서 시각적으로 정렬되는 행에 안착.
- 활성 패널에 보이는 캐럿 표시.
- 줄 단위 동작이 캐럿을 읽음: 코멘트 앵커링(`currentCommentTarget`)과 "캐럿 위치의 소스 열기"가 마우스 선택 대신 `(side, line)`을 사용.
- 기존 hunk 이동(`F7` / `[` / `]`)과 마우스 텍스트 선택은 그대로 유지.

## Capabilities

### New Capabilities
- `diff-cursor-navigation`: side-by-side diff에서 키보드로 움직이는 캐럿 — old(왼쪽)/new(오른쪽) 패널 간 이동 포함, 그리고 그 캐럿을 줄 단위 동작(코멘트, 줄 위치 소스 열기)의 앵커로 사용.

### Modified Capabilities
<!-- 없음 — openspec/specs/에 요구사항이 바뀌는 기존 capability가 없음. -->

## Impact

- `src/cli.ts` — 임베드 diff 뷰어(`diffScript()` 브라우저 코드): 새 diff 캐럿 상태(현재 `viewerCursor`는 소스 뷰 전용), diff 뷰에 한정된 keydown 처리, 캐럿 CSS, `currentCommentTarget` / `openDiffFileAtCaret`와의 연결.
- 새 의존성 없음; CLI나 HTTP/API 표면 변경 없음. Electron 뷰어에 한정.
- 최근 추가된 리뷰 코멘트 기능과 상호작용 — 캐럿이 `?`(질문)·`>`(수정요청)의 키보드 앵커가 됨.
